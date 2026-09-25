import { describe, expect, test } from "bun:test";
import { statSync } from "node:fs";
import { mkdtemp, rm, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseCidr,
  cidrsOverlap,
  deriveDnsResolverIp,
  deriveTraefikIp,
  is10Slash24,
  checkIngressSubnetOwnership,
  allocateIngressSubnet,
  allocateDockerPool,
} from "./network";
import {
  parseEnv,
  updateEnvContent,
  mergeEnvFile,
  writeTailscaleSecretFile,
  scrubLegacyEnvFile,
  redactSecret,
} from "./env";
import { mergeDaemonJson } from "./docker";
import { mergeTailscalePolicy } from "./policy";
import {
  parseCliArgs,
  resolveOptionValue,
  IngressSubnetSchema,
  DockerPoolSchema,
  DnsZoneSchema,
} from "./options";
import { deriveDnsZoneFromHost } from "./host";
import { DEFAULT_SERVICE_HEALTH_TIMEOUT_MS } from "./traefik";
import { DEFAULT_ROUTE_READINESS_TIMEOUT_MS } from "./verify";
import {
  assertSplitDnsPrerequisites,
  reconcileSplitDns,
  type SplitDnsPrerequisites,
} from "./tailscale";
import { assertNoActiveNetworkConflicts, shouldRenewStoredAuthKey } from "./cli";

