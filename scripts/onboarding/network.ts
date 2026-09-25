export interface CidrRange {
  cidr: string;
  ip: string;
  prefix: number;
  startInt: number;
  endInt: number;
  size: number;
}

export function ipToInt(ip: string): number {
  const parts = ip.split(".").map(Number);
  const p0 = parts[0];
  const p1 = parts[1];
  const p2 = parts[2];
  const p3 = parts[3];
  if (
    parts.length !== 4 ||
    p0 === undefined ||
    p1 === undefined ||
    p2 === undefined ||
    p3 === undefined ||
    parts.some((p) => isNaN(p) || p < 0 || p > 255)
  ) {
    throw new Error(`Invalid IPv4 address: ${ip}`);
  }
  return ((p0 << 24) | (p1 << 16) | (p2 << 8) | p3) >>> 0;
}

export function intToIp(int: number): string {
  return [
    (int >>> 24) & 255,
    (int >>> 16) & 255,
    (int >>> 8) & 255,
    int & 255,
  ].join(".");
}

export function parseCidr(cidr: string): CidrRange {
  const parts = cidr.trim().split("/");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error(`Invalid CIDR format (missing /): ${cidr}`);
  }
  const ip = parts[0].trim();
  const prefix = parseInt(parts[1].trim(), 10);
  if (isNaN(prefix) || prefix < 0 || prefix > 32) {
    throw new Error(`Invalid prefix in CIDR: ${cidr}`);
  }

  const baseInt = ipToInt(ip);
  const mask = prefix === 0 ? 0 : (~0 << (32 - prefix)) >>> 0;
  const startInt = (baseInt & mask) >>> 0;
  const size = Math.pow(2, 32 - prefix);
  const endInt = (startInt + size - 1) >>> 0;

  return {
    cidr: `${intToIp(startInt)}/${prefix}`,
    ip: intToIp(startInt),
    prefix,
    startInt,
    endInt,
    size,
  };
}

export function cidrsOverlap(cidrA: string, cidrB: string): boolean {
  try {
    const a = parseCidr(cidrA);
    const b = parseCidr(cidrB);
    return a.startInt <= b.endInt && b.startInt <= a.endInt;
  } catch {
    return false;
  }
}

export function isIpInCidr(ip: string, cidr: string): boolean {
  try {
    const ipVal = ipToInt(ip);
    const range = parseCidr(cidr);
    return ipVal >= range.startInt && ipVal <= range.endInt;
  } catch {
    return false;
  }
}

/**
 * Calculates a stable DNS resolver IPv4 address belonging to the routed subnet.
 * Acceptance criteria:
 * - Belongs to the actual routed subnet.
 * - Is not the network address (offset 0) or broadcast address.
 * - Stable for the same configuration.
 * - Respects existing configuration if valid and inside subnet.
 */
export function deriveDnsResolverIp(
  routedSubnetCidr: string,
  offset = 10,
  existingIp?: string,
): string {
  const range = parseCidr(routedSubnetCidr);
  if (range.size < 4) {
    throw new Error(`Routed subnet ${routedSubnetCidr} is too small for a DNS resolver.`);
  }

  if (existingIp && isIpInCidr(existingIp, routedSubnetCidr)) {
    const existingVal = ipToInt(existingIp);
    if (existingVal !== range.startInt && existingVal !== range.endInt) {
      return existingIp;
    }
  }

  if (offset <= 0 || offset >= range.size - 1) {
    throw new Error(
      `Offset ${offset} is outside the usable host range for subnet ${routedSubnetCidr} (size ${range.size})`,
    );
  }

  const resolverInt = (range.startInt + offset) >>> 0;
  return intToIp(resolverInt);
}

/**
 * Calculates a stable Traefik IPv4 address belonging to the routed ingress subnet.
 */
export function deriveTraefikIp(
  routedSubnetCidr: string,
  offset = 2,
  existingIp?: string,
): string {
  const range = parseCidr(routedSubnetCidr);
  if (range.size < 4) {
    throw new Error(`Routed subnet ${routedSubnetCidr} is too small for a Traefik IP.`);
  }

  if (existingIp && isIpInCidr(existingIp, routedSubnetCidr)) {
    const existingVal = ipToInt(existingIp);
    if (existingVal !== range.startInt && existingVal !== range.endInt) {
      return existingIp;
    }
  }

  if (offset <= 0 || offset >= range.size - 1) {
    throw new Error(
      `Offset ${offset} is outside the usable host range for subnet ${routedSubnetCidr} (size ${range.size})`,
    );
  }

  const traefikInt = (range.startInt + offset) >>> 0;
  return intToIp(traefikInt);
}

/**
 * Checks if a CIDR is a valid 10.* /24 subnet.
 */
export function is10Slash24(cidr: string): boolean {
  try {
    const range = parseCidr(cidr);
    if (range.prefix !== 24) return false;
    const startTen = ipToInt("10.0.0.0");
    const endTen = ipToInt("10.255.255.255");
    return range.startInt >= startTen && range.endInt <= endTen;
  } catch {
    return false;
  }
}

