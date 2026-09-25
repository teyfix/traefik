import { TailscaleApiClient, type TailscaleDevice } from "./tailscale-api";
import { mergeTailscalePolicy, type TailscalePolicy } from "./policy";

export const AUTH_KEY_MAX_EXPIRY_SECONDS = 90 * 24 * 60 * 60;

export interface TailnetDiscovery {
  devices: TailscaleDevice[];
  routes: string[];
  splitDns: Record<string, string[]>;
  policy: TailscalePolicy;
  etag?: string;
}

export async function inspectTailnet(client: TailscaleApiClient): Promise<TailnetDiscovery> {
  const [devices, routes, splitDns, { policy, etag }] = await Promise.all([
    client.getDevices(),
    client.getRoutes(),
    client.getSplitDns(),
    client.getPolicy(),
  ]);

  return { devices, routes, splitDns, policy, etag };
}

export async function reconcileTailscalePolicy(params: {
  client: TailscaleApiClient;
  currentPolicy: TailscalePolicy;
  etag?: string;
  routerTag: string;
  routedSubnet: string;
  additionalRoutes?: string[];
  dryRun?: boolean;
}): Promise<{ applied: boolean; reason: string }> {
  const { client, currentPolicy, etag, routerTag, routedSubnet, additionalRoutes, dryRun } = params;

  const { policy: proposedPolicy, changed } = mergeTailscalePolicy(currentPolicy, {
    routerTag,
    routedSubnet,
    additionalRoutes,
  });

  if (!changed) {
    return { applied: false, reason: "Policy already contains required tag and route approvals." };
  }

  // Acceptance criterion: policy validation before write
  const validation = await client.validatePolicy(proposedPolicy);
  if (!validation.valid) {
    const errDetail = validation.errors?.join("; ") || "Unknown policy validation failure";
    throw new Error(`Tailscale policy validation failed: ${errDetail}`);
  }

  if (dryRun) {
    return { applied: true, reason: "Dry run: Proposed policy validated successfully." };
  }

  await client.setPolicy(proposedPolicy, etag);
  return { applied: true, reason: "Policy updated successfully." };
}

export function findRouterDevice(
  devices: TailscaleDevice[],
  tsHostname: string,
  routerTag?: string,
): TailscaleDevice | undefined {
  const target = tsHostname.toLowerCase();
  const normalizedTag = routerTag
    ? (routerTag.startsWith("tag:") ? routerTag : `tag:${routerTag}`)
    : undefined;

  // First pass: match hostname AND routerTag to distinguish container router from host node
  if (normalizedTag) {
    const tagged = devices.find((d) => {
      const devHostname = (d.hostname || "").toLowerCase();
      const devName = (d.name || "").toLowerCase();
      const nameMatch =
        devHostname === target ||
        devName === target ||
        devName.startsWith(`${target}.`);
      return nameMatch && (d.tags || []).includes(normalizedTag);
    });
    if (tagged) return tagged;
  }

  // Second pass: match hostname
  return devices.find((d) => {
    const devHostname = (d.hostname || "").toLowerCase();
    const devName = (d.name || "").toLowerCase();
    return (
      devHostname === target ||
      devName === target ||
      devName.startsWith(`${target}.`)
    );
  });
}

export async function ensureRouterAuthKey(params: {
  client: TailscaleApiClient;
  existingKey?: string;
  routerTag: string;
  hostname: string;
  hasLocalState?: boolean;
  forceRotate?: boolean;
  dryRun?: boolean;
}): Promise<{ authKey: string; generated: boolean; needed: boolean; expiresAt?: string; warning?: string }> {
  const { client, existingKey, routerTag, hostname, hasLocalState, forceRotate, dryRun } = params;

  // The key remains available to containerboot even when volume state exists.
  // Compose deliberately uses TS_AUTH_ONCE=false: stale state from an evicted
  // ephemeral node can still report Running, so startup must force auth.
  if (existingKey && !forceRotate) {
    return { authKey: existingKey, generated: false, needed: true };
  }

  if (dryRun) {
    const expiresAt = new Date(Date.now() + AUTH_KEY_MAX_EXPIRY_SECONDS * 1000).toISOString();
    return { authKey: "mock-authkey-dryrun-reusable-ephemeral", generated: true, needed: true, expiresAt };
  }

  const generatedKey = await client.createAuthKey({
    tag: routerTag,
    description: `Reusable ephemeral router key for ${hostname}`,
    expirySeconds: AUTH_KEY_MAX_EXPIRY_SECONDS,
  });

  const expiresAt = new Date(Date.now() + AUTH_KEY_MAX_EXPIRY_SECONDS * 1000).toISOString();
  const warning = hasLocalState
    ? "Existing Tailscale state is preserved. The replacement key will be used on the next forced-auth container start."
    : undefined;
  return { authKey: generatedKey, generated: true, needed: true, expiresAt, warning };
}

