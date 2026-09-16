import * as p from "@clack/prompts";
import { resolve } from "node:path";
import {
  parseCliArgs,
  getHelpText,
  type RawCliOptions,
  resolveOptionValue,
  DockerPoolSchema,
  DnsZoneSchema,
} from "./options";
import { getHostShortName, deriveDnsZoneFromHost, getLocalRoutes, ensureIpForwarding } from "./host";
import {
  isDockerInstalled,
  isDockerDaemonReachable,
  installDockerIfMissing,
  inspectDockerNetworks,
  configureDaemonAddressPool,
  ensureDockerNetwork,
  hasLocalTailscaleState,
} from "./docker";
import { allocateDockerPool, deriveDnsResolverIp, cidrsOverlap } from "./network";
import { TailscaleApiClient } from "./tailscale-api";
import {
  inspectTailnet,
  reconcileTailscalePolicy,
  ensureRouterAuthKey,
  reconcileSplitDns,
  findRouterDevice,
  type TailnetDiscovery,
} from "./tailscale";
import { parseEnv, mergeEnvFile, redactSecret } from "./env";
import { installRootCa } from "./certificates";
import { startTraefikStack, waitForTraefikHealthy } from "./traefik";
import { runVerification } from "./verify";
import { existsSync } from "node:fs";
import { readFile, copyFile } from "node:fs/promises";

