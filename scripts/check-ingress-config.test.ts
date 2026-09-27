import { describe, expect, test } from "bun:test";
import { assertRenderedIngressConfig } from "./onboarding/ingress-config";

function renderedConfig(addresses?: Partial<{
  traefik: string;
  tailscale: string;
  coredns: string;
}>) {
  return {
    networks: {
      ingress: { ipam: { config: [{ subnet: "10.128.0.0/24" }] } },
    },
    services: {
      traefik: {
        networks: {
          ingress: { ipv4_address: addresses?.traefik ?? "10.128.0.2" },
        },
      },
      tailscale: {
        networks: {
          ingress: { ipv4_address: addresses?.tailscale ?? "10.128.0.3" },
        },
      },
      coredns: {
        networks: {
          ingress: { ipv4_address: addresses?.coredns ?? "10.128.0.10" },
        },
      },
    },
  };
}

describe("rendered ingress address validation", () => {
  test("accepts three distinct usable addresses in the ingress subnet", () => {
    expect(assertRenderedIngressConfig(renderedConfig())).toEqual({
      ingressSubnet: "10.128.0.0/24",
      traefikIp: "10.128.0.2",
      tailscaleIp: "10.128.0.3",
      dnsResolverIp: "10.128.0.10",
    });
  });

  test("rejects a missing Tailscale address", () => {
    const config = renderedConfig();
    config.services.tailscale.networks.ingress = {} as { ipv4_address: string };
    expect(() => assertRenderedIngressConfig(config)).toThrow(
      /TS_TAILSCALE_IP/,
    );
  });

  test("rejects duplicate service addresses", () => {
    expect(() =>
      assertRenderedIngressConfig(
        renderedConfig({ tailscale: "10.128.0.2" }),
      ),
    ).toThrow(/TRAEFIK_IP and TS_TAILSCALE_IP both use 10\.128\.0\.2/);
  });

  test("rejects an address outside the ingress subnet", () => {
    expect(() =>
      assertRenderedIngressConfig(
        renderedConfig({ coredns: "10.128.1.10" }),
      ),
    ).toThrow(/TS_DNS_SERVER .* outside TS_INGRESS_SUBNET/);
  });

  test("rejects network and broadcast addresses", () => {
    expect(() =>
      assertRenderedIngressConfig(
        renderedConfig({ tailscale: "10.128.0.0" }),
      ),
    ).toThrow(/TS_TAILSCALE_IP .* not a usable host address/);
    expect(() =>
      assertRenderedIngressConfig(
        renderedConfig({ tailscale: "10.128.0.255" }),
      ),
    ).toThrow(/TS_TAILSCALE_IP .* not a usable host address/);
  });
});