export async function reconcileSplitDns(params: {
  client: TailscaleApiClient;
  currentSplitDns: Record<string, string[]>;
  dnsZone: string;
  dnsResolverIp: string;
  forceReplace?: boolean;
  dryRun?: boolean;
}): Promise<{ applied: boolean; reason: string }> {
  const { client, currentSplitDns, dnsZone, dnsResolverIp, forceReplace, dryRun } = params;
  const cleanZone = dnsZone.replace(/^\./, "").toLowerCase();

  const existingResolvers = currentSplitDns[cleanZone] || [];
  if (existingResolvers.includes(dnsResolverIp)) {
    return { applied: false, reason: `Split DNS for ${cleanZone} already points to ${dnsResolverIp}.` };
  }

  if (existingResolvers.length > 0 && !forceReplace) {
    if (dryRun) {
      return {
        applied: false,
        reason: `Dry run: Split DNS conflict for ${cleanZone} (existing: [${existingResolvers.join(", ")}], pass --replace-split-dns to overwrite).`,
      };
    }
    throw new Error(
      `Conflict: Split DNS zone '${cleanZone}' already exists on tailnet pointing to [${existingResolvers.join(", ")}]. Pass --replace-split-dns to overwrite existing resolvers.`,
    );
  }

  const replaceNote = existingResolvers.length > 0 ? ` (replacing [${existingResolvers.join(", ")}])` : "";

  if (dryRun) {
    return { applied: true, reason: `Dry run: Would update split DNS ${cleanZone} -> [${dnsResolverIp}]${replaceNote}` };
  }

  await client.updateSplitDns(cleanZone, [dnsResolverIp]);
  return { applied: true, reason: `Updated split DNS for ${cleanZone} -> [${dnsResolverIp}]${replaceNote}` };
}

export interface SplitDnsPrerequisites {
  servicesHealthy: boolean;
  unhealthyDetails?: string;
  routerFound: boolean;
  routerTagMatched: boolean;
  routesApproved: boolean;
  unapprovedRouteDetails?: string;
  apiError?: Error;
  tsHostname: string;
  routerTag: string;
  routedSubnet: string;
}

/**
 * Validates that all prerequisites for publishing split DNS are met:
 * 1. CoreDNS and Traefik containers are healthy.
 * 2. Tailscale router device is registered and visible on Tailnet.
 * 3. Router device has the expected tag.
 * 4. Ingress route is approved in Tailscale ACL policy.
 *
 * If any check fails, throws an actionable error to stop execution and preserve existing split DNS.
 */
export function assertSplitDnsPrerequisites(params: SplitDnsPrerequisites): void {
  if (!params.servicesHealthy) {
    throw new Error(
      `Cannot publish split DNS: CoreDNS or Traefik services are not healthy (${params.unhealthyDetails || "unhealthy service state"}). ` +
        "Existing split DNS configuration was preserved.",
    );
  }

  if (!params.routerFound) {
    const errorSuffix = params.apiError ? ` (Tailscale API error: ${params.apiError.message})` : "";
    throw new Error(
      `Cannot publish split DNS: Tailscale router device '${params.tsHostname}' was not found on Tailnet after polling${errorSuffix}. ` +
        "Existing split DNS configuration was preserved.",
    );
  }

  if (!params.routerTagMatched) {
    throw new Error(
      `Cannot publish split DNS: Router device '${params.tsHostname}' is missing required tag '${params.routerTag}'. ` +
        "Existing split DNS configuration was preserved.",
    );
  }

  if (!params.routesApproved) {
    throw new Error(
      `Cannot publish split DNS: Ingress route '${params.routedSubnet}' is not approved/active in Tailscale ACL policy (${params.unapprovedRouteDetails || "pending approval"}). ` +
        "Existing split DNS configuration was preserved.",
    );
  }
}
