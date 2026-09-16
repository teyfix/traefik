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

export async function ensureRouterAuthKey(params: {
  client: TailscaleApiClient;
  existingKey?: string;
  routerTag: string;
  hostname: string;
  isRegistered?: boolean;
  forceRotate?: boolean;
  dryRun?: boolean;
}): Promise<{ authKey: string; generated: boolean }> {
  const { client, existingKey, routerTag, hostname, isRegistered, forceRotate, dryRun } = params;

  const isWellFormed =
    existingKey &&
    existingKey.startsWith("tskey-auth-") &&
    !existingKey.includes("placeholder") &&
    !existingKey.includes("REPLACE_WITH");

  // A stored auth key cannot be assumed valid indefinitely:
  // - If rotation is forced, generate a fresh key.
  // - If the router device is not yet registered on the tailnet (isRegistered === false),
  //   a stored key may have expired or been revoked; generate a fresh reusable key.
  if (isWellFormed && !forceRotate && isRegistered !== false) {
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
  dryRun?: boolean;
}): Promise<{ applied: boolean; reason: string }> {
  const { client, currentSplitDns, dnsZone, dnsResolverIp, dryRun } = params;
  const cleanZone = dnsZone.replace(/^\./, "").toLowerCase();

  const existingResolvers = currentSplitDns[cleanZone] || [];
  if (existingResolvers.includes(dnsResolverIp)) {
    return { applied: false, reason: `Split DNS for ${cleanZone} already points to ${dnsResolverIp}.` };
  }

  if (dryRun) {
    return { applied: true, reason: `Dry run: Would update split DNS ${cleanZone} -> [${dnsResolverIp}]` };
  }

  await client.updateSplitDns(cleanZone, [dnsResolverIp]);
  return { applied: true, reason: `Updated split DNS for ${cleanZone} -> [${dnsResolverIp}]` };
}