/**
 * Checks if an existing ingress subnet is unambiguously owned by this host.
 * Unambiguous means:
 * - It is a valid 10.* /24 subnet.
 * - No OTHER device on the Tailnet (including offline devices) claims/advertises this subnet.
 * - It does not overlap with existing non-Docker local host routes.
 */
export function checkIngressSubnetOwnership(params: {
  candidateSubnet: string;
  tailnetDevices: Array<{
    id?: string;
    name?: string;
    hostname?: string;
    advertisedRoutes?: string[];
    enabledRoutes?: string[];
  }>;
  routerHostname: string;
  localRoutes?: string[];
  ownDockerSubnets?: string[];
}): { unambiguous: boolean; reason?: string } {
  const { candidateSubnet, tailnetDevices, routerHostname, localRoutes = [], ownDockerSubnets = [] } = params;

  if (!is10Slash24(candidateSubnet)) {
    return {
      unambiguous: false,
      reason: `Subnet ${candidateSubnet} is not a valid 10.* /24 subnet.`,
    };
  }

  const targetHost = routerHostname.toLowerCase();
  for (const dev of tailnetDevices) {
    const devHost = (dev.hostname || "").toLowerCase();
    const devName = (dev.name || "").toLowerCase();
    const isCurrentRouter =
      devHost === targetHost ||
      devName === targetHost ||
      devName.startsWith(`${targetHost}.`);

    if (isCurrentRouter) continue;

    const devRoutes = [
      ...(dev.advertisedRoutes || []),
      ...(dev.enabledRoutes || []),
    ];
    for (const r of devRoutes) {
      if (cidrsOverlap(candidateSubnet, r)) {
        return {
          unambiguous: false,
          reason: `Subnet ${candidateSubnet} is claimed by another tailnet device (${dev.name || dev.hostname || dev.id || "unknown"}): ${r}`,
        };
      }
    }
  }

  const ownSet = new Set(ownDockerSubnets);
  for (const route of localRoutes) {
    if (ownSet.has(route)) continue;
    if (cidrsOverlap(candidateSubnet, route)) {
      return {
        unambiguous: false,
        reason: `Subnet ${candidateSubnet} overlaps with local host route: ${route}`,
      };
    }
  }

  return { unambiguous: true };
}

export interface IngressSubnetAllocation {
  ingressSubnet: string;
  dnsResolverIp: string;
  traefikIp: string;
}

/**
 * Allocates a unique explicit 10.* Docker ingress /24 subnet per host.
 * Preserves an existing ingress subnet only when ownership is unambiguous.
 */
export function allocateIngressSubnet(params: {
  claimedRoutes: string[];
  preferredSubnet?: string;
  unambiguousSubnet?: string;
  existingDnsIp?: string;
  existingTraefikIp?: string;
}): IngressSubnetAllocation {
  const { claimedRoutes, preferredSubnet, unambiguousSubnet, existingDnsIp, existingTraefikIp } = params;

  if (preferredSubnet && preferredSubnet !== "auto") {
    if (!is10Slash24(preferredSubnet)) {
      throw new Error(`Requested ingress subnet ${preferredSubnet} must be a valid 10.* /24 subnet.`);
    }
    const safeOwn = new Set(unambiguousSubnet ? [unambiguousSubnet] : []);
    const conflicting = claimedRoutes.filter((r) => !safeOwn.has(r) && cidrsOverlap(preferredSubnet, r));
    if (conflicting.length > 0) {
      throw new Error(`Requested ingress subnet ${preferredSubnet} conflicts with claimed route(s): ${conflicting.join(", ")}`);
    }
    const dnsResolverIp = deriveDnsResolverIp(preferredSubnet, 10, existingDnsIp);
    const traefikIp = deriveTraefikIp(preferredSubnet, 2, existingTraefikIp);
    return { ingressSubnet: preferredSubnet, dnsResolverIp, traefikIp };
  }

  if (unambiguousSubnet) {
    const dnsResolverIp = deriveDnsResolverIp(unambiguousSubnet, 10, existingDnsIp);
    const traefikIp = deriveTraefikIp(unambiguousSubnet, 2, existingTraefikIp);
    return { ingressSubnet: unambiguousSubnet, dnsResolverIp, traefikIp };
  }

  // Scan candidate 10.* /24 subnets in 10.128.0.0/16 first
  const baseStart = ipToInt("10.128.0.0");
  for (let i = 0; i < 256; i++) {
    const candIp = intToIp((baseStart + i * 256) >>> 0);
    const candCidr = `${candIp}/24`;
    const hasConflict = claimedRoutes.some((r) => cidrsOverlap(candCidr, r));
    if (!hasConflict) {
      const dnsResolverIp = deriveDnsResolverIp(candCidr, 10, existingDnsIp);
      const traefikIp = deriveTraefikIp(candCidr, 2, existingTraefikIp);
      return { ingressSubnet: candCidr, dnsResolverIp, traefikIp };
    }
  }

  // Fallback: search wider 10.0.0.0/8 space
  const fullBase = ipToInt("10.0.0.0");
  for (let s = 1; s < 65535; s++) {
    const candIp = intToIp((fullBase + s * 256) >>> 0);
    const candCidr = `${candIp}/24`;
    const hasConflict = claimedRoutes.some((r) => cidrsOverlap(candCidr, r));
    if (!hasConflict) {
      const dnsResolverIp = deriveDnsResolverIp(candCidr, 10, existingDnsIp);
      const traefikIp = deriveTraefikIp(candCidr, 2, existingTraefikIp);
      return { ingressSubnet: candCidr, dnsResolverIp, traefikIp };
    }
  }

  throw new Error("Could not find a non-overlapping 10.* /24 Docker ingress subnet.");
}

