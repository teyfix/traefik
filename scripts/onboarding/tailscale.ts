import { TailscaleApiClient, type TailscaleDevice } from "./tailscale-api";
import { mergeTailscalePolicy, type TailscalePolicy } from "./policy";

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
): TailscaleDevice | undefined {
  const target = tsHostname.toLowerCase();
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
}): Promise<{ authKey: string; generated: boolean }> {
  const { client, existingKey, routerTag, hostname, hasLocalState, forceRotate, dryRun } = params;

  const isWellFormed =
    existingKey &&
    existingKey.startsWith("tskey-auth-") &&
    !existingKey.includes("placeholder") &&
    !existingKey.includes("REPLACE_WITH");

  // Reusable auth keys expire after at most 90 days.
  // Remote device registration does not prove a stored key remains valid for state-loss recovery.
  // Only reuse the existing key if local state is already present and intact on this host.
  // When local state is missing (fresh bootstrap or volume wipe recovery) or when forced, generate a fresh key.
  if (isWellFormed && !forceRotate && hasLocalState) {
    return { authKey: existingKey, generated: false };
  }

  if (dryRun) {
    return { authKey: "mock-authkey-dryrun-reusable", generated: true };
  }

  const generatedKey = await client.createAuthKey({
    tag: routerTag,
    description: `Router key for ${hostname} (reusable for recovery)`,
  });

  return { authKey: generatedKey, generated: true };
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