describe("Network & CIDR calculation", () => {
  test("parses CIDR correctly", () => {
    const parsed = parseCidr("10.128.64.0/18");
    expect(parsed.ip).toBe("10.128.64.0");
    expect(parsed.prefix).toBe(18);
    expect(parsed.size).toBe(16384);
  });

  test("detects CIDR overlap accurately", () => {
    // Overlapping subnets
    expect(cidrsOverlap("10.128.64.0/18", "10.128.64.0/24")).toBe(true);
    expect(cidrsOverlap("10.128.0.0/16", "10.128.64.0/18")).toBe(true);
    expect(cidrsOverlap("0.0.0.0/0", "192.168.1.0/24")).toBe(true);

    // Non-overlapping subnets
    expect(cidrsOverlap("10.128.64.0/18", "10.128.128.0/18")).toBe(false);
    expect(cidrsOverlap("192.168.1.0/24", "10.128.64.0/18")).toBe(false);
    expect(cidrsOverlap("172.17.0.0/16", "172.18.0.0/16")).toBe(false);
  });

  test("derives DNS resolver IP from routed Docker subnet", () => {
    // Given 10.128.64.0/24, offset 10 should be 10.128.64.10
    const ip = deriveDnsResolverIp("10.128.64.0/24", 10);
    expect(ip).toBe("10.128.64.10");

    // Given 10.128.69.0/24, offset 10 should be 10.128.69.10
    const ip2 = deriveDnsResolverIp("10.128.69.0/24", 10);
    expect(ip2).toBe("10.128.69.10");

    // Preserves existing valid IP if inside routed subnet
    const existing = deriveDnsResolverIp("10.128.64.0/24", 10, "10.128.64.20");
    expect(existing).toBe("10.128.64.20");
  });

  test("rejects invalid resolver offsets", () => {
    // Offset 0 (network address) or size - 1 (broadcast) must fail
    expect(() => deriveDnsResolverIp("10.128.64.0/24", 0)).toThrow();
    expect(() => deriveDnsResolverIp("10.128.64.0/24", 255)).toThrow();
  });

  test("allocates non-conflicting Docker pool", () => {
    const existingRoutes = ["10.128.0.0/18", "192.168.1.0/24", "172.17.0.0/16"];
    const pool = allocateDockerPool(existingRoutes);
    expect(pool.hostPool).toBe("10.128.64.0/18");
    expect(pool.routedSubnet).toBe("10.128.64.0/24");
    expect(pool.proxySubnet).toBe("10.128.65.0/24");
    expect(pool.dnsResolver).toBe("10.128.64.10");
  });

  test("allows rerun with ownSubnets without self-conflict", () => {
    const existingRoutes = ["10.128.64.0/24", "172.19.0.0/16", "192.168.1.0/24"];
    const ownSubnets = ["10.128.64.0/24", "172.19.0.0/16"];

    expect(() => allocateDockerPool(existingRoutes, "10.128.64.0/18")).toThrow();

    const pool = allocateDockerPool(existingRoutes, "10.128.64.0/18", ownSubnets);
    expect(pool.hostPool).toBe("10.128.64.0/18");
    expect(pool.routedSubnet).toBe("10.128.64.0/24");
    expect(pool.proxySubnet).toBe("10.128.65.0/24");
  });

  test("avoids existing traefik_proxy subnet collision when allocating routed subnet", () => {
    // traefik_proxy already exists at 10.128.64.0/24, so it is in existingRoutes and localDockerSubnets, but NOT in ownSubnets
    const existingRoutes = ["10.128.64.0/24"];
    const ownSubnets: string[] = [];
    const localDockerSubnets = ["10.128.64.0/24"];

    const pool = allocateDockerPool(existingRoutes, "10.128.64.0/18", ownSubnets, localDockerSubnets);
    expect(pool.hostPool).toBe("10.128.64.0/18");
    // routedSubnet must skip 10.128.64.0/24 and take 10.128.65.0/24
    expect(pool.routedSubnet).toBe("10.128.65.0/24");
    expect(pool.proxySubnet).toBe("10.128.66.0/24");
    expect(pool.dnsResolver).toBe("10.128.65.10");
  });

  test("scans full range of 512 candidate /18 pools beyond index 32", () => {
    // Fill the first 40 /18 pools in 10.128.0.0/9
    const baseStart = (10 << 24) | (128 << 16);
    const step = 16384;
    const occupiedRoutes: string[] = [];
    for (let i = 0; i < 40; i++) {
      const ip = (baseStart + i * step) >>> 0;
      const ipStr = [(ip >>> 24) & 255, (ip >>> 16) & 255, (ip >>> 8) & 255, ip & 255].join(".");
      occupiedRoutes.push(`${ipStr}/18`);
    }

    const pool = allocateDockerPool(occupiedRoutes);
    // 40th pool index (candidate 40)
    const expectedInt = (baseStart + 40 * step) >>> 0;
    const expectedIp = [(expectedInt >>> 24) & 255, (expectedInt >>> 16) & 255, (expectedInt >>> 8) & 255, expectedInt & 255].join(".");
    expect(pool.hostPool).toBe(`${expectedIp}/18`);
  });

  test("derives Traefik IP from routed ingress subnet", () => {
    // Given 10.128.64.0/24, offset 2 should be 10.128.64.2
    const ip = deriveTraefikIp("10.128.64.0/24", 2);
    expect(ip).toBe("10.128.64.2");

    // Preserves existing valid IP if inside routed subnet
    const existing = deriveTraefikIp("10.128.64.0/24", 2, "10.128.64.20");
    expect(existing).toBe("10.128.64.20");

    // Rejects invalid offsets
    expect(() => deriveTraefikIp("10.128.64.0/24", 0)).toThrow();
    expect(() => deriveTraefikIp("10.128.64.0/24", 255)).toThrow();
  });

  test("validates is10Slash24 correctly", () => {
    expect(is10Slash24("10.128.64.0/24")).toBe(true);
    expect(is10Slash24("10.0.1.0/24")).toBe(true);
    expect(is10Slash24("10.255.255.0/24")).toBe(true);
    expect(is10Slash24("172.16.0.0/24")).toBe(false);
    expect(is10Slash24("192.168.1.0/24")).toBe(false);
    expect(is10Slash24("10.128.64.0/18")).toBe(false);
  });

  test("checkIngressSubnetOwnership validates unambiguous ownership", () => {
    const devices = [
      {
        id: "dev-1",
        hostname: "other-router",
        name: "other-router.tailnet.ts.net",
        tags: ["tag:docker"],
        advertisedRoutes: ["10.128.1.0/24"],
        enabledRoutes: ["10.128.1.0/24"],
      },
      {
        id: "dev-2",
        hostname: "my-host-router",
        name: "my-host-router.tailnet.ts.net",
        tags: ["tag:docker"],
        advertisedRoutes: ["10.128.64.0/24"],
        enabledRoutes: ["10.128.64.0/24"],
      },
    ];

    // Unambiguous: owned by current router (with matching tag) and not conflicting
    const check1 = checkIngressSubnetOwnership({
      candidateSubnet: "10.128.64.0/24",
      tailnetDevices: devices,
      routerHostname: "my-host-router",
      routerTag: "tag:docker",
      localRoutes: ["192.168.1.0/24"],
    });
    expect(check1.unambiguous).toBe(true);

    // Negative test: same-hostname untagged host-native node must NOT be treated as own router
    const checkUntagged = checkIngressSubnetOwnership({
      candidateSubnet: "10.128.64.0/24",
      tailnetDevices: [
        {
          id: "dev-untagged",
          hostname: "my-host-router",
          name: "my-host-router.tailnet.ts.net",
          tags: [], // Untagged host-native Tailscale node
          advertisedRoutes: ["10.128.64.0/24"],
          enabledRoutes: ["10.128.64.0/24"],
        },
      ],
      routerHostname: "my-host-router",
      routerTag: "tag:docker",
      localRoutes: ["192.168.1.0/24"],
    });
    expect(checkUntagged.unambiguous).toBe(false);
    expect(checkUntagged.reason).toContain("claimed by another tailnet device");

    // Negative test: overlaps with unrelated local Docker network subnet
    const checkDockerConflict = checkIngressSubnetOwnership({
      candidateSubnet: "10.128.5.0/24",
      tailnetDevices: devices,
      routerHostname: "my-host-router",
      routerTag: "tag:docker",
      localDockerSubnets: ["10.128.5.0/24", "172.19.0.0/16"],
      ownDockerSubnets: [], // Neither traefik_ingress nor tailscale_services owns 10.128.5.0/24
    });
    expect(checkDockerConflict.unambiguous).toBe(false);
    expect(checkDockerConflict.reason).toContain("overlaps with unrelated local Docker network subnet");

    // Positive test: candidate matches proven own Docker subnet (traefik_ingress)
    const checkProvenOwn = checkIngressSubnetOwnership({
      candidateSubnet: "10.128.64.0/24",
      tailnetDevices: devices,
      routerHostname: "my-host-router",
      routerTag: "tag:docker",
      localDockerSubnets: ["10.128.64.0/24", "172.19.0.0/16"],
      ownDockerSubnets: ["10.128.64.0/24"], // Proven ownership
    });
    expect(checkProvenOwn.unambiguous).toBe(true);

    // Ambiguous / conflicting: claimed by another tailnet device (even if offline)
    const check2 = checkIngressSubnetOwnership({
      candidateSubnet: "10.128.1.0/24",
      tailnetDevices: devices,
      routerHostname: "my-host-router",
      routerTag: "tag:docker",
      localRoutes: ["192.168.1.0/24"],
    });
    expect(check2.unambiguous).toBe(false);
    expect(check2.reason).toContain("claimed by another tailnet device");

    // Ambiguous: overlaps with local host route
    const check3 = checkIngressSubnetOwnership({
      candidateSubnet: "10.128.64.0/24",
      tailnetDevices: devices,
      routerHostname: "my-host-router",
      routerTag: "tag:docker",
      localRoutes: ["10.128.64.0/24"],
    });
    expect(check3.unambiguous).toBe(false);
    expect(check3.reason).toContain("overlaps with local host route");

    // Ambiguous: not 10.* /24
    const check4 = checkIngressSubnetOwnership({
      candidateSubnet: "172.20.0.0/24",
      tailnetDevices: devices,
      routerHostname: "my-host-router",
      routerTag: "tag:docker",
    });
    expect(check4.unambiguous).toBe(false);
  });

  test("assertNoActiveNetworkConflicts gives missing-container-safe cleanup without docker compose", () => {
    // Model legacy .env missing TRAEFIK_IP
    const legacyEnvContent = [
      "TS_SERVICE_SUBNET=10.128.32.0/24",
      "TAIL_DOMAIN=legacy.gg",
      "TS_HOSTNAME=legacy-host-router",
    ].join("\n");
    const parsedLegacyEnv = parseEnv(legacyEnvContent);
    expect(parsedLegacyEnv.TRAEFIK_IP).toBeUndefined();

    // 1. Legacy tailscale_services network with active containers
    const legacyActive = [
      {
        name: "tailscale_services",
        id: "net-1",
        driver: "bridge",
        subnets: ["10.128.32.0/24"],
        containers: ["traefik_tailscale", "traefik_coredns"],
      },
    ];

    expect(() =>
      assertNoActiveNetworkConflicts(legacyActive, "10.128.64.0/24"),
    ).toThrowError(/Existing legacy Docker network 'tailscale_services'/);

    try {
      assertNoActiveNetworkConflicts(legacyActive, "10.128.64.0/24");
    } catch (e: any) {
      // Ignore missing exact-name containers, then remove only the legacy network.
      expect(e.message).toContain("docker rm -f traefik_tailscale traefik_coredns 2>/dev/null || true;");
      expect(e.message).toContain("docker network rm tailscale_services");
      expect(e.message).toContain("rerun onboarding CLI to write configuration and start services");
      expect(e.message).toContain("preserving named volumes and unrelated networks");
      // Never use docker compose commands (which would fail during interpolation of TRAEFIK_IP:?)
      expect(e.message).not.toContain("docker compose");
      expect(e.message).not.toContain("docker volume");
    }

    // 2. Differing traefik_ingress network with active containers
    const ingressActive = [
      {
        name: "traefik_ingress",
        id: "net-2",
        driver: "bridge",
        subnets: ["10.128.32.0/24"],
        containers: ["traefik", "traefik_tailscale", "traefik_coredns"],
      },
    ];

    expect(() =>
      assertNoActiveNetworkConflicts(ingressActive, "10.128.64.0/24"),
    ).toThrowError(/Existing Docker network 'traefik_ingress'/);

    try {
      assertNoActiveNetworkConflicts(ingressActive, "10.128.64.0/24");
    } catch (e: any) {
      expect(e.message).toContain("docker rm -f traefik traefik_tailscale traefik_coredns 2>/dev/null || true");
      expect(e.message).toContain("docker network rm traefik_ingress");
      expect(e.message).toContain("rerun onboarding");
      expect(e.message).toContain("Named volumes and traefik_proxy are preserved");
      expect(e.message).not.toContain("docker compose");
      expect(e.message).not.toContain("docker volume");
    }

    // 3. Inactive unlabeled matching ingress network is marked for safe recreation.
    const inactiveNetworks = [
      {
        name: "tailscale_services",
        id: "net-1",
        driver: "bridge",
        subnets: ["10.128.32.0/24"],
        containers: [],
      },
      {
        name: "traefik_ingress",
        id: "net-2",
        driver: "bridge",
        subnets: ["10.128.64.0/24"],
        containers: [],
      },
    ];

    const res = assertNoActiveNetworkConflicts(inactiveNetworks, "10.128.64.0/24");
    expect(res.needsIngressRecreate).toBe(true);
  });

  test("assertNoActiveNetworkConflicts in dryRun mode returns warning without throwing on active legacy or differing ingress networks", () => {
    const legacyActive = [
      {
        name: "tailscale_services",
        id: "net-1",
        driver: "bridge",
        subnets: ["10.128.32.0/24"],
        containers: ["traefik_tailscale", "traefik_coredns"],
      },
    ];

    // In normal mode (dryRun = false), it throws
    expect(() =>
      assertNoActiveNetworkConflicts(legacyActive, "10.128.64.0/24", false),
    ).toThrowError(/Existing legacy Docker network 'tailscale_services'/);

    // In dryRun mode (dryRun = true), it does not throw and returns warning
    const dryRunLegacy = assertNoActiveNetworkConflicts(legacyActive, "10.128.64.0/24", true);
    expect(dryRunLegacy.warning).toBeDefined();
    expect(dryRunLegacy.warning).toContain("docker rm -f traefik_tailscale traefik_coredns 2>/dev/null || true;");
    expect(dryRunLegacy.warning).toContain("docker network rm tailscale_services");

    // Differing traefik_ingress network with active containers
    const ingressActive = [
      {
        name: "traefik_ingress",
        id: "net-2",
        driver: "bridge",
        subnets: ["10.128.32.0/24"],
        containers: ["traefik", "traefik_tailscale", "traefik_coredns"],
      },
    ];

    expect(() =>
      assertNoActiveNetworkConflicts(ingressActive, "10.128.64.0/24", false),
    ).toThrowError(/Existing Docker network 'traefik_ingress'/);

    const dryRunIngress = assertNoActiveNetworkConflicts(ingressActive, "10.128.64.0/24", true);
    expect(dryRunIngress.needsIngressRecreate).toBe(true);
    expect(dryRunIngress.warning).toBeDefined();
    expect(dryRunIngress.warning).toContain("docker rm -f traefik traefik_tailscale traefik_coredns 2>/dev/null || true");
    expect(dryRunIngress.warning).toContain("docker network rm traefik_ingress");
  });

  test("preserves non-conflicting Compose-managed networks", () => {
    const composeNetworks = [
      {
        name: "traefik_proxy",
        id: "proxy-net",
        driver: "bridge",
        subnets: ["172.20.0.0/16"],
        containers: ["application-backend"],
        labels: {
          "com.docker.compose.project": "traefik",
          "com.docker.compose.network": "proxy",
        },
      },
      {
        name: "traefik_ingress",
        id: "ingress-net",
        driver: "bridge",
        subnets: ["10.128.64.0/24"],
        containers: ["traefik"],
        labels: {
          "com.docker.compose.project": "traefik",
          "com.docker.compose.network": "ingress",
        },
      },
    ];

    const result = assertNoActiveNetworkConflicts(composeNetworks, "10.128.64.0/24");
    expect(result.needsProxyRecreate).toBe(false);
    expect(result.needsIngressRecreate).toBe(false);
  });

  test("fails safely for active unlabeled matching ingress and proxy networks", () => {
    const ingress = {
      name: "traefik_ingress",
      id: "ingress-net",
      driver: "bridge",
      subnets: ["10.128.64.0/24"],
      containers: ["traefik"],
    };
    expect(() => assertNoActiveNetworkConflicts([ingress], "10.128.64.0/24"))
      .toThrow(/required Compose ownership labels/);

    const proxy = {
      name: "traefik_proxy",
      id: "proxy-net",
      driver: "bridge",
      subnets: ["172.20.0.0/16"],
      containers: ["application-backend"],
    };
    expect(() => assertNoActiveNetworkConflicts([proxy], "10.128.64.0/24"))
      .toThrow(/Do not delete backend containers or volumes/);
  });

  test("allocateIngressSubnet allocates unique 10.* /24 per host and derives static IPs", () => {
    const claimedRoutes = [
      "10.128.0.0/24", // claimed by offline device
      "10.128.1.0/24", // claimed by another device
      "192.168.1.0/24", // local route
    ];

    const alloc = allocateIngressSubnet({ claimedRoutes });
    expect(alloc.ingressSubnet).toBe("10.128.2.0/24");
    expect(alloc.dnsResolverIp).toBe("10.128.2.10");
    expect(alloc.traefikIp).toBe("10.128.2.2");
  });

  test("allocateIngressSubnet preserves unambiguousSubnet without self-conflict", () => {
    const claimedRoutes = ["10.128.64.0/24", "10.128.1.0/24"];
    const alloc = allocateIngressSubnet({
      claimedRoutes,
      unambiguousSubnet: "10.128.64.0/24",
    });
    expect(alloc.ingressSubnet).toBe("10.128.64.0/24");
    expect(alloc.dnsResolverIp).toBe("10.128.64.10");
    expect(alloc.traefikIp).toBe("10.128.64.2");
  });

  test("allocateIngressSubnet rejects conflicting preferred subnet", () => {
    const claimedRoutes = ["10.128.5.0/24"];
    expect(() =>
      allocateIngressSubnet({
        claimedRoutes,
        preferredSubnet: "10.128.5.0/24",
      }),
    ).toThrow("conflicts with claimed route");
  });

  test("allocateIngressSubnet throws when DNS resolver and Traefik IP coincide", () => {
    expect(() =>
      allocateIngressSubnet({
        claimedRoutes: [],
        preferredSubnet: "10.128.64.0/24",
        existingDnsIp: "10.128.64.10",
        existingTraefikIp: "10.128.64.10",
      }),
    ).toThrow("cannot coincide");
  });

  test("two hosts sharing default private proxy bridge but advertising distinct ingress subnets", () => {
    // Host 1: Ingress 10.128.1.0/24, local unadvertised proxy bridge 172.19.0.0/16
    // Host 2: Ingress 10.128.2.0/24, local unadvertised proxy bridge 172.19.0.0/16
    const tailnetClaimed = ["10.128.1.0/24"];
    const host2Local = ["172.19.0.0/16"]; // Local unadvertised proxy bridge

    const allocHost2 = allocateIngressSubnet({
      claimedRoutes: [...tailnetClaimed, ...host2Local],
      preferredSubnet: "10.128.2.0/24",
    });

    expect(allocHost2.ingressSubnet).toBe("10.128.2.0/24");
    expect(allocHost2.traefikIp).toBe("10.128.2.2");
    expect(allocHost2.dnsResolverIp).toBe("10.128.2.10");

    // Both hosts have 172.19.0.0/16 locally, but because it is unadvertised,
    // ownership of distinct ingress /24 subnets is unambiguous:
    const ownership = checkIngressSubnetOwnership({
      candidateSubnet: "10.128.2.0/24",
      tailnetDevices: [
        {
          hostname: "host1-router",
          advertisedRoutes: ["10.128.1.0/24"],
          enabledRoutes: ["10.128.1.0/24"],
        },
      ],
      routerHostname: "host2-router",
      localRoutes: ["172.19.0.0/16"],
      ownDockerSubnets: ["172.19.0.0/16"],
    });
    expect(ownership.unambiguous).toBe(true);
  });

  test("ingress subnet claimed by host-native Tailscale node is marked ambiguous and rejected", () => {
    // host-native Tailscale node dixie and container router teyfix-router
    const ownership = checkIngressSubnetOwnership({
      candidateSubnet: "10.10.10.0/24",
      tailnetDevices: [
        {
          id: "node-dixie",
          name: "dixie.tailnet.ts.net",
          hostname: "dixie",
          advertisedRoutes: ["10.10.10.0/24", "172.19.0.0/16"],
          enabledRoutes: ["10.10.10.0/24", "172.19.0.0/16"],
        },
        {
          id: "node-router",
          name: "teyfix-router.tailnet.ts.net",
          hostname: "teyfix-router",
          advertisedRoutes: ["10.10.10.0/24"],
          enabledRoutes: [],
        },
      ],
      routerHostname: "teyfix-router",
    });

    expect(ownership.unambiguous).toBe(false);
    expect(ownership.reason).toContain("claimed by another tailnet device (dixie.tailnet.ts.net)");

    expect(() =>
      allocateIngressSubnet({
        claimedRoutes: ["10.10.10.0/24"],
        preferredSubnet: "10.10.10.0/24",
      }),
    ).toThrow("conflicts with claimed route");
  });
});

