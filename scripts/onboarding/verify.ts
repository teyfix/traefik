import {
  isDockerDaemonReachable,
  inspectDockerNetworks,
  type DockerNetworkInfo,
} from "./docker";
import { isIpInCidr } from "./network";
import { testDnsResolution } from "./dns";
import { isRootCaTrusted } from "./certificates";
import { getTraefikServicesStatus } from "./traefik";
import type { TailscaleApiClient } from "./tailscale-api";
import { findRouterDevice } from "./tailscale";
import { resolve } from "node:path";

export interface VerificationResult {
  step: string;
  passed: boolean;
  message?: string;
}

export const DEFAULT_ROUTE_READINESS_TIMEOUT_MS = 120_000;

export interface LocalIngressRouteReadiness {
  ready: boolean;
  details: string;
}

async function runIpJson(command: string[]): Promise<string> {
  const proc = Bun.spawn(command, { stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  if (code !== 0) {
    throw new Error(`${command.join(" ")} failed (exit code ${code}): ${stderr.trim()}`);
  }
  return stdout;
}

function parseRouteJson(output: string, context: string): any[] {
  try {
    const parsed = JSON.parse(output);
    if (!Array.isArray(parsed)) throw new Error("result is not an array");
    return parsed;
  } catch (error) {
    throw new Error(`Could not parse ${context}: ${(error as Error).message}`);
  }
}

/** Proves local DNS/Traefik destinations use the exact owned ingress bridge. */
export async function inspectLocalIngressRouteReadiness(params: {
  routedSubnet: string;
  dnsResolverIp: string;
  traefikIp: string;
  networks?: DockerNetworkInfo[];
  runCommand?: (command: string[]) => Promise<string>;
}): Promise<LocalIngressRouteReadiness> {
  const networks = params.networks || await inspectDockerNetworks();
  const ingress = networks.find((network) => network.name === "traefik_ingress");
  const expectedLabels =
    ingress?.labels?.["com.docker.compose.project"] === "traefik" &&
    ingress?.labels?.["com.docker.compose.network"] === "ingress";
  const validNetworkId = Boolean(ingress && /^[0-9a-f]{12,}$/i.test(ingress.id));
  const bridgeName = ingress?.bridgeName ||
    (ingress?.driver === "bridge" && validNetworkId
      ? `br-${ingress.id.slice(0, 12)}`
      : undefined);

  if (
    !ingress || !validNetworkId || ingress.driver !== "bridge" || !expectedLabels ||
    ingress.subnets.length !== 1 || ingress.subnets[0] !== params.routedSubnet || !bridgeName
  ) {
    return {
      ready: false,
      details:
        `Docker network 'traefik_ingress' must be the inspected Compose-owned bridge for exact subnet ${params.routedSubnet}; ` +
        "verify its ID, driver, subnet, and com.docker.compose project/network labels",
    };
  }

  const execute = params.runCommand || runIpJson;
  try {
    const connectedRoutes = parseRouteJson(
      await execute(["ip", "-j", "route", "show", "table", "main", "exact", params.routedSubnet]),
      `main-table route for ${params.routedSubnet}`,
    );
    const exactConnected = connectedRoutes.some((route) =>
      route.dst === params.routedSubnet && route.dev === bridgeName &&
      route.protocol === "kernel" && route.scope === "link",
    );
    if (!exactConnected) {
      return {
        ready: false,
        details: `Main table lacks the exact connected ${params.routedSubnet} route on inspected bridge ${bridgeName}`,
      };
    }

    for (const destination of [params.dnsResolverIp, params.traefikIp]) {
      const effectiveRoutes = parseRouteJson(
        await execute(["ip", "-j", "route", "get", destination]),
        `effective route to ${destination}`,
      );
      const selected = effectiveRoutes[0];
      const source = selected?.prefsrc || selected?.src;
      if (selected?.dev !== bridgeName || !source || !isIpInCidr(source, params.routedSubnet)) {
        return {
          ready: false,
          details:
            `Effective route to ${destination} must select inspected bridge ${bridgeName} with a source inside ${params.routedSubnet}; ` +
            `got dev=${selected?.dev || "missing"}, source=${source || "missing"}`,
        };
      }
    }
  } catch (error) {
    return { ready: false, details: (error as Error).message };
  }

  return {
    ready: true,
    details: `Main-table and effective routes select inspected bridge ${bridgeName} for both ingress endpoints`,
  };
}

export function verifyDeviceRoutes(
  routerDev: { advertisedRoutes?: string[]; enabledRoutes?: string[] },
  routesToCheck: string[],
): VerificationResult[] {
  const results: VerificationResult[] = [];
  for (const r of routesToCheck) {
    const advertisesRoute = (routerDev.advertisedRoutes || []).includes(r);
    const routeApproved = (routerDev.enabledRoutes || []).includes(r);

    results.push({
      step: `Advertised subnet route approved (${r})`,
      passed: advertisesRoute && routeApproved,
      message: advertisesRoute && routeApproved
        ? `Route ${r} is approved and active`
        : routeApproved
        ? `Route ${r} is approved but no longer advertised by router device`
        : advertisesRoute
        ? `Route ${r} advertised but pending approval in Tailscale ACL`
        : `Route ${r} not advertised by router device`,
    });
  }
  return results;
}

export function unexpectedRouterRoutes(
  routerDev: { advertisedRoutes?: string[]; enabledRoutes?: string[] },
  expectedRoutes: string[],
): string[] {
  const expected = new Set(expectedRoutes);
  return [...new Set([
    ...(routerDev.advertisedRoutes || []),
    ...(routerDev.enabledRoutes || []),
  ])].filter((route) => !expected.has(route));
}

/**
 * Polls Tailscale API for router device presence and approved subnet routes with bounded timeout.
 */
export async function pollRouterDeviceAndRoutes(params: {
  apiClient: TailscaleApiClient;
  tsHostname: string;
  routerTag: string;
  routesToCheck: string[];
  timeoutMs?: number;
  intervalMs?: number;
}): Promise<{
  deviceFound: boolean;
  routerDev?: any;
  routerIsEphemeral?: boolean;
  tagMatched: boolean;
  routeResults: VerificationResult[];
  unexpectedRoutes: string[];
  lastApiError?: Error;
}> {
  const {
    apiClient,
    tsHostname,
    routerTag,
    routesToCheck,
    timeoutMs = DEFAULT_ROUTE_READINESS_TIMEOUT_MS,
    intervalMs = 2000,
  } = params;

  const tag = routerTag.startsWith("tag:") ? routerTag : `tag:${routerTag}`;
  const startTime = Date.now();

  let lastDevice: any;
  let lastRouteResults: VerificationResult[] = [];
  let lastUnexpectedRoutes: string[] = [];
  let tagMatched = false;
  let routerIsEphemeral: boolean | undefined;
  let lastApiError: Error | undefined;

  while (Date.now() - startTime <= timeoutMs) {
    try {
      const devices = await apiClient.getDevices();
      lastApiError = undefined;
      const dev = findRouterDevice(devices, tsHostname, routerTag);
      if (dev) {
        lastDevice = dev;
        routerIsEphemeral = dev.isEphemeral;
        tagMatched = (dev.tags || []).includes(tag);
        lastRouteResults = verifyDeviceRoutes(dev, routesToCheck);
        lastUnexpectedRoutes = unexpectedRouterRoutes(dev, routesToCheck);

        const allApproved =
          lastRouteResults.length > 0 && lastRouteResults.every((r) => r.passed);
        if (
          routerIsEphemeral === true &&
          tagMatched &&
          allApproved &&
          lastUnexpectedRoutes.length === 0
        ) {
          return {
            deviceFound: true,
            routerDev: dev,
            routerIsEphemeral: true,
            tagMatched: true,
            routeResults: lastRouteResults,
            unexpectedRoutes: [],
          };
        }
      }
    } catch (err) {
      lastApiError = err as Error;
    }

    if (Date.now() - startTime + intervalMs > timeoutMs) break;
    await Bun.sleep(intervalMs);
  }

  return {
    deviceFound: Boolean(lastDevice),
    routerDev: lastDevice,
    routerIsEphemeral,
    tagMatched,
    routeResults: lastRouteResults,
    unexpectedRoutes: lastUnexpectedRoutes,
    lastApiError,
  };
}

export async function runVerification(params: {
  repoRoot: string;
  dnsZone: string;
  dnsResolverIp: string;
  routedSubnet: string;
  routerTag: string;
  tsHostname: string;
  routes?: string[] | string;
  traefikDomain?: string;
  expectedTraefikIp?: string;
  apiClient?: TailscaleApiClient;
  pollTimeoutMs?: number;
  composeEnv?: Record<string, string>;
}): Promise<VerificationResult[]> {
  const {
    repoRoot,
    dnsZone,
    dnsResolverIp,
    routedSubnet,
    routerTag,
    tsHostname,
    routes,
    traefikDomain,
    expectedTraefikIp,
    apiClient,
    pollTimeoutMs,
    composeEnv,
  } = params;

  const results: VerificationResult[] = [];

  // 1. Docker daemon reachable
  const dockerReachable = await isDockerDaemonReachable();
  results.push({
    step: "Docker daemon reachable",
    passed: dockerReachable,
    message: dockerReachable ? "Docker Engine is responsive" : "Docker daemon is not reachable",
  });

  // 2. Required Docker networks exist
  const networks = await inspectDockerNetworks();
  const hasProxy = networks.some((n) => n.name === "traefik_proxy");
  const hasIngress = networks.some((n) => n.name === "traefik_ingress" || n.name === "tailscale_services");
  results.push({
    step: "Docker networks exist",
    passed: hasProxy && hasIngress,
    message: `traefik_proxy: ${hasProxy ? "present" : "missing"}, ingress network: ${hasIngress ? "present" : "missing"}`,
  });

  // 3. Traefik stack containers running
  const services = await getTraefikServicesStatus(repoRoot, composeEnv);
  const tsRouter = services.find((s) => s.name === "tailscale");
  const traefikSvc = services.find((s) => s.name === "traefik");
  const corednsSvc = services.find((s) => s.name === "coredns");
  const stepcaSvc = services.find((s) => s.name === "stepca");

  const stackRunning =
    Boolean(tsRouter?.running) &&
    Boolean(traefikSvc?.running) &&
    Boolean(corednsSvc?.running) &&
    Boolean(stepcaSvc?.running);

  results.push({
    step: "Traefik stack containers running",
    passed: stackRunning,
    message: `ts-router: ${tsRouter?.state || "not found"}, traefik: ${traefikSvc?.state || "not found"}, coredns: ${corednsSvc?.state || "not found"}, stepca: ${stepcaSvc?.state || "not found"}`,
  });

  // 4. Tailnet status (if API client provided)
  if (apiClient) {
    try {
      const routesToCheck = Array.isArray(routes)
        ? routes
        : (routes || routedSubnet || "").split(",").map((s) => s.trim()).filter(Boolean);

      const pollRes = await pollRouterDeviceAndRoutes({
        apiClient,
        tsHostname,
        routerTag,
        routesToCheck,
        timeoutMs: pollTimeoutMs ?? DEFAULT_ROUTE_READINESS_TIMEOUT_MS,
      });

      if (!pollRes.deviceFound) {
        const errorDetail = pollRes.lastApiError
          ? ` (Tailscale API error: ${pollRes.lastApiError.message})`
          : "";
        results.push({
          step: "Tailscale router device connected",
          passed: false,
          message: `Router device with hostname '${tsHostname}' not found on tailnet after polling${errorDetail}`,
        });
      } else {
        results.push({
          step: "Tailscale router registered & tagged",
          passed: pollRes.tagMatched,
          message: pollRes.tagMatched
            ? `Device '${pollRes.routerDev?.name}' has tag ${routerTag}`
            : `Tag ${routerTag} missing on router device '${pollRes.routerDev?.name}'`,
        });

        results.push({
          step: "Tailscale router is ephemeral",
          passed: pollRes.routerIsEphemeral === true,
          message: pollRes.routerIsEphemeral === true
            ? `Device '${pollRes.routerDev?.name}' is ephemeral`
            : pollRes.routerIsEphemeral === false
            ? `Device '${pollRes.routerDev?.name}' is non-ephemeral; follow the documented router identity migration before publishing split DNS`
            : `Tailscale API did not report isEphemeral for device '${pollRes.routerDev?.name}'`,
        });

        results.push(...pollRes.routeResults);
        results.push({
          step: "Tailscale router has ingress-only route set",
          passed: pollRes.unexpectedRoutes.length === 0,
          message: pollRes.unexpectedRoutes.length === 0
            ? `Router advertises/enables only ${routesToCheck.join(", ")}`
            : `Unexpected router routes: ${pollRes.unexpectedRoutes.join(", ")}`,
        });
      }

      // Split DNS rule check
      const splitDns = await apiClient.getSplitDns();
      const cleanZone = dnsZone.replace(/^\./, "").toLowerCase();
      const resolvers = splitDns[cleanZone] || [];
      const hasSplitRule = resolvers.includes(dnsResolverIp);

      results.push({
        step: "Tailscale split DNS rule",
        passed: hasSplitRule,
        message: hasSplitRule
          ? `${cleanZone} -> [${resolvers.join(", ")}]`
          : `Split DNS rule for ${cleanZone} pointing to ${dnsResolverIp} not found`,
      });
    } catch (err) {
      results.push({
        step: "Tailscale API verification",
        passed: false,
        message: `Failed to query Tailscale API: ${(err as Error).message}`,
      });
    }
  }

  // 5. DNS resolution via CoreDNS
  const testHost = traefikDomain || `traefik.${dnsZone.replace(/^\./, "")}`;
  const dnsRes = await testDnsResolution(dnsResolverIp, testHost);
  const ipMatches = expectedTraefikIp ? dnsRes.ip === expectedTraefikIp : dnsRes.resolved;
  results.push({
    step: `DNS resolution (${testHost} via ${dnsResolverIp})`,
    passed: dnsRes.resolved && ipMatches,
    message: dnsRes.resolved
      ? expectedTraefikIp && dnsRes.ip !== expectedTraefikIp
        ? `Resolved to ${dnsRes.ip}, expected static Traefik IP ${expectedTraefikIp}`
        : `Resolved to ${dnsRes.ip}`
      : `Resolution failed: ${dnsRes.error || "No answer"}`,
  });

  // 6. Root CA certificate trusted
  const rootCaPath = resolve(repoRoot, "certs/root_ca.crt");
  const certTrusted = await isRootCaTrusted(rootCaPath);
  results.push({
    step: "Root CA trusted by host",
    passed: certTrusted,
    message: certTrusted
      ? "Step CA root certificate is installed in host trust store"
      : "Step CA root certificate is not yet trusted in host trust store",
  });

  // 7. Traefik HTTPS endpoint reachable & certificate validated
  let httpsReachable = false;
  let httpsMsg = "";
  try {
    const proc = Bun.spawn(
      [
        "curl",
        "-fsS",
        "--max-time",
        "5",
        "--resolve",
        `${testHost}:443:127.0.0.1`,
        `https://${testHost}:443`,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const code = await proc.exited;
    if (code === 0 || code === 22) {
      httpsReachable = true;
      httpsMsg = `Traefik HTTPS responds with trusted certificate for ${testHost}`;
    } else {
      const errText = await new Response(proc.stderr).text();
      httpsMsg = `Exit code ${code}: ${errText.trim()}`;
    }
  } catch (e) {
    httpsMsg = (e as Error).message;
  }

  results.push({
    step: "Traefik HTTPS certificate & reachability",
    passed: httpsReachable,
    message: httpsMsg,
  });

  return results;
}