/**
 * Proposes a non-overlapping Docker host pool (/18) and a routed subnet (/24) within it.
 * Uses an RFC1918 space, by default candidate blocks in 10.128.0.0/9.
 *
 * @param allocatedOrExistingRoutes All discovered routes (local, Docker networks, Tailnet).
 * @param preferredPool Optional requested or previously configured Docker pool CIDR.
 * @param ownSubnets Subnets already allocated or owned by this Traefik/Tailscale installation,
 *                   which must not be treated as conflicting when rerunning or validating preferredPool.
 * @param localDockerSubnets Subnets belonging to local Docker networks on this daemon.
 */
export interface DockerPoolAllocation {
  hostPool: string;
  routedSubnet: string;
  proxySubnet: string;
  dnsResolver: string;
}

export function allocateDockerPool(
  allocatedOrExistingRoutes: string[],
  preferredPool?: string,
  ownSubnets: string[] = [],
  localDockerSubnets: string[] = [],
): DockerPoolAllocation {
  const ownSet = new Set(ownSubnets);
  const localDockerSet = new Set(localDockerSubnets);
  const externalRoutes = allocatedOrExistingRoutes.filter((route) => !ownSet.has(route));

  const isRouteContainedInPool = (route: string, poolRange: ReturnType<typeof parseCidr>): boolean => {
    try {
      const r = parseCidr(route);
      return r.startInt >= poolRange.startInt && r.endInt <= poolRange.endInt;
    } catch {
      return false;
    }
  };

  const hasPoolConflict = (poolRange: ReturnType<typeof parseCidr>): boolean => {
    return externalRoutes.some((route) => {
      // Local Docker network subnets contained inside the pool don't conflict with the pool itself
      if (localDockerSet.has(route) && isRouteContainedInPool(route, poolRange)) {
        return false;
      }
      return cidrsOverlap(poolRange.cidr, route);
    });
  };

  const findSubnetsInPool = (poolRange: ReturnType<typeof parseCidr>): { routedSubnet: string; proxySubnet: string } => {
    const available: string[] = [];
    for (let s = 0; s < 64; s++) {
      const cand = `${intToIp((poolRange.startInt + s * 256) >>> 0)}/24`;
      const inUse = externalRoutes.some((r) => cidrsOverlap(cand, r));
      if (!inUse) {
        available.push(cand);
        if (available.length === 2) break;
      }
    }
    const [routed, proxy] = available;
    if (!routed || !proxy) {
      throw new Error(`Docker pool ${poolRange.cidr} has insufficient free /24 subnets.`);
    }
    return { routedSubnet: routed, proxySubnet: proxy };
  };

  if (preferredPool && preferredPool !== "auto") {
    const range = parseCidr(preferredPool);
    if (hasPoolConflict(range)) {
      throw new Error(`Requested Docker pool ${preferredPool} conflicts with existing routes.`);
    }
    const { routedSubnet, proxySubnet } = findSubnetsInPool(range);
    const dnsResolver = deriveDnsResolverIp(routedSubnet, 10);
    return { hostPool: range.cidr, routedSubnet, proxySubnet, dnsResolver };
  }

  // Generate candidate /18 pools in 10.128.0.0/9
  // Managed space 10.128.0.0/9 contains 2^(18 - 9) = 512 candidate /18 host pools (each 16,384 IPs).
  const managedPrefix = 9;
  const targetPrefix = 18;
  const candidateCount = 1 << (targetPrefix - managedPrefix); // 512
  const baseStart = ipToInt("10.128.0.0");
  const step = 1 << (32 - targetPrefix); // 16384 IPs

  for (let i = 0; i < candidateCount; i++) {
    const candidateInt = (baseStart + i * step) >>> 0;
    const candidateRange = parseCidr(`${intToIp(candidateInt)}/${targetPrefix}`);

    if (!hasPoolConflict(candidateRange)) {
      try {
        const { routedSubnet, proxySubnet } = findSubnetsInPool(candidateRange);
        const dnsResolver = deriveDnsResolverIp(routedSubnet, 10);
        return { hostPool: candidateRange.cidr, routedSubnet, proxySubnet, dnsResolver };
      } catch {
        // Pool lacks sufficient free subnets, check next candidate
      }
    }
  }

  throw new Error("Could not find a non-overlapping /18 Docker pool in 10.128.0.0/9.");
}