describe("Host & DNS Zone derivation", () => {
  test("derives zone from host", () => {
    expect(deriveDnsZoneFromHost("dixie")).toBe("dixie.gg");
    expect(deriveDnsZoneFromHost("my-server", "org")).toBe("my-server.org");
    expect(deriveDnsZoneFromHost("DEV_NODE")).toBe("dev-node.gg");
  });
});

describe("Safe .env merging & secret protection", () => {
  test("parses .env values cleanly", () => {
    const content = `
# Comment
TRAEFIK_DOMAIN="traefik.tail.gg"
EMPTY=
UNQUOTED=hello_world
`;
    const env = parseEnv(content);
    expect(env.TRAEFIK_DOMAIN).toBe("traefik.tail.gg");
    expect(env.EMPTY).toBe("");
    expect(env.UNQUOTED).toBe("hello_world");
  });

  test("updates .env while preserving unrelated keys and comments", () => {
    const original = `# Main config
IMAGE="alpine:3.20"
KEEP_ME="preserved"
TS_HOSTNAME="old-host"
`;
    const updated = updateEnvContent(original, {
      TS_HOSTNAME: "new-host",
      NEW_KEY: "added-value",
    });

    expect(updated).toContain('# Main config');
    expect(updated).toContain('IMAGE="alpine:3.20"');
    expect(updated).toContain('KEEP_ME="preserved"');
    expect(updated).toContain('TS_HOSTNAME="new-host"');
    expect(updated).toContain('NEW_KEY="added-value"');
  });

  test("never writes TS_API_TOKEN to .env", () => {
    const original = `FOO="bar"\n`;
    const updated = updateEnvContent(original, {
      TS_API_TOKEN: "secret-token-12345",
      SAFE_KEY: "value",
    });
    expect(updated).not.toContain("TS_API_TOKEN");
    expect(updated).not.toContain("secret-token-12345");
  });

  test("redacts secrets properly", () => {
    expect(redactSecret("")).toBe("");
    expect(redactSecret("12345678")).toBe("********");
    expect(redactSecret("secret-auth-k1234567890abcdef")).toBe("secr...cdef");
  });

  test("mergeEnvFile tightens permissions to 0o600", async () => {
    const tmpFile = `/tmp/test-env-${Date.now()}.env`;
    try {
      await Bun.write(tmpFile, "FOO=bar\n");
      await mergeEnvFile(tmpFile, { BAZ: "qux" });
      const stats = statSync(tmpFile);
      expect(stats.mode & 0o777).toBe(0o600);
    } finally {
      await unlink(tmpFile).catch(() => {});
    }
  });

  test("atomically stores only the reusable auth key metadata with mode 0o600", async () => {
    const tempDirectory = await mkdtemp(join(tmpdir(), "test-tailscale-secret-"));
    const tmpFile = join(tempDirectory, ".env.tailscale.local");
    try {
      await Bun.write(tmpFile, "TS_API_TOKEN=must-not-survive\nCUSTOM_VAR=keep\n");
      const expiry = "2026-12-24T00:00:00.000Z";
      await writeTailscaleSecretFile(tmpFile, "test-placeholder-auth-key", expiry);
      const stored = await Bun.file(tmpFile).text();
      expect(stored).not.toContain("must-not-survive");
      expect(stored).toContain("CUSTOM_VAR=keep");
      const parsed = parseEnv(stored);
      expect(parsed.TS_API_TOKEN).toBeUndefined();
      expect(parsed.TS_AUTHKEY).toBe("test-placeholder-auth-key");
      expect(parsed.TS_AUTHKEY_EXPIRES_AT).toBe(expiry);
      expect(statSync(tmpFile).mode & 0o777).toBe(0o600);
    } finally {
      await rm(tempDirectory, { recursive: true, force: true });
    }
  });

  test("updateEnvContent scrubs stale legacy keys and updates TS_ROUTES to single ingress subnet", () => {
    const original = `
# Old configuration
DOCKER_POOL="10.128.64.0/18"
TS_SERVICE_SUBNET="10.10.10.0/24"
DIRECT_DOMAIN="dkr.dev.example.test"
TS_ROUTES="10.10.10.0/24,172.19.0.0/16"
TS_AUTHKEY="legacy-auth-placeholder"
KEEP_KEY="important_custom_setting"
`;
    const updated = updateEnvContent(original, {
      TS_ROUTES: "10.128.64.0/24",
      TS_INGRESS_SUBNET: "10.128.64.0/24",
      TRAEFIK_IP: "10.128.64.2",
      TS_DNS_SERVER: "10.128.64.10",
    });

    expect(updated).not.toContain("DOCKER_POOL");
    expect(updated).not.toContain("TS_SERVICE_SUBNET");
    expect(updated).not.toContain("DIRECT_DOMAIN");
    expect(updated).not.toContain("TS_AUTHKEY");
    expect(updated).not.toContain("172.19.0.0/16");
    expect(updated).toContain('TS_ROUTES="10.128.64.0/24"');
    expect(updated).toContain('TS_INGRESS_SUBNET="10.128.64.0/24"');
    expect(updated).toContain('KEEP_KEY="important_custom_setting"');
  });

  test("scrubLegacyEnvFile scrubs legacy credentials and stale routes without printing secrets", async () => {
    const tmpFile = `/tmp/test-legacy-env-${Date.now()}.env`;
    try {
      await Bun.write(
        tmpFile,
        `TS_AUTHKEY="legacy-secret-placeholder"\nTS_ROUTES="10.10.10.0/24,172.19.0.0/16"\nDOCKER_POOL="10.128.64.0/18"\nCUSTOM_VAR="keep_me"\n`,
      );
      const res = await scrubLegacyEnvFile(tmpFile);
      expect(res.scrubbed).toBe(true);
      expect(res.removedKeys).toContain("TS_AUTHKEY");
      expect(res.removedKeys).toContain("TS_ROUTES");
      expect(res.removedKeys).toContain("DOCKER_POOL");

      const scrubbedContent = await Bun.file(tmpFile).text();
      expect(scrubbedContent).not.toContain("legacy-secret-placeholder");
      expect(scrubbedContent).not.toContain("172.19.0.0/16");
      expect(scrubbedContent).not.toContain("DOCKER_POOL");
      expect(scrubbedContent).toContain('CUSTOM_VAR="keep_me"');
    } finally {
      await unlink(tmpFile).catch(() => {});
    }
  });
});

