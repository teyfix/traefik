import { describe, expect, test } from "bun:test";
import { assertRenderedIngressConfig } from "./onboarding/ingress-config";

function renderedConfig(addresses?: Partial<{
  traefik: string;
  tailscale: string;
  coredns: string;
  subnet: string;
}>) {
  return {
    networks: {
      ingress: {
        ipam: {
          config: [{ subnet: addresses?.subnet ?? "10.128.0.0/24" }],
        },
      },
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
    ).toThrow(
      /TRAEFIK_IP .* and TS_TAILSCALE_IP .* both resolve to 10\.128\.0\.2/,
    );
  });

  test("compares address uniqueness by parsed numeric value", () => {
    expect(() =>
      assertRenderedIngressConfig(
        renderedConfig({ tailscale: "10.128.000.002" }),
      ),
    ).toThrow(
      /TRAEFIK_IP .* and TS_TAILSCALE_IP .* both resolve to 10\.128\.0\.2/,
    );
  });

  test("rejects whitespace and JavaScript Number address forms", () => {
    for (const malformed of [
      "10.128.0.3 ",
      " 10.128.0.3",
      "10.128.0.3e0",
      "10.128.0.+3",
    ]) {
      expect(() =>
        assertRenderedIngressConfig(
          renderedConfig({ tailscale: malformed }),
        ),
      ).toThrow(/TS_TAILSCALE_IP .* not a valid IPv4 address/);
    }
  });

  test("rejects partial and malformed CIDR prefixes", () => {
    for (const malformed of [
      "10.128.0.0/24foo",
      "10.128.0.0/24 ",
      "10.128.0.0/+24",
      "10.128.0.0/24e0",
    ]) {
      expect(() =>
        assertRenderedIngressConfig(
          renderedConfig({ subnet: malformed }),
        ),
      ).toThrow(/Invalid prefix in CIDR/);
    }
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
