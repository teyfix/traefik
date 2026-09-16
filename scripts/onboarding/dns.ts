export interface DnsZoneConfig {
  tailDomain: string; // e.g. "dixie.gg"
  directDomain: string; // e.g. "dkr.dixie.gg"
  dnsResolverIp: string; // e.g. "10.128.64.10"
  traefikDomain: string; // e.g. "traefik.dixie.gg"
}

export function computeDnsConfig(dnsZone: string, dnsResolverIp: string): DnsZoneConfig {
  const cleanZone = dnsZone.replace(/^\./, "").toLowerCase();
  return {
    tailDomain: cleanZone,
    directDomain: `dkr.${cleanZone}`,
    dnsResolverIp,
    traefikDomain: `traefik.${cleanZone}`,
  };
}

export async function testDnsResolution(
  resolverIp: string,
  domain: string,
): Promise<{ resolved: boolean; ip?: string; error?: string }> {
  try {
    const proc = Bun.spawn(["dig", `+time=2`, `+tries=2`, `@${resolverIp}`, domain, "+short"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const output = await new Response(proc.stdout).text();
    const code = await proc.exited;
    const trimmed = output.trim();
    if (code === 0 && trimmed && /^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+/.test(trimmed)) {
      return { resolved: true, ip: trimmed.split("\n")[0] };
    }
  } catch {}

  // Fallback to nslookup if dig is not available
  try {
    const proc = Bun.spawn(["nslookup", domain, resolverIp], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const output = await new Response(proc.stdout).text();
    const code = await proc.exited;
    if (code === 0) {
      const match = output.match(/Address:\s+([0-9]+\.[0-9]+\.[0-9]+\.[0-9]+)/g);
      if (match && match.length >= 2 && match[1]) {
        const ip = match[1].replace(/Address:\s+/, "");
        return { resolved: true, ip };
      }
    }
  } catch (err) {
    return { resolved: false, error: (err as Error).message };
  }

  return { resolved: false, error: "No DNS answer returned." };
}