describe("Docker daemon.json safe merging", () => {
  test("merges default-address-pools preserving existing runtimes (NVIDIA)", () => {
    const existing = JSON.stringify(
      {
        runtimes: {
          nvidia: {
            path: "nvidia-container-runtime",
            args: [],
          },
        },
      },
      null,
      2,
    );

    const { merged, changed } = mergeDaemonJson(existing, {
      base: "10.128.64.0/18",
      size: 24,
    });

    expect(changed).toBe(true);
    expect(merged.runtimes.nvidia.path).toBe("nvidia-container-runtime");
    expect(merged["default-address-pools"]).toEqual([
      { base: "10.128.64.0/18", size: 24 },
    ]);
  });

  test("is idempotent when pool already matches", () => {
    const existing = JSON.stringify({
      "default-address-pools": [{ base: "10.128.64.0/18", size: 24 }],
    });
    const { changed } = mergeDaemonJson(existing, {
      base: "10.128.64.0/18",
      size: 24,
    });
    expect(changed).toBe(false);
  });
});

describe("Tailscale Policy minimal merging", () => {
  test("adds tagOwners and autoApprovers without clobbering existing policy", () => {
    const current = {
      tagOwners: {
        "tag:existing": ["group:ops"],
      },
      acls: [
        { action: "accept", src: ["*"], dst: ["*:*"] },
      ],
    };

    const { policy, changed } = mergeTailscalePolicy(current, {
      routerTag: "tag:docker",
      routedSubnet: "10.128.64.0/24",
    });

    expect(changed).toBe(true);
    expect(policy.tagOwners!["tag:existing"]).toEqual(["group:ops"]);
    expect(policy.tagOwners!["tag:docker"]).toEqual(["autogroup:admin"]);
    expect(policy.autoApprovers!.routes!["10.128.64.0/24"]).toEqual(["tag:docker"]);
    // Since accept-all ACL already exists, no duplicate grants should be added
    expect(policy.grants).toBeUndefined();
  });

  test("is idempotent when tag and route already configured", () => {
    const current = {
      tagOwners: {
        "tag:docker": ["autogroup:admin"],
      },
      autoApprovers: {
        routes: {
          "10.128.64.0/24": ["tag:docker"],
        },
      },
      acls: [{ action: "accept", src: ["*"], dst: ["*:*"] }],
    };

    const { changed } = mergeTailscalePolicy(current, {
      routerTag: "tag:docker",
      routedSubnet: "10.128.64.0/24",
    });

    expect(changed).toBe(false);
  });

  test("auto-approves additional routes such as traefik_proxy", () => {
    const { policy } = mergeTailscalePolicy({}, {
      routerTag: "tag:docker",
      routedSubnet: "10.128.64.0/24",
      additionalRoutes: ["172.19.0.0/16"],
    });

    expect(policy.autoApprovers?.routes?.["10.128.64.0/24"]).toEqual(["tag:docker"]);
    expect(policy.autoApprovers?.routes?.["172.19.0.0/16"]).toEqual(["tag:docker"]);
  });
});

