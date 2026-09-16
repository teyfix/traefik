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
 * Proposes a non-overlapping Docker host pool (/18) and a routed subnet (/24) within it.
 * Uses an RFC1918 space, by default candidate blocks in 10.128.0.0/9.
 *
 * @param allocatedOrExistingRoutes All discovered routes (local, Docker networks, Tailnet).
 * @param preferredPool Optional requested or previously configured Docker pool CIDR.
 * @param ownSubnets Subnets already allocated or owned by this Traefik/Tailscale installation,
 *                   which must not be treated as conflicting when rerunning or validating preferredPool.
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
): DockerPoolAllocation {
  const ownSet = new Set(ownSubnets);
  const externalRoutes = allocatedOrExistingRoutes.filter((route) => !ownSet.has(route));

  if (preferredPool && preferredPool !== "auto") {
    const range = parseCidr(preferredPool);
    const hasConflict = externalRoutes.some((route) =>
      cidrsOverlap(preferredPool, route),
    );
    if (hasConflict) {
      throw new Error(`Requested Docker pool ${preferredPool} conflicts with existing routes.`);
    }
    // Subnet 0 is first /24 within the pool (tailscale_services)
    const routedSubnet = `${intToIp(range.startInt)}/24`;
    // Subnet 1 is second /24 within the pool (traefik_proxy)
    const proxySubnet = `${intToIp(range.startInt + 256)}/24`;
    const dnsResolver = deriveDnsResolverIp(routedSubnet, 10);
    return { hostPool: range.cidr, routedSubnet, proxySubnet, dnsResolver };
  }

  // Generate candidate /18 pools in 10.128.0.0/9 (each /18 has 16384 IPs = step of 64 in 3rd octet if 2nd octet fixed, or 256 /24s)
  // 10.128.0.0, 10.128.64.0, 10.128.128.0, 10.128.192.0, 10.129.0.0, ...
  const baseStart = ipToInt("10.128.0.0");
  const step = 64 * 256; // 16384 IPs
  const maxPools = 32;

  for (let i = 0; i < maxPools; i++) {
    const candidateInt = (baseStart + i * step) >>> 0;
    const candidateCidr = `${intToIp(candidateInt)}/18`;

    const conflict = externalRoutes.some((existing) =>
      cidrsOverlap(candidateCidr, existing),
    );
    if (!conflict) {
      const routedSubnet = `${intToIp(candidateInt)}/24`;
      const proxySubnet = `${intToIp(candidateInt + 256)}/24`;
      const dnsResolver = deriveDnsResolverIp(routedSubnet, 10);
      return { hostPool: candidateCidr, routedSubnet, proxySubnet, dnsResolver };
    }
  }

  throw new Error("Could not find a non-overlapping /18 Docker pool in 10.128.0.0/9.");
}
