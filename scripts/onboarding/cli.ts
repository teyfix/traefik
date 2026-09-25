import * as p from "@clack/prompts";
import { resolve } from "node:path";
import {
  parseCliArgs,
  getHelpText,
  type RawCliOptions,
  resolveOptionValue,
  IngressSubnetSchema,
  DnsZoneSchema,
} from "./options";
import { getHostShortName, deriveDnsZoneFromHost, getLocalRoutes, ensureIpForwarding } from "./host";
import {
  isDockerInstalled,
  isDockerDaemonReachable,
  installDockerIfMissing,
  inspectDockerNetworks,
  ensureDockerNetwork,
  hasLocalTailscaleState,
} from "./docker";
import {
  allocateIngressSubnet,
  checkIngressSubnetOwnership,
  cidrsOverlap,
} from "./network";
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
import { readFile, copyFile, chmod } from "node:fs/promises";

async function removeDockerNetwork(networkName: string): Promise<void> {
  const proc = Bun.spawn(["docker", "network", "rm", networkName], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stderr).text(),
  ]);
  if (code !== 0) {
    throw new Error(
      `Failed to remove Docker network '${networkName}': ${stderr.trim() || `exit code ${code}`}`,
    );
  }
}

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

  // Identify subnets owned by this router so reruns do not treat them as external conflicts
  const ownSubnets: string[] = [];
  for (const net of dockerNetworks) {
    if (net.name === "traefik_ingress" || net.name === "tailscale_services") {
      ownSubnets.push(...net.subnets);
    }
  }
  if (existingEnv.TS_INGRESS_SUBNET) {
    ownSubnets.push(existingEnv.TS_INGRESS_SUBNET);
  }
  if (existingEnv.TS_SERVICE_SUBNET && !ownSubnets.includes(existingEnv.TS_SERVICE_SUBNET)) {
    ownSubnets.push(existingEnv.TS_SERVICE_SUBNET);
  }

  // Include advertised routes of any existing router device on tailnet matching this exact hostname
  const existingRouterDevice = findRouterDevice(tailnet.devices, resolvedTsHostname);
  if (existingRouterDevice?.advertisedRoutes) {
    for (const r of existingRouterDevice.advertisedRoutes) {
      if (!ownSubnets.includes(r)) ownSubnets.push(r);
    }
  }

  const localDockerSubnets = dockerNetworks.flatMap((n) => n.subnets);

  // Claimed routes from ALL Tailnet devices (including offline devices)
  const claimedTailnetRoutes = new Set<string>();
  for (const dev of tailnet.devices) {
    for (const r of dev.advertisedRoutes || []) claimedTailnetRoutes.add(r);
    for (const r of dev.enabledRoutes || []) claimedTailnetRoutes.add(r);
  }
  for (const r of tailnet.routes) {
    claimedTailnetRoutes.add(r);
  }

  const allClaimedRoutes = [
    ...claimedTailnetRoutes,
    ...localRoutes,
    ...localDockerSubnets,
  ];

  // Check unambiguous ownership of existing ingress subnet:
  // "preserve an existing ingress subnet only when ownership is unambiguous."
  const candidateExistingSubnet =
    existingEnv.TS_INGRESS_SUBNET ||
    existingEnv.TS_SERVICE_SUBNET ||
    dockerNetworks.find((n) => n.name === "traefik_ingress" || n.name === "tailscale_services")?.subnets[0];

  let unambiguousSubnet: string | undefined;
  if (candidateExistingSubnet) {
    const ownership = checkIngressSubnetOwnership({
      candidateSubnet: candidateExistingSubnet,
      tailnetDevices: tailnet.devices,
      routerHostname: resolvedTsHostname,
      localRoutes,
      ownDockerSubnets: localDockerSubnets,
    });
    if (ownership.unambiguous) {
      unambiguousSubnet = candidateExistingSubnet;
    }
  }

  // Phase 5: Option resolution
  // 5.1 Ingress Subnet allocation
  const recommendedAllocation = allocateIngressSubnet({
    claimedRoutes: allClaimedRoutes,
    unambiguousSubnet,
    existingDnsIp: existingEnv.TS_DNS_SERVER,
    existingTraefikIp: existingEnv.TRAEFIK_IP,
  });

  const resolvedSubnetInput = await resolveOptionValue({
    cliValue: cliOptions.ingressSubnet || cliOptions.dockerPool,
    defaultValue: recommendedAllocation.ingressSubnet,
    isYes: cliOptions.yes,
    promptFn: async (rec) => {
      const val = await p.text({
        message: "Docker ingress subnet (/24 in 10.*):",
        initialValue: rec,
        validate: (input) => {
          const parsed = IngressSubnetSchema.safeParse(input);
          if (!parsed.success) {
            return (
              parsed.error.issues[0]?.message ||
              "Please provide a valid 10.* /24 CIDR (e.g. 10.128.64.0/24) or 'auto'"
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

  const finalAllocation =
    resolvedSubnetInput === "auto"
      ? recommendedAllocation
      : allocateIngressSubnet({
          claimedRoutes: allClaimedRoutes,
          preferredSubnet: resolvedSubnetInput,
          unambiguousSubnet,
          existingDnsIp: existingEnv.TS_DNS_SERVER,
          existingTraefikIp: existingEnv.TRAEFIK_IP,
        });

  const routedSubnet = finalAllocation.ingressSubnet;
  const dnsResolverIp = finalAllocation.dnsResolverIp;
  const traefikIp = finalAllocation.traefikIp;

  // Check existing ingress networks on host
  const ingressNet = dockerNetworks.find((n) => n.name === "traefik_ingress" || n.name === "tailscale_services");
  let needsIngressRecreate = false;
  if (ingressNet && ingressNet.subnets[0] && ingressNet.subnets[0] !== routedSubnet) {
    const hasContainers = Boolean(ingressNet.containers && ingressNet.containers.length > 0);
    if (hasContainers) {
      throw new Error(
        `Existing Docker network '${ingressNet.name}' (${ingressNet.subnets[0]}) differs from routed subnet '${routedSubnet}' and has active containers. Stop running services ('docker compose down') before migrating to the new subnet.`,
      );
    }
    needsIngressRecreate = true;
  }

  // Check traefik_proxy network collision with routed ingress subnet
  const proxyNet = dockerNetworks.find((n) => n.name === "traefik_proxy");
  let needsProxyRecreate = false;
  if (proxyNet && proxyNet.subnets[0] && cidrsOverlap(routedSubnet, proxyNet.subnets[0])) {
    const hasContainers = Boolean(proxyNet.containers && proxyNet.containers.length > 0);
    if (hasContainers) {
      throw new Error(
        `Existing Docker network 'traefik_proxy' (${proxyNet.subnets[0]}) collides with routed ingress subnet '${routedSubnet}' and has active containers. Disconnect containers or reconfigure network before onboarding.`,
      );
    }
    needsProxyRecreate = true;
  }

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
  let forceReplaceDns = cliOptions.replaceSplitDns;
  const existingZoneResolvers = tailnet.splitDns[finalZone] || [];
  const hasDnsConflict =
    existingZoneResolvers.length > 0 && !existingZoneResolvers.includes(dnsResolverIp);

  if (hasDnsConflict && !forceReplaceDns) {
    if (cliOptions.dryRun) {
      // In dry-run mode, do not prompt or throw; conflict and required flag are reported in the plan
    } else if (cliOptions.yes) {
      throw new Error(
        `Conflict: Split DNS zone '${finalZone}' already exists on tailnet pointing to [${existingZoneResolvers.join(", ")}]. Pass --replace-split-dns to overwrite existing resolvers.`,
      );
    } else {
      const confirmReplace = await p.confirm({
        message: `Split DNS zone '${finalZone}' already points to [${existingZoneResolvers.join(", ")}]. Replace existing resolver with ${dnsResolverIp}?`,
        initialValue: false,
      });
      if (p.isCancel(confirmReplace) || !confirmReplace) {
        p.cancel("Onboarding cancelled due to DNS zone conflict.");
        process.exit(0);
      }
      forceReplaceDns = true;
    }
  }

  // 5.3 Router Tag
  const resolvedTag = cliOptions.tsRouterTag.startsWith("tag:")
    ? cliOptions.tsRouterTag
    : `tag:${cliOptions.tsRouterTag}`;

  // Routes to advertise: Tailscale advertises ONLY this ingress /24.
  const routesToAdvertise: string[] = [routedSubnet];

  let dnsZonePlan = finalZone;
  if (hasDnsConflict) {
    dnsZonePlan = forceReplaceDns
      ? `${finalZone} (overwriting existing resolvers: [${existingZoneResolvers.join(", ")}])`
      : `${finalZone} (CONFLICT: currently points to [${existingZoneResolvers.join(", ")}]; pass --replace-split-dns to overwrite)`;
  }

  // Display Configuration Summary
  p.note(
    [
      `Host:             ${hostShort}`,
      `Ingress subnet:    ${routedSubnet}`,
      `Advertised route:  ${routedSubnet}`,
      `DNS resolver IP:   ${dnsResolverIp}`,
      `Traefik IP:        ${traefikIp}`,
      `Private DNS zone:  ${dnsZonePlan}`,
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

  // 6.2 Docker networks: ensure traefik_proxy and traefik_ingress
  if (needsProxyRecreate && !cliOptions.dryRun) {
    actionSpinner.start("Recreating colliding 'traefik_proxy' network");
    await removeDockerNetwork("traefik_proxy");
    actionSpinner.stop("Removed colliding 'traefik_proxy' network");
  }
  if (needsIngressRecreate && !cliOptions.dryRun && ingressNet) {
    actionSpinner.start(`Recreating '${ingressNet.name}' network`);
    await removeDockerNetwork(ingressNet.name);
    actionSpinner.stop(`Removed '${ingressNet.name}' network`);
  }
  actionSpinner.start("Ensuring Docker 'traefik_proxy' network exists");
  await ensureDockerNetwork("traefik_proxy", "bridge", cliOptions.dryRun);
  actionSpinner.stop("Docker 'traefik_proxy' network verified");

  actionSpinner.start(`Ensuring Docker 'traefik_ingress' network exists (${routedSubnet})`);
  await ensureDockerNetwork("traefik_ingress", "bridge", cliOptions.dryRun, routedSubnet);
  actionSpinner.stop("Docker 'traefik_ingress' network verified");

  // 6.3 Tailscale Policy Update (only ingress /24)
  actionSpinner.start("Reconciling Tailscale ACL policy (tagOwners & autoApprovers.routes)");
  const policyRes = await reconcileTailscalePolicy({
    client: apiClient,
    currentPolicy: tailnet.policy,
    etag: tailnet.etag,
    routerTag: resolvedTag,
    routedSubnet,
    dryRun: cliOptions.dryRun,
  });
  actionSpinner.stop(policyRes.reason);

  // 6.4 Tailscale Split DNS
  actionSpinner.start(`Configuring Tailscale split DNS (${finalZone} -> ${dnsResolverIp})`);
  const splitRes = await reconcileSplitDns({
    client: apiClient,
    currentSplitDns: tailnet.splitDns,
    dnsZone: finalZone,
    dnsResolverIp,
    forceReplace: forceReplaceDns,
    dryRun: cliOptions.dryRun,
  });
  actionSpinner.stop(splitRes.reason);

  // 6.5 Tailscale Router Auth Key (single-use key if missing local state)
  actionSpinner.start(`Checking Tailscale router state and credentials for ${resolvedTag}`);
  const tailscaleImage = existingEnv.TAILSCALE_IMAGE || process.env.TAILSCALE_IMAGE;
  const localStatePresent = await hasLocalTailscaleState(tailscaleImage, cliOptions.dryRun);
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
      ? `Generated short-lived single-use auth key (${redactSecret(authKeyRes.authKey)})`
      : "Reusing persistent Tailscale volume state",
  );

  // 6.6 Update Traefik .env (transient auth key is NOT persisted)
  actionSpinner.start("Updating Traefik .env configuration");
  const traefikDomain = `traefik.${finalZone}`;
  const envUpdates: Record<string, string> = {
    TS_HOSTNAME: resolvedTsHostname,
    TS_ROUTES: routedSubnet,
    TS_INGRESS_SUBNET: routedSubnet,
    TS_DNS_SERVER: dnsResolverIp,
    TRAEFIK_IP: traefikIp,
    TAIL_DOMAIN: finalZone,
    TRAEFIK_DOMAIN: traefikDomain,
    TS_ROUTER_TAG: resolvedTag,
  };

  if (!cliOptions.dryRun) {
    if (!existsSync(envPath) && existsSync(exampleEnvPath)) {
      await copyFile(exampleEnvPath, envPath);
      await chmod(envPath, 0o600).catch(() => {});
    }
    await mergeEnvFile(envPath, envUpdates);
  }
  actionSpinner.stop("Traefik .env updated");

  // 6.7 Start Traefik Stack
  if (!cliOptions.dryRun) {
    actionSpinner.start("Starting Traefik edge services (traefik, stepca, coredns, ts-router)");
    await startTraefikStack(
      repoRoot,
      cliOptions.dryRun,
      authKeyRes.needed ? { TS_AUTHKEY: authKeyRes.authKey } : undefined,
    );
    const health = await waitForTraefikHealthy(repoRoot);
    actionSpinner.stop(
      health.healthy
        ? "Traefik stack is up and all services are healthy"
        : "Traefik services started (some services may still be initializing)",
    );

    // 6.8 Install Step CA Root Certificate
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

    const failures = verifyResults.filter((r) => !r.passed);
    if (failures.length > 0) {
      p.cancel(
        `Onboarding finished with ${failures.length} verification failure(s). Check the log messages above for details.`,
      );
      process.exit(1);
    }
  } else {
    p.log.info("Dry run complete. No mutations were applied to host or tailnet.");
  }

  p.outro("Onboarding complete!");
}