describe("CLI resolution contract", () => {
  test("parses explicit CLI flags", () => {
    const options = parseCliArgs([
      "--ingress-subnet",
      "10.128.64.0/24",
      "--ts-dns-zone",
      "dixie.gg",
      "--rotate-authkey",
      "--replace-split-dns",
      "--yes",
      "--dry-run",
    ]);
    expect(options.ingressSubnet).toBe("10.128.64.0/24");
    expect(options.tsDnsZone).toBe("dixie.gg");
    expect(options.rotateAuthKey).toBe(true);
    expect(options.replaceSplitDns).toBe(true);
    expect(options.yes).toBe(true);
    expect(options.dryRun).toBe(true);
  });

  test("rejects deprecated --docker-pool flag with migration guidance", () => {
    expect(() =>
      parseCliArgs(["--docker-pool", "10.128.64.0/18"]),
    ).toThrow("The '--docker-pool' flag has been removed");
  });

  test("validates ingress subnet schema", () => {
    expect(IngressSubnetSchema.safeParse("auto").success).toBe(true);
    expect(IngressSubnetSchema.safeParse("10.128.64.0/24").success).toBe(true);
    expect(IngressSubnetSchema.safeParse("10.0.1.0/24").success).toBe(true);
    expect(IngressSubnetSchema.safeParse("172.16.0.0/24").success).toBe(false);
    expect(IngressSubnetSchema.safeParse("10.128.64.0/18").success).toBe(false);
    expect(IngressSubnetSchema.safeParse("invalid").success).toBe(false);
  });

  test("validates docker pool schema", () => {
    expect(DockerPoolSchema.safeParse("auto").success).toBe(true);
    expect(DockerPoolSchema.safeParse("10.128.64.0/18").success).toBe(true);
    expect(DockerPoolSchema.safeParse("10.128.64.0/24").success).toBe(false);
    expect(DockerPoolSchema.safeParse("invalid").success).toBe(false);
  });

  test("validates DNS zone schema", () => {
    expect(DnsZoneSchema.safeParse("auto").success).toBe(true);
    expect(DnsZoneSchema.safeParse("dixie.gg").success).toBe(true);
    expect(DnsZoneSchema.safeParse("my.custom.zone.test").success).toBe(true);
    expect(DnsZoneSchema.safeParse("invalid zone with spaces").success).toBe(false);
  });

  test("resolves options following the contract", async () => {
    // 1. Explicit CLI value
    const val1 = await resolveOptionValue({
      cliValue: "explicit-val",
      defaultValue: "rec-val",
      isYes: false,
      promptFn: async () => "prompt-val",
    });
    expect(val1).toBe("explicit-val");

    // 2. Explicit "auto"
    const val2 = await resolveOptionValue({
      cliValue: "auto",
      defaultValue: "rec-val",
      isYes: false,
      promptFn: async () => "prompt-val",
    });
    expect(val2).toBe("auto");

    // 3. --yes with recommended value
    const val3 = await resolveOptionValue({
      cliValue: undefined,
      defaultValue: "rec-val",
      isYes: true,
      promptFn: async () => "prompt-val",
    });
    expect(val3).toBe("rec-val");

    // 4. Interactive prompt
    const val4 = await resolveOptionValue({
      cliValue: undefined,
      defaultValue: "rec-val",
      isYes: false,
      promptFn: async (rec) => `chosen-${rec}`,
    });
    expect(val4).toBe("chosen-rec-val");
  });

  test("renews stored keys with missing, invalid, expired, or near-term expiry metadata", () => {
    const now = Date.parse("2026-09-25T00:00:00.000Z");
    expect(shouldRenewStoredAuthKey(undefined, undefined, now)).toBe(false);
    expect(shouldRenewStoredAuthKey("placeholder", undefined, now)).toBe(true);
    expect(shouldRenewStoredAuthKey("placeholder", "invalid", now)).toBe(true);
    expect(shouldRenewStoredAuthKey("placeholder", "2026-09-24T00:00:00.000Z", now)).toBe(true);
    expect(shouldRenewStoredAuthKey("placeholder", "2026-09-30T00:00:00.000Z", now)).toBe(true);
    expect(shouldRenewStoredAuthKey("placeholder", "2026-10-25T00:00:00.000Z", now)).toBe(false);
  });

  test("Compose forces startup auth and takes TS_AUTHKEY only from the dedicated env file", async () => {
    const composeText = await Bun.file(
      join(import.meta.dir, "../../compose/tailscale/docker-compose.yaml"),
    ).text();
    expect(composeText).toContain('TS_AUTH_ONCE: "false"');
    expect(composeText).toContain("${PWD}/env/.env.tailscale.local");
    expect(composeText).not.toMatch(/^\s+TS_AUTHKEY:/m);
  });
});