export async function runOnboardingCli(rawArgs: string[] = process.argv.slice(2)): Promise<void> {
  let cliOptions: RawCliOptions;
  try {
    cliOptions = parseCliArgs(rawArgs);
  } catch (err) {
    console.error(`Invalid arguments: ${(err as Error).message}\n`);
    console.error(getHelpText());
    process.exit(1);
  }

  if (cliOptions.help) {
    console.log(getHelpText());
    return;
  }

  const repoRoot = resolve(import.meta.dir, "../..");
  p.intro("Traefik & Tailscale Ingress Onboarding");

  // Phase 1: Host discovery
  const hostShort = await getHostShortName();
  p.log.step(`Host: ${hostShort}`);

  // Phase 2: Docker status
  const s = p.spinner();
  s.start("Checking Docker Engine status");
  const dockerInstalled = await isDockerInstalled();
  if (!dockerInstalled) {
    s.stop("Docker Engine not found. Installing official Docker Engine...");
    await installDockerIfMissing(cliOptions.dryRun);
  } else {
    const reachable = await isDockerDaemonReachable();
    if (!reachable) {
      s.stop("Docker daemon is unreachable. Please ensure Docker is running.");
      process.exit(1);
    }
    s.stop("Docker Engine is ready");
  }

  // Phase 3: Tailscale API client and discovery
  const apiToken = process.env.TS_API_TOKEN;
  if (!apiToken) {
    p.cancel(
      "Tailscale API token missing.\n\n" +
        "Please provide TS_API_TOKEN in your environment:\n" +
        '  TS_API_TOKEN="tskey-api-..." bun scripts/onboarding.ts [options]\n',
    );
    process.exit(1);
  }

  s.start("Inspecting Tailnet topology and routing");
  let apiClient: TailscaleApiClient;
  let tailnet: TailnetDiscovery;
  try {
    apiClient = new TailscaleApiClient(apiToken);
    tailnet = await inspectTailnet(apiClient);
    s.stop("Tailnet inspected: devices, routes, policy, and split-DNS discovered");
  } catch (err) {
    s.stop(`Failed to inspect Tailnet: ${(err as Error).message}`);
    process.exit(1);
  }

  // Phase 4: Route and CIDR conflict aggregation
  const [localRoutes, dockerNetworks] = await Promise.all([
    getLocalRoutes(),
    inspectDockerNetworks(),
  ]);

  // Check existing .env in repo (do not treat template .example.env as live state)
  const envPath = resolve(repoRoot, ".env");
  const exampleEnvPath = resolve(repoRoot, ".example.env");
  let existingEnv: Record<string, string> = {};
  if (existsSync(envPath)) {
    try {
      existingEnv = parseEnv(await readFile(envPath, "utf-8"));
    } catch {}
  }

  // Resolve router hostname candidate early for device identity lookup
  const defaultTsHostname = `${hostShort}-router`;
  const resolvedTsHostname = cliOptions.tsHostname || existingEnv.TS_HOSTNAME || defaultTsHostname;

  // Identify subnets owned by this installation so reruns do not treat them as external conflicts
  const ownSubnets: string[] = [];
  for (const net of dockerNetworks) {
    if (net.name === "tailscale_services" || net.name === "traefik_proxy") {
      ownSubnets.push(...net.subnets);
    }
  }
  if (existingEnv.TS_SERVICE_SUBNET) {
    ownSubnets.push(existingEnv.TS_SERVICE_SUBNET);
  }
  if (existingEnv.TS_ROUTES) {
    for (const r of existingEnv.TS_ROUTES.split(",")) {
      const trimmed = r.trim();
      if (trimmed && !ownSubnets.includes(trimmed)) {
        ownSubnets.push(trimmed);
      }
    }
  }

  // Include advertised routes of any existing router device on tailnet matching this exact hostname
  const existingRouterDevice = findRouterDevice(tailnet.devices, resolvedTsHostname);
  if (existingRouterDevice?.advertisedRoutes) {
    for (const r of existingRouterDevice.advertisedRoutes) {
      if (!ownSubnets.includes(r)) ownSubnets.push(r);
    }
  }

  const existingSubnets = [
    ...localRoutes,
    ...dockerNetworks.flatMap((n) => n.subnets),
    ...tailnet.routes,
  ];

  // Phase 5: Option resolution
  // 5.1 Docker pool
  const recommendedPool = allocateDockerPool(existingSubnets, existingEnv.DOCKER_POOL, ownSubnets);
  const resolvedPoolInput = await resolveOptionValue({
    cliValue: cliOptions.dockerPool,
    defaultValue: recommendedPool.hostPool,
    isYes: cliOptions.yes,
    promptFn: async (rec) => {
      const val = await p.text({
        message: "Docker address pool (/18):",
        initialValue: rec,
        validate: (input) => {
          const parsed = DockerPoolSchema.safeParse(input);
          if (!parsed.success) {
            return (
              parsed.error.issues[0]?.message ||
              "Please provide a valid /18 CIDR (e.g. 10.128.64.0/18) or 'auto'"
            );
          }
        },
      });
      if (p.isCancel(val)) {
        p.cancel("Onboarding cancelled.");
        process.exit(0);
      }
      return val as string;
    },
  });

  const finalPool =
    resolvedPoolInput === "auto"
      ? recommendedPool
      : allocateDockerPool(existingSubnets, resolvedPoolInput, ownSubnets);

  // Compute final routed subnet (first /24) & DNS resolver IP belonging to the routed subnet
  const routedSubnet = finalPool.routedSubnet; // e.g. 10.128.64.0/24 for tailscale_services
  const dnsResolverIp = deriveDnsResolverIp(
    routedSubnet,
    10,
    existingEnv.TS_DNS_SERVER,
  );

  // Determine proxy subnet deterministically:
  // - If traefik_proxy already exists in Docker, preserve its existing subnet.
  // - Otherwise (fresh install), use finalPool.proxySubnet (the second /24 in hostPool).
  const proxyNet = dockerNetworks.find((n) => n.name === "traefik_proxy");
  const proxySubnet = proxyNet?.subnets[0] || finalPool.proxySubnet;

  // 5.2 Private DNS Zone
  const recommendedZone = deriveDnsZoneFromHost(hostShort, "gg");
  const resolvedZone = await resolveOptionValue({
    cliValue: cliOptions.tsDnsZone,
    defaultValue: existingEnv.TAIL_DOMAIN || recommendedZone,
    isYes: cliOptions.yes,
    promptFn: async (rec) => {
      const val = await p.text({
        message: "Private split-DNS zone:",
        initialValue: rec,
        validate: (input) => {
          const parsed = DnsZoneSchema.safeParse(input);
          if (!parsed.success) {
            return parsed.error.issues[0]?.message || "Enter a valid domain suffix (e.g. dixie.gg) or 'auto'";
          }
        },
      });
      if (p.isCancel(val)) {
        p.cancel("Onboarding cancelled.");
        process.exit(0);
      }
      return val as string;
    },
  });

  const finalZone = (resolvedZone === "auto" ? recommendedZone : resolvedZone).toLowerCase();

  // 5.3 Router Tag
  const resolvedTag = cliOptions.tsRouterTag.startsWith("tag:")
    ? cliOptions.tsRouterTag
    : `tag:${cliOptions.tsRouterTag}`;

  // Routes to advertise (both TS_SERVICE_SUBNET and traefik_proxy)
  const routesToAdvertise: string[] = [routedSubnet];
  if (
    proxySubnet &&
    proxySubnet !== routedSubnet &&
    !cidrsOverlap(routedSubnet, proxySubnet)
  ) {
    routesToAdvertise.push(proxySubnet);
  }

  // Display Configuration Summary
  p.note(
    [
      `Host:             ${hostShort}`,
      `Docker pool:       ${finalPool.hostPool}`,
      `Service subnet:    ${routedSubnet}`,
      `Proxy subnet:      ${proxySubnet}`,
      `Advertised routes: ${routesToAdvertise.join(", ")}`,
      `DNS resolver IP:   ${dnsResolverIp}`,
      `Private DNS zone:  ${finalZone}`,
      `Router tag:        ${resolvedTag}`,
      `Router hostname:   ${resolvedTsHostname}`,
      cliOptions.dryRun ? "\nMode: DRY RUN (no mutations will be applied)" : "",
    ].join("\n"),
    "Proposed Configuration",
  );

  p.log.warn(
    "Some OAuth providers may not accept private/split-DNS domains or may additionally " +
      "require domain ownership, public DNS, HTTPS, or application/domain verification.",
  );

  // Confirmation if not --yes and not --dry-run
  if (!cliOptions.yes && !cliOptions.dryRun) {
    const confirmed = await p.confirm({
      message: "Ready to apply infrastructure mutations and start Traefik?",
      initialValue: true,
    });
    if (p.isCancel(confirmed) || !confirmed) {
      p.cancel("Onboarding aborted. No changes applied.");
      return;
    }
  }

  // Phase 6: Apply Mutations
  const actionSpinner = p.spinner();

  // 6.1 Sysctl forwarding
  actionSpinner.start("Configuring Linux IPv4 forwarding sysctls");
  await ensureIpForwarding(cliOptions.dryRun);
  actionSpinner.stop("IPv4 packet forwarding verified");

  // 6.2 Docker daemon.json
  actionSpinner.start(`Configuring Docker daemon address pool (${finalPool.hostPool})`);
  const { changed: daemonChanged } = await configureDaemonAddressPool(
    finalPool.hostPool,
    cliOptions.dryRun,
  );
  actionSpinner.stop(
    daemonChanged
      ? `Updated /etc/docker/daemon.json with default address pool ${finalPool.hostPool}`
      : "Docker daemon address pool already up-to-date",
  );

  // 6.3 Docker external proxy network (explicit deterministic subnet)
  actionSpinner.start(`Ensuring Docker 'traefik_proxy' network exists (${proxySubnet})`);
  await ensureDockerNetwork("traefik_proxy", "bridge", cliOptions.dryRun, proxySubnet);
  actionSpinner.stop("Docker 'traefik_proxy' network verified");

  // 6.4 Tailscale Policy Update
  actionSpinner.start("Reconciling Tailscale ACL policy (tagOwners & autoApprovers.routes)");
  const policyRes = await reconcileTailscalePolicy({
    client: apiClient,
    currentPolicy: tailnet.policy,
    etag: tailnet.etag,
    routerTag: resolvedTag,
    routedSubnet,
    additionalRoutes: routesToAdvertise.filter((r) => r !== routedSubnet),
    dryRun: cliOptions.dryRun,
  });
  actionSpinner.stop(policyRes.reason);

  // 6.5 Tailscale Split DNS
  actionSpinner.start(`Configuring Tailscale split DNS (${finalZone} -> ${dnsResolverIp})`);
  const splitRes = await reconcileSplitDns({
    client: apiClient,
    currentSplitDns: tailnet.splitDns,
    dnsZone: finalZone,
    dnsResolverIp,
    dryRun: cliOptions.dryRun,
  });
  actionSpinner.stop(splitRes.reason);

  // 6.6 Tailscale Router Reusable Auth Key (based on local state availability)
  actionSpinner.start(`Ensuring reusable auth key for ${resolvedTag}`);
  const localStatePresent = await hasLocalTailscaleState();
  const authKeyRes = await ensureRouterAuthKey({
    client: apiClient,
    existingKey: existingEnv.TS_AUTHKEY,
    routerTag: resolvedTag,
    hostname: resolvedTsHostname,
    hasLocalState: localStatePresent,
    forceRotate: cliOptions.rotateAuthKey,
    dryRun: cliOptions.dryRun,
  });
  actionSpinner.stop(
    authKeyRes.generated
      ? `Generated reusable auth key (${redactSecret(authKeyRes.authKey)})`
      : `Reusing existing auth key (${redactSecret(authKeyRes.authKey)})`,
  );

  // 6.7 Update Traefik .env
  actionSpinner.start("Updating Traefik .env configuration");
  const finalRoutesStr = routesToAdvertise.join(",");
  const traefikDomain = `traefik.${finalZone}`;
  const envUpdates: Record<string, string> = {
    TS_HOSTNAME: resolvedTsHostname,
    TS_ROUTES: finalRoutesStr,
    TS_SERVICE_SUBNET: routedSubnet,
    TS_DNS_SERVER: dnsResolverIp,
    TAIL_DOMAIN: finalZone,
    DIRECT_DOMAIN: `dkr.${finalZone}`,
    TRAEFIK_DOMAIN: traefikDomain,
    DOCKER_POOL: finalPool.hostPool,
    TS_ROUTER_TAG: resolvedTag,
    TS_AUTHKEY: authKeyRes.authKey,
  };

  if (!cliOptions.dryRun) {
    if (!existsSync(envPath) && existsSync(exampleEnvPath)) {
      await copyFile(exampleEnvPath, envPath);
    }
    await mergeEnvFile(envPath, envUpdates);

    // Also update env/.env.tailscale.local if it exists or seed from example
    const tailscaleEnvPath = resolve(repoRoot, "env/.env.tailscale.local");
    const tailscaleExamplePath = resolve(repoRoot, "env/.env.tailscale.example");
    if (!existsSync(tailscaleEnvPath) && existsSync(tailscaleExamplePath)) {
      await copyFile(tailscaleExamplePath, tailscaleEnvPath);
    }
    if (existsSync(tailscaleEnvPath)) {
      await mergeEnvFile(tailscaleEnvPath, { TS_AUTHKEY: authKeyRes.authKey });
    }
  }
  actionSpinner.stop("Traefik .env updated");

  // 6.8 Start Traefik Stack
  if (!cliOptions.dryRun) {
    actionSpinner.start("Starting Traefik edge services (traefik, stepca, coredns, ts-router)");
    await startTraefikStack(repoRoot, cliOptions.dryRun);
    const health = await waitForTraefikHealthy(repoRoot);
    actionSpinner.stop(
      health.healthy
        ? "Traefik stack is up and all services are healthy"
        : "Traefik services started (some services may still be initializing)",
    );

    // 6.9 Install Step CA Root Certificate
    actionSpinner.start("Checking & installing Step CA root certificate");
    const caRes = await installRootCa(repoRoot, cliOptions.dryRun);
    actionSpinner.stop(caRes.reason);
  }

  // Phase 7: Verification
  if (!cliOptions.dryRun) {
    p.log.step("Running end-to-end verification checks...");
    const verifyResults = await runVerification({
      repoRoot,
      dnsZone: finalZone,
      dnsResolverIp,
      routedSubnet,
      routerTag: resolvedTag,
      tsHostname: resolvedTsHostname,
      routes: routesToAdvertise,
      traefikDomain,
      apiClient,
    });

    for (const r of verifyResults) {
      if (r.passed) {
        p.log.success(`✓ ${r.step}: ${r.message || "OK"}`);
      } else {
        p.log.error(`✗ ${r.step}: ${r.message || "Failed"}`);
      }
    }
  } else {
    p.log.info("Dry run complete. No mutations were applied to host or tailnet.");
  }

  p.outro("Onboarding complete!");
}
