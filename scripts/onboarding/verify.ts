import { isDockerDaemonReachable, inspectDockerNetworks } from "./docker";
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
      passed: routeApproved,
      message: routeApproved
        ? `Route ${r} is approved and active`
        : advertisesRoute
        ? `Route ${r} advertised but pending approval in Tailscale ACL`
        : `Route ${r} not advertised by router device`,
    });
  }
  return results;
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
  tagMatched: boolean;
  routeResults: VerificationResult[];
}> {
  const {
    apiClient,
    tsHostname,
    routerTag,
    routesToCheck,
    timeoutMs = 30000,
    intervalMs = 2000,
  } = params;

  const tag = routerTag.startsWith("tag:") ? routerTag : `tag:${routerTag}`;
  const startTime = Date.now();

  let lastDevice: any;
  let lastRouteResults: VerificationResult[] = [];
  let tagMatched = false;

  while (Date.now() - startTime <= timeoutMs) {
    try {
      const devices = await apiClient.getDevices();
      const dev = findRouterDevice(devices, tsHostname);
      if (dev) {
        lastDevice = dev;
        tagMatched = (dev.tags || []).includes(tag);
        lastRouteResults = verifyDeviceRoutes(dev, routesToCheck);

        const allApproved =
          lastRouteResults.length > 0 && lastRouteResults.every((r) => r.passed);
        if (tagMatched && allApproved) {
          return {
            deviceFound: true,
            routerDev: dev,
            tagMatched: true,
            routeResults: lastRouteResults,
          };
        }
      }
    } catch {}

    if (Date.now() - startTime + intervalMs > timeoutMs) break;
    await Bun.sleep(intervalMs);
  }

  return {
    deviceFound: Boolean(lastDevice),
    routerDev: lastDevice,
    tagMatched,
    routeResults: lastRouteResults,
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
  apiClient?: TailscaleApiClient;
  pollTimeoutMs?: number;
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
    apiClient,
    pollTimeoutMs,
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
  const services = await getTraefikServicesStatus(repoRoot);
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
        timeoutMs: pollTimeoutMs ?? 30000,
      });

      if (!pollRes.deviceFound) {
        results.push({
          step: "Tailscale router device connected",
          passed: false,
          message: `Router device with hostname '${tsHostname}' not found on tailnet after polling`,
        });
      } else {
        results.push({
          step: "Tailscale router registered & tagged",
          passed: pollRes.tagMatched,
          message: pollRes.tagMatched
            ? `Device '${pollRes.routerDev?.name}' has tag ${routerTag}`
            : `Tag ${routerTag} missing on router device '${pollRes.routerDev?.name}'`,
        });

        results.push(...pollRes.routeResults);
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
  results.push({
    step: `DNS resolution (${testHost} via ${dnsResolverIp})`,
    passed: dnsRes.resolved,
    message: dnsRes.resolved
      ? `Resolved to ${dnsRes.ip}`
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

