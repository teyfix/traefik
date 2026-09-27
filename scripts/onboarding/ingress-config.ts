import { composeSubprocessEnv } from "./compose";
import {
  assertIngressStaticIpAllocation,
  type IngressStaticIpAllocation,
} from "./network";

type ComposeNetworkAttachment = { ipv4_address?: unknown } | null;

interface RenderedComposeConfig {
  networks?: Record<string, {
    ipam?: { config?: Array<{ subnet?: unknown }> };
  }>;
  services?: Record<string, {
    networks?: Record<string, ComposeNetworkAttachment> | null;
  }>;
}

export interface ValidatedIngressConfig extends IngressStaticIpAllocation {
  ingressSubnet: string;
}

function requireString(value: unknown, description: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`Rendered Compose config is missing ${description}.`);
  }
  return value;
}

/** Validates the addresses that Docker Compose will actually send to Docker. */
export function assertRenderedIngressConfig(
  config: RenderedComposeConfig,
): ValidatedIngressConfig {
  const ingressSubnet = requireString(
    config.networks?.ingress?.ipam?.config?.[0]?.subnet,
    "networks.ingress.ipam.config[0].subnet (TS_INGRESS_SUBNET)",
  );
  const traefikIp = requireString(
    config.services?.traefik?.networks?.ingress?.ipv4_address,
    "services.traefik.networks.ingress.ipv4_address (TRAEFIK_IP)",
  );
  const tailscaleIp = requireString(
    config.services?.tailscale?.networks?.ingress?.ipv4_address,
    "services.tailscale.networks.ingress.ipv4_address (TS_TAILSCALE_IP)",
  );
  const dnsResolverIp = requireString(
    config.services?.coredns?.networks?.ingress?.ipv4_address,
    "services.coredns.networks.ingress.ipv4_address (TS_DNS_SERVER)",
  );

  assertIngressStaticIpAllocation(ingressSubnet, {
    traefikIp,
    tailscaleIp,
    dnsResolverIp,
  });
  return { ingressSubnet, traefikIp, tailscaleIp, dnsResolverIp };
}

export async function renderAndValidateIngressConfig(
  repoRoot: string,
  extraEnv?: Record<string, string>,
  composeGlobalArgs: string[] = [],
): Promise<ValidatedIngressConfig> {
  const proc = Bun.spawn(
    ["docker", "compose", ...composeGlobalArgs, "config", "--format", "json"],
    {
      cwd: repoRoot,
      env: composeSubprocessEnv(extraEnv),
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [code, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  if (code !== 0) {
    throw new Error(
      `Docker Compose configuration failed: ${stderr.trim() || `exit code ${code}`}`,
    );
  }

  let parsed: RenderedComposeConfig;
  try {
    parsed = JSON.parse(stdout) as RenderedComposeConfig;
  } catch (error) {
    throw new Error(
      `Docker Compose returned invalid JSON: ${(error as Error).message}`,
    );
  }
  return assertRenderedIngressConfig(parsed);
}
