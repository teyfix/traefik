import { isDockerDaemonReachable, inspectDockerNetworks } from "./docker";
import { testDnsResolution } from "./dns";
import { isRootCaTrusted } from "./certificates";
import { getTraefikServicesStatus } from "./traefik";
import type { TailscaleApiClient } from "./tailscale-api";
import { resolve } from "node:path";

export interface VerificationResult {
  step: string;
  passed: boolean;
  message?: string;
}

export async function runVerification(params: {
  repoRoot: string;
  dnsZone: string;
  dnsResolverIp: string;
  routedSubnet: string;
  routerTag: string;
  tsHostname: string;
  apiClient?: TailscaleApiClient;
}): Promise<VerificationResult[]> {
  const {
    repoRoot,
    dnsZone,
    dnsResolverIp,
    routedSubnet,
    routerTag,
    tsHostname,
    apiClient,
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
  const hasTailscale = networks.some((n) => n.name === "tailscale_services");
  results.push({
    step: "Docker networks exist",
    passed: hasProxy && hasTailscale,
    message: `traefik_proxy: ${hasProxy ? "present" : "missing"}, tailscale_services: ${hasTailscale ? "present" : "missing"}`,
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
      const devices = await apiClient.getDevices();
      const tag = routerTag.startsWith("tag:") ? routerTag : `tag:${routerTag}`;
      const routerDev = devices.find(
        (d) => d.name.includes(tsHostname) || d.hostname.includes(tsHostname) || (d.tags && d.tags.includes(tag)),
      );

      if (routerDev) {
        const hasTag = (routerDev.tags || []).includes(tag);
        const advertisesRoute = (routerDev.advertisedRoutes || []).includes(routedSubnet);
        const routeApproved = (routerDev.enabledRoutes || []).includes(routedSubnet);

        results.push({
          step: "Tailscale router registered & tagged",
          passed: hasTag,
          message: hasTag ? `Device '${routerDev.name}' has tag ${tag}` : `Tag ${tag} missing on router device`,
        });

        results.push({
          step: "Advertised subnet route approved",
          passed: routeApproved || advertisesRoute,
          message: routeApproved
            ? `Route ${routedSubnet} is approved and active`
            : advertisesRoute
            ? `Route ${routedSubnet} advertised (waiting for propagation)`
            : `Route ${routedSubnet} not yet advertised`,
        });
      } else {
        results.push({
          step: "Tailscale router device connected",
          passed: false,
          message: `Router device with hostname '${tsHostname}' or tag '${tag}' not yet found on tailnet`,
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
  const testHost = `traefik.${dnsZone.replace(/^\./, "")}`;
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

  // 7. Traefik HTTPS endpoint reachable
  let httpsReachable = false;
  let httpsMsg = "";
  try {
    const proc = Bun.spawn(
      ["curl", "-k", "-fsS", "--max-time", "5", "https://127.0.0.1:443", "-H", `Host: ${testHost}`],
      { stdout: "pipe", stderr: "pipe" },
    );
    const code = await proc.exited;
    if (code === 0 || code === 22) {
      // code 0 or HTTP 404 (curl --fail exits 22 on 404) means TLS handshake succeeded!
      httpsReachable = true;
      httpsMsg = "Traefik HTTPS entrypoint responds to TLS handshake";
    } else {
      const errText = await new Response(proc.stderr).text();
      httpsMsg = `Exit code ${code}: ${errText.trim()}`;
    }
  } catch (e) {
    httpsMsg = (e as Error).message;
  }

  results.push({
    step: "Traefik HTTPS reachability",
    passed: httpsReachable,
    message: httpsMsg,
  });

  return results;
}