describe("Tailscale API Client semantics", () => {
  test("readiness polling defaults cover 30-second health probes", () => {
    expect(DEFAULT_SERVICE_HEALTH_TIMEOUT_MS).toBe(120_000);
    expect(DEFAULT_ROUTE_READINESS_TIMEOUT_MS).toBe(120_000);
  });

  test("creates reusable ephemeral tagged auth key payload at the 90-day maximum", async () => {
    let capturedBody: any;
    const mockFetch = async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).endsWith("/keys")) {
        capturedBody = JSON.parse(String(init?.body));
        return new Response(JSON.stringify({ key: "mock-auth-test-key" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("{}", { status: 200 });
    };

    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetch as any;
    try {
      const { TailscaleApiClient } = await import("./tailscale-api");
      const client = new TailscaleApiClient("mock-api-test-token");
      const key = await client.createAuthKey({ tag: "tag:docker" });

      expect(key).toBe("mock-auth-test-key");
      expect(capturedBody.capabilities.devices.create.reusable).toBe(true);
      expect(capturedBody.capabilities.devices.create.ephemeral).toBe(true);
      expect(capturedBody.capabilities.devices.create.preauthorized).toBe(true);
      expect(capturedBody.capabilities.devices.create.tags).toEqual(["tag:docker"]);
      expect(capturedBody.expirySeconds).toBe(90 * 24 * 60 * 60);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("getDevices requests fields=all and captures routes with Go client casing", async () => {
    let capturedUrl = "";
    const mockFetch = async (url: string | URL | Request) => {
      capturedUrl = String(url);
      return new Response(
        JSON.stringify({
          devices: [
            {
              id: "12345",
              name: "my-router",
              hostname: "my-router",
              Tags: ["tag:docker"],
              AdvertisedRoutes: ["10.128.64.0/24"],
              EnabledRoutes: ["10.128.64.0/24"],
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };

    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetch as any;
    try {
      const { TailscaleApiClient } = await import("./tailscale-api");
      const client = new TailscaleApiClient("mock-token");
      const devices = await client.getDevices();

      expect(capturedUrl).toContain("/tailnet/-/devices?fields=all");
      expect(devices[0]?.advertisedRoutes).toEqual(["10.128.64.0/24"]);
      expect(devices[0]?.enabledRoutes).toEqual(["10.128.64.0/24"]);
      expect(devices[0]?.tags).toEqual(["tag:docker"]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("reconcileSplitDns rejects conflicting existing resolver without forceReplace", async () => {
    const { reconcileSplitDns } = await import("./tailscale");
    const { TailscaleApiClient } = await import("./tailscale-api");
    const client = new TailscaleApiClient("mock-token");
    let patchCalled = false;
    client.updateSplitDns = async () => {
      patchCalled = true;
    };

    // 1. Conflict without forceReplace throws error
    expect(
      reconcileSplitDns({
        client,
        currentSplitDns: { "example.gg": ["1.2.3.4"] },
        dnsZone: "example.gg",
        dnsResolverIp: "10.128.64.10",
      }),
    ).rejects.toThrow("Conflict: Split DNS zone");

    expect(patchCalled).toBe(false);

    // 2. Conflict with forceReplace succeeds
    const res = await reconcileSplitDns({
      client,
      currentSplitDns: { "example.gg": ["1.2.3.4"] },
      dnsZone: "example.gg",
      dnsResolverIp: "10.128.64.10",
      forceReplace: true,
    });
    expect(res.applied).toBe(true);
    expect(patchCalled).toBe(true);

    // 3. Conflict in dryRun mode without forceReplace reports conflict safely without throwing
    const dryRunConflict = await reconcileSplitDns({
      client,
      currentSplitDns: { "example.gg": ["1.2.3.4"] },
      dnsZone: "example.gg",
      dnsResolverIp: "10.128.64.10",
      dryRun: true,
    });
    expect(dryRunConflict.applied).toBe(false);
    expect(dryRunConflict.reason).toContain("pass --replace-split-dns to overwrite");

    // 4. Conflict in dryRun mode with forceReplace indicates replacement
    const dryRunForce = await reconcileSplitDns({
      client,
      currentSplitDns: { "example.gg": ["1.2.3.4"] },
      dnsZone: "example.gg",
      dnsResolverIp: "10.128.64.10",
      forceReplace: true,
      dryRun: true,
    });
    expect(dryRunForce.applied).toBe(true);
    expect(dryRunForce.reason).toContain("replacing [1.2.3.4]");
  });

  test("ensureRouterAuthKey reuses a stored key and rotates without deleting state", async () => {
    let keysCreated = 0;
    const mockFetch = async () => {
      keysCreated++;
      return new Response(JSON.stringify({ key: "fresh-auth-key" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };

    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetch as any;
    try {
      const { TailscaleApiClient } = await import("./tailscale-api");
      const { ensureRouterAuthKey, findRouterDevice } = await import("./tailscale");
      const client = new TailscaleApiClient("mock-token");

      // findRouterDevice matches strictly by hostname and never falls back to tag
      const devices = [
        {
          id: "1",
          name: "other-host-router.tailnet.ts.net",
          hostname: "other-host-router",
          tags: ["tag:docker"],
          advertisedRoutes: ["10.200.0.0/24"],
        },
        {
          id: "2",
          name: "my-router.tailnet.ts.net",
          hostname: "my-router",
          tags: ["tag:docker"],
          advertisedRoutes: ["10.128.64.0/24"],
        },
      ];
      expect(findRouterDevice(devices as any, "my-router")?.id).toBe("2");
      expect(findRouterDevice(devices as any, "unknown-router")).toBeUndefined();

      // A stored reusable key remains available for stale-state reauthentication.
      const safeExistingKey = "stored-auth-placeholder";
      const res1 = await ensureRouterAuthKey({
        client,
        existingKey: safeExistingKey,
        routerTag: "tag:docker",
        hostname: "router",
        hasLocalState: false,
      });
      expect(res1.generated).toBe(false);
      expect(res1.authKey).toBe(safeExistingKey);

      // Missing stored credentials generates a replacement even with state present.
      const res2 = await ensureRouterAuthKey({
        client,
        existingKey: undefined,
        routerTag: "tag:docker",
        hostname: "router",
        hasLocalState: true,
      });
      expect(res2.generated).toBe(true);
      expect(res2.needed).toBe(true);
      expect(res2.authKey).toBe("fresh-auth-key");

      // Rotation writes a new key while explicitly preserving state.
      const res3 = await ensureRouterAuthKey({
        client,
        existingKey: safeExistingKey,
        routerTag: "tag:docker",
        hostname: "router",
        hasLocalState: true,
        forceRotate: true,
      });
      expect(res3.generated).toBe(true);
      expect(res3.needed).toBe(true);
      expect(res3.authKey).toBe("fresh-auth-key");
      expect(res3.warning).toContain("Existing Tailscale state is preserved");
      expect(keysCreated).toBe(2);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("route verification marks advertised-but-unapproved as failed", async () => {
    const { verifyDeviceRoutes } = await import("./verify");
    const routerDev = {
      advertisedRoutes: ["10.128.64.0/24"],
      enabledRoutes: [], // Advertised, but not approved!
    };

    const results = verifyDeviceRoutes(routerDev, ["10.128.64.0/24"]);
    expect(results[0]?.passed).toBe(false);
    expect(results[0]?.message).toContain("pending approval in Tailscale ACL");

    const approvedDev = {
      advertisedRoutes: ["10.128.64.0/24"],
      enabledRoutes: ["10.128.64.0/24"],
    };
    const approvedResults = verifyDeviceRoutes(approvedDev, ["10.128.64.0/24"]);
    expect(approvedResults[0]?.passed).toBe(true);
    expect(approvedResults[0]?.message).toContain("approved and active");
  });

  test("pollRouterDeviceAndRoutes polls and resolves router status", async () => {
    const { pollRouterDeviceAndRoutes } = await import("./verify");
    let callCount = 0;
    const fakeClient = {
      getDevices: async () => {
        callCount++;
        if (callCount === 1) {
          return [
            {
              id: "dev-1",
              name: "router.tailnet.ts.net",
              hostname: "router",
              tags: ["tag:docker"],
              advertisedRoutes: ["10.128.64.0/24"],
              enabledRoutes: [],
            },
          ];
        }
        return [
          {
            id: "dev-1",
            name: "router.tailnet.ts.net",
            hostname: "router",
            tags: ["tag:docker"],
            advertisedRoutes: ["10.128.64.0/24"],
            enabledRoutes: ["10.128.64.0/24"],
          },
        ];
      },
    } as any;

    const res = await pollRouterDeviceAndRoutes({
      apiClient: fakeClient,
      tsHostname: "router",
      routerTag: "tag:docker",
      routesToCheck: ["10.128.64.0/24"],
      timeoutMs: 500,
      intervalMs: 10,
    });

    expect(res.deviceFound).toBe(true);
    expect(res.tagMatched).toBe(true);
    expect(res.routeResults.every((r) => r.passed)).toBe(true);
    expect(callCount).toBe(2);
  });

  test("pollRouterDeviceAndRoutes preserves API error context on failure", async () => {
    const { pollRouterDeviceAndRoutes } = await import("./verify");
    const errorClient = {
      getDevices: async () => {
        throw new Error("Tailscale API 401 Unauthorized: Invalid API token");
      },
    } as any;

    const res = await pollRouterDeviceAndRoutes({
      apiClient: errorClient,
      tsHostname: "router",
      routerTag: "tag:docker",
      routesToCheck: ["10.128.64.0/24"],
      timeoutMs: 50,
      intervalMs: 10,
    });

    expect(res.deviceFound).toBe(false);
    expect(res.lastApiError?.message).toContain("401 Unauthorized");
  });

  test("policy write does not occur when policy validation fails", async () => {
    let setPolicyCalled = false;
    const mockFetch = async (url: string | URL | Request, init?: RequestInit) => {
      const urlStr = String(url);
      if (urlStr.endsWith("/acl/validate")) {
        return new Response(
          JSON.stringify({ message: "Invalid route auto-approver syntax" }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (urlStr.endsWith("/acl") && init?.method === "POST") {
        setPolicyCalled = true;
        return new Response("{}", { status: 200 });
      }
      return new Response("{}", { status: 200 });
    };

    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetch as any;
    try {
      const { TailscaleApiClient } = await import("./tailscale-api");
      const { reconcileTailscalePolicy } = await import("./tailscale");
      const client = new TailscaleApiClient("mock-api-test-token");

      let errorThrown = false;
      try {
        await reconcileTailscalePolicy({
          client,
          currentPolicy: {},
          routerTag: "tag:docker",
          routedSubnet: "10.128.64.0/24",
        });
      } catch (e) {
        errorThrown = true;
        expect((e as Error).message).toContain("policy validation failed");
      }

      expect(errorThrown).toBe(true);
      expect(setPolicyCalled).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("sanitizes API token from error messages", async () => {
    const secret = "mock-api-secret-12345";
    const mockFetch = async () => {
      return new Response(`Error involving token ${secret}`, { status: 403 });
    };

    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetch as any;
    try {
      const { TailscaleApiClient } = await import("./tailscale-api");
      const client = new TailscaleApiClient(secret);

      try {
        await client.getDevices();
        expect(true).toBe(false); // Should not reach
      } catch (e) {
        const msg = (e as Error).message;
        expect(msg).not.toContain(secret);
        expect(msg).toContain("[REDACTED_API_TOKEN]");
      }
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("Docker & state discovery semantics", () => {
  test("hasLocalTailscaleState inspects volume state file and handles absence/presence", async () => {
    const { hasLocalTailscaleState } = await import("./docker");
    const originalSpawn = Bun.spawn;
    try {
      // 1. Volume missing -> returns false
      Bun.spawn = ((cmd: string[]) => {
        if (cmd[1] === "volume") {
          return { exited: Promise.resolve(1), stdout: new Response(""), stderr: new Response("") };
        }
        return { exited: Promise.resolve(0), stdout: new Response(""), stderr: new Response("") };
      }) as any;
      expect(await hasLocalTailscaleState()).toBe(false);

      // 2. Volume exists, state file present in container -> returns true
      Bun.spawn = ((cmd: string[]) => {
        if (cmd[1] === "volume") {
          return {
            exited: Promise.resolve(0),
            stdout: new Response(JSON.stringify([{ Mountpoint: "/nonexistent-path-force-container-check" }])),
            stderr: new Response(""),
          };
        }
        if (cmd[1] === "run") {
          return { exited: Promise.resolve(0), stdout: new Response(""), stderr: new Response("") };
        }
        return { exited: Promise.resolve(0), stdout: new Response(""), stderr: new Response("") };
      }) as any;
      expect(await hasLocalTailscaleState()).toBe(true);

      // 3. Volume exists, state file missing in container -> returns false
      Bun.spawn = ((cmd: string[]) => {
        if (cmd[1] === "volume") {
          return {
            exited: Promise.resolve(0),
            stdout: new Response(JSON.stringify([{ Mountpoint: "/nonexistent-path-force-container-check" }])),
            stderr: new Response(""),
          };
        }
        if (cmd[1] === "run") {
          return { exited: Promise.resolve(1), stdout: new Response(""), stderr: new Response("") };
        }
        return { exited: Promise.resolve(0), stdout: new Response(""), stderr: new Response("") };
      }) as any;
      expect(await hasLocalTailscaleState()).toBe(false);

      // 4. In dry-run mode, skips docker run completely
      let dockerRunCalled = false;
      Bun.spawn = ((cmd: string[]) => {
        if (cmd[1] === "volume") {
          return {
            exited: Promise.resolve(0),
            stdout: new Response(JSON.stringify([{ Mountpoint: "/nonexistent-path-force-container-check" }])),
            stderr: new Response(""),
          };
        }
        if (cmd[1] === "run") {
          dockerRunCalled = true;
          return { exited: Promise.resolve(0), stdout: new Response(""), stderr: new Response("") };
        }
        return { exited: Promise.resolve(0), stdout: new Response(""), stderr: new Response("") };
      }) as any;
      expect(await hasLocalTailscaleState("tailscale:image", true)).toBe(false);
      expect(dockerRunCalled).toBe(false);
    } finally {
      Bun.spawn = originalSpawn;
    }
  });
});

describe("Split DNS prerequisites and gating", () => {
  const basePrereqs: SplitDnsPrerequisites = {
    servicesHealthy: true,
    routerFound: true,
    routerTagMatched: true,
    routesApproved: true,
    tsHostname: "ts-docker-test",
    routerTag: "tag:docker-router",
    routedSubnet: "10.128.64.0/24",
  };

  test("assertSplitDnsPrerequisites passes when all conditions are met", () => {
    expect(() => assertSplitDnsPrerequisites(basePrereqs)).not.toThrow();
  });

  test("assertSplitDnsPrerequisites throws when services are unhealthy and preserves existing split DNS", () => {
    expect(() =>
      assertSplitDnsPrerequisites({
        ...basePrereqs,
        servicesHealthy: false,
        unhealthyDetails: "CoreDNS unhealthy",
      }),
    ).toThrow(/CoreDNS or Traefik services are not healthy/);
  });

  test("assertSplitDnsPrerequisites throws when router device is not found on tailnet", () => {
    expect(() =>
      assertSplitDnsPrerequisites({
        ...basePrereqs,
        routerFound: false,
        apiError: new Error("Device offline or unregistered"),
      }),
    ).toThrow(/router device 'ts-docker-test' was not found on Tailnet/);
  });

  test("assertSplitDnsPrerequisites throws when router tag does not match", () => {
    expect(() =>
      assertSplitDnsPrerequisites({
        ...basePrereqs,
        routerTagMatched: false,
      }),
    ).toThrow(/missing required tag 'tag:docker-router'/);
  });

  test("assertSplitDnsPrerequisites throws when ingress route is not approved in Tailscale ACL", () => {
    expect(() =>
      assertSplitDnsPrerequisites({
        ...basePrereqs,
        routesApproved: false,
        unapprovedRouteDetails: "Route 10.128.64.0/24 pending approval in tailnet admin console",
      }),
    ).toThrow(/Ingress route '10.128.64.0\/24' is not approved\/active/);
  });

  test("proves split DNS write is never called when prerequisites fail", async () => {
    let updateSplitDnsCalled = false;
    const mockApiClient: any = {
      updateSplitDns: async () => {
        updateSplitDnsCalled = true;
      },
    };

    // Scenario: route unapproved
    const prereqs: SplitDnsPrerequisites = {
      ...basePrereqs,
      routesApproved: false,
      unapprovedRouteDetails: "Route pending approval",
    };

    let caughtError: Error | null = null;
    try {
      assertSplitDnsPrerequisites(prereqs);
      // If assert doesn't throw, this would run:
      await reconcileSplitDns({
        client: mockApiClient,
        currentSplitDns: {},
        dnsZone: "example.ts.net",
        dnsResolverIp: "10.128.64.10",
        forceReplace: false,
        dryRun: false,
      });
    } catch (err: any) {
      caughtError = err;
    }

    expect(caughtError).not.toBeNull();
    expect(caughtError?.message).toContain("Ingress route '10.128.64.0/24' is not approved/active");
    expect(updateSplitDnsCalled).toBe(false);
  });
});
