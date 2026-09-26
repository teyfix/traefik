import { describe, expect, test } from "bun:test";
import { readFileSync, statSync } from "node:fs";
import { mkdtemp, readFile, rm, unlink } from "node:fs/promises";
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
import {
  assertLocalRoutePriorityAvailable,
  ensureLocalIngressRoutePreference,
  LEGACY_LOCAL_INGRESS_ROUTE_PRIORITY,
  LOCAL_INGRESS_ROUTE_PRIORITY,
  managedLocalIngressRouteUnitSubnet,
  renderLocalIngressRouteService,
} from "./host";
import { DEFAULT_SERVICE_HEALTH_TIMEOUT_MS } from "./traefik";
import { getTraefikServicesStatus, startTraefikStack } from "./traefik";
import { exportCertsFromContainer } from "./certificates";
import {
  DEFAULT_ROUTE_READINESS_TIMEOUT_MS,
  inspectLocalIngressRouteReadiness,
} from "./verify";
import {
  assertRouterIdentityPreflight,
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

  test("renders an idempotent persistent rule that prefers only the local ingress route", () => {
    const unit = renderLocalIngressRouteService("10.128.0.0/24");
    const exactRule = `pref ${LOCAL_INGRESS_ROUTE_PRIORITY} to 10.128.0.0/24 lookup main`;

    expect(unit).toContain(`ip -4 rule del ${exactRule}`);
    expect(unit).toContain(`ip -4 rule add ${exactRule} suppress_prefixlength 0`);
    expect(unit).toContain("if ip -4 rule show | grep -Eq");
    expect(unit.indexOf("if ip -4 rule show")).toBeLessThan(
      unit.indexOf(`ip -4 rule del ${exactRule}`),
    );
    expect(unit).toContain("RemainAfterExit=yes");
    expect(unit).toContain("WantedBy=multi-user.target");
    expect(unit).not.toContain("accept-routes");

    const alreadyInstalled =
      `${LOCAL_INGRESS_ROUTE_PRIORITY}: from all to 10.128.0.0/24 lookup main suppress_prefixlength 0\n`;
    expect(() =>
      assertLocalRoutePriorityAvailable(alreadyInstalled, "10.128.0.0/24"),
    ).not.toThrow();
    expect(() =>
      assertLocalRoutePriorityAvailable(
        `${LOCAL_INGRESS_ROUTE_PRIORITY}: from all lookup 123\n`,
        "10.128.0.0/24",
      ),
    ).toThrow(/priority 2500 is already used/);
    for (const unexpectedRule of [
      `${LOCAL_INGRESS_ROUTE_PRIORITY}: from all to 10.128.0.0/24 lookup main suppress_prefixlength 1`,
      `${LOCAL_INGRESS_ROUTE_PRIORITY}: from all to 10.128.0.0/24 fwmark 0x1 lookup main`,
      `${LOCAL_INGRESS_ROUTE_PRIORITY}: from all to 10.128.0.0/24 iif eth0 lookup main`,
    ]) {
      expect(() =>
        assertLocalRoutePriorityAvailable(unexpectedRule, "10.128.0.0/24"),
      ).toThrow(/priority 2500 is already used/);
    }
  });

  test("changing ingress subnets stops and cleans the old managed rule before reinstall", async () => {
    const tempDirectory = await mkdtemp(join(tmpdir(), "test-route-unit-"));
    const unitPath = join(tempDirectory, "traefik-ingress-route.service");
    const commands: string[][] = [];
    try {
      await Bun.write(unitPath, renderLocalIngressRouteService("10.10.10.0/24"));
      let ipRuleRead = 0;
      await ensureLocalIngressRoutePreference("10.128.0.0/24", false, {
        unitPath,
        getServiceState: async () => ({ enabled: true, active: true }),
        runCommand: async (command) => {
          commands.push(command);
          if (command[0] !== "ip") return "";
          ipRuleRead += 1;
          return ipRuleRead === 1
            ? "2500: from all to 10.10.10.0/24 lookup main suppress_prefixlength 0\n"
            : "2500: from all to 10.128.0.0/24 lookup main suppress_prefixlength 0\n";
        },
      });

      expect(commands[0]).toEqual(["ip", "-4", "rule", "show"]);
      expect(commands[1]).toEqual([
        "sudo", "systemctl", "stop", "traefik-ingress-route.service",
      ]);
      expect(commands[2]?.join(" ")).toContain(
        "rule del pref 2500 to 10.10.10.0/24 lookup main",
      );
      expect(commands.some((command) => command.includes("install"))).toBe(true);
      expect(commands.some((command) => command.includes("daemon-reload"))).toBe(true);
      expect(commands.at(-2)).toEqual([
        "sudo", "systemctl", "enable", "--now", "traefik-ingress-route.service",
      ]);
      expect(commands.at(-1)).toEqual(["ip", "-4", "rule", "show"]);
    } finally {
      await rm(tempDirectory, { recursive: true, force: true });
    }
  });

  test("verifies priority 2500 before removing the exact temporary priority 5200 rule", async () => {
    const tempDirectory = await mkdtemp(join(tmpdir(), "test-route-migration-"));
    const unitPath = join(tempDirectory, "traefik-ingress-route.service");
    const commands: string[][] = [];
    try {
      let ipRuleRead = 0;
      await ensureLocalIngressRoutePreference("10.128.0.0/24", false, {
        unitPath,
        runCommand: async (command) => {
          commands.push(command);
          if (command[0] !== "ip") return "";
          ipRuleRead += 1;
          const legacy =
            `${LEGACY_LOCAL_INGRESS_ROUTE_PRIORITY}: from all to 10.128.0.0/24 lookup main suppress_prefixlength 0\n`;
          return ipRuleRead === 1
            ? legacy
            : `2500: from all to 10.128.0.0/24 lookup main suppress_prefixlength 0\n${legacy}`;
        },
      });

      const enableIndex = commands.findIndex((command) => command.includes("enable"));
      const verifyIndex = commands.findIndex(
        (command, index) => index > enableIndex && command[0] === "ip",
      );
      const cleanupIndex = commands.findIndex((command) =>
        command.join(" ").includes("rule del pref 5200 to 10.128.0.0/24 lookup main"),
      );
      expect(enableIndex).toBeGreaterThan(-1);
      expect(verifyIndex).toBeGreaterThan(enableIndex);
      expect(cleanupIndex).toBeGreaterThan(verifyIndex);
    } finally {
      await rm(tempDirectory, { recursive: true, force: true });
    }
  });

  test("adopts the exact a6df8e4 unit and active rule without a delete/add gap", async () => {
    const tempDirectory = await mkdtemp(join(tmpdir(), "test-route-adoption-"));
    const unitPath = join(tempDirectory, "traefik-ingress-route.service");
    const subnet = "10.128.0.0/24";
    const previousUnit = renderLocalIngressRouteService(subnet).replace(
      "# Managed by Traefik onboarding; validate ownership before removal.\n",
      "",
    );
    const commands: string[][] = [];
    try {
      await Bun.write(unitPath, previousUnit);
      await ensureLocalIngressRoutePreference(subnet, false, {
        unitPath,
        getServiceState: async () => {
          throw new Error("same-subnet adoption must not inspect state for a stop");
        },
        runCommand: async (command) => {
          commands.push(command);
          if (command[0] === "ip") {
            return `2500: from all to ${subnet} lookup main suppress_prefixlength 0\n`;
          }
          return "";
        },
      });

      expect(managedLocalIngressRouteUnitSubnet(previousUnit)).toBe(subnet);
      expect(commands.some((command) => command.includes("stop"))).toBe(false);
      expect(commands.some((command) => command.join(" ").includes("ip -4 rule del"))).toBe(false);
      expect(commands.some((command) => command.includes("install"))).toBe(true);
    } finally {
      await rm(tempDirectory, { recursive: true, force: true });
    }
  });

  test.each(["install", "daemon-reload", "enable", "verification"])(
    "restores the previous unit, rule, and service state after %s failure",
    async (failureStage) => {
      const tempDirectory = await mkdtemp(join(tmpdir(), "test-route-rollback-"));
      const unitPath = join(tempDirectory, "traefik-ingress-route.service");
      const oldSubnet = "10.10.10.0/24";
      const newSubnet = "10.128.0.0/24";
      const oldUnit = renderLocalIngressRouteService(oldSubnet);
      let currentRule = oldSubnet;
      let injected = false;
      try {
        await Bun.write(unitPath, oldUnit);
        await expect(ensureLocalIngressRoutePreference(newSubnet, false, {
          unitPath,
          getServiceState: async () => ({ enabled: true, active: true }),
          runCommand: async (command) => {
            const joined = command.join(" ");
            if (command[0] === "ip") {
              if (failureStage === "verification" && !injected && currentRule === newSubnet) {
                injected = true;
                return "";
              }
              return currentRule
                ? `2500: from all to ${currentRule} lookup main suppress_prefixlength 0\n`
                : "";
            }
            if (joined.includes("systemctl stop")) currentRule = "";
            if (command.includes("install")) {
              if (failureStage === "install" && !injected) {
                injected = true;
                throw new Error("injected install failure");
              }
              await Bun.write(unitPath, await readFile(command[4]!, "utf-8"));
            }
            if (joined.includes("daemon-reload") && failureStage === "daemon-reload" && !injected) {
              injected = true;
              throw new Error("injected daemon-reload failure");
            }
            if (joined.includes("enable --now")) {
              if (failureStage === "enable" && !injected) {
                injected = true;
                throw new Error("injected enable failure");
              }
              currentRule = managedLocalIngressRouteUnitSubnet(await readFile(unitPath, "utf-8")) || "";
            }
            if (joined.includes("systemctl start")) {
              currentRule = managedLocalIngressRouteUnitSubnet(await readFile(unitPath, "utf-8")) || "";
            }
            return "";
          },
        })).rejects.toThrow(/previous unit and route.*were restored/);

        expect(await readFile(unitPath, "utf-8")).toBe(oldUnit);
        expect(currentRule).toBe(oldSubnet);
      } finally {
        await rm(tempDirectory, { recursive: true, force: true });
      }
    },
  );

  test("restores a previously disabled and inactive unit without activating it", async () => {
    const tempDirectory = await mkdtemp(join(tmpdir(), "test-route-inactive-rollback-"));
    const unitPath = join(tempDirectory, "traefik-ingress-route.service");
    const oldUnit = renderLocalIngressRouteService("10.10.10.0/24");
    const commands: string[][] = [];
    try {
      await Bun.write(unitPath, oldUnit);
      await expect(ensureLocalIngressRoutePreference("10.128.0.0/24", false, {
        unitPath,
        getServiceState: async () => ({ enabled: false, active: false }),
        runCommand: async (command) => {
          commands.push(command);
          if (command[0] === "ip") return "";
          if (command.includes("install")) {
            await Bun.write(unitPath, await readFile(command[4]!, "utf-8"));
          }
          if (command.join(" ").includes("enable --now")) {
            throw new Error("injected enable failure");
          }
          return "";
        },
      })).rejects.toThrow(/previous unit and route.*were restored/);

      expect(await readFile(unitPath, "utf-8")).toBe(oldUnit);
      expect(commands.some((command) => command.join(" ").includes("systemctl disable"))).toBe(true);
      expect(commands.some((command) => command.join(" ").includes("systemctl start"))).toBe(false);
    } finally {
      await rm(tempDirectory, { recursive: true, force: true });
    }
  });

  test("fails before mutation when an inactive old unit has a manual exact rule", async () => {
    const tempDirectory = await mkdtemp(join(tmpdir(), "test-route-ambiguous-"));
    const unitPath = join(tempDirectory, "traefik-ingress-route.service");
    const commands: string[][] = [];
    try {
      await Bun.write(unitPath, renderLocalIngressRouteService("10.10.10.0/24"));
      await expect(ensureLocalIngressRoutePreference("10.128.0.0/24", false, {
        unitPath,
        getServiceState: async () => ({ enabled: false, active: false }),
        runCommand: async (command) => {
          commands.push(command);
          return command[0] === "ip"
            ? "2500: from all to 10.10.10.0/24 lookup main suppress_prefixlength 0\n"
            : "";
        },
      })).rejects.toThrow(/ambiguous state/);
      expect(commands).toEqual([["ip", "-4", "rule", "show"]]);
    } finally {
      await rm(tempDirectory, { recursive: true, force: true });
    }
  });

  test("does not attempt replacement or rollback after the initial old-unit stop fails", async () => {
    const tempDirectory = await mkdtemp(join(tmpdir(), "test-route-stop-failure-"));
    const unitPath = join(tempDirectory, "traefik-ingress-route.service");
    const oldUnit = renderLocalIngressRouteService("10.10.10.0/24");
    const commands: string[][] = [];
    try {
      await Bun.write(unitPath, oldUnit);
      await expect(ensureLocalIngressRoutePreference("10.128.0.0/24", false, {
        unitPath,
        getServiceState: async () => ({ enabled: true, active: true }),
        runCommand: async (command) => {
          commands.push(command);
          if (command[0] === "ip") {
            return "2500: from all to 10.10.10.0/24 lookup main suppress_prefixlength 0\n";
          }
          if (command.join(" ").includes("systemctl stop")) {
            throw new Error("injected stop failure");
          }
          return "";
        },
      })).rejects.toThrow("injected stop failure");
      expect(await readFile(unitPath, "utf-8")).toBe(oldUnit);
      expect(commands).toEqual([
        ["ip", "-4", "rule", "show"],
        ["sudo", "systemctl", "stop", "traefik-ingress-route.service"],
      ]);
    } finally {
      await rm(tempDirectory, { recursive: true, force: true });
    }
  });

  test("refuses to overwrite a same-named systemd unit it does not own", async () => {
    const tempDirectory = await mkdtemp(join(tmpdir(), "test-foreign-route-unit-"));
    const unitPath = join(tempDirectory, "traefik-ingress-route.service");
    let commandCalled = false;
    try {
      await Bun.write(unitPath, "[Service]\nExecStart=/usr/local/bin/custom-route-manager\n");
      await expect(
        ensureLocalIngressRoutePreference("10.128.0.0/24", false, {
          unitPath,
          runCommand: async () => {
            commandCalled = true;
            return "";
          },
        }),
      ).rejects.toThrow(/Refusing to overwrite unrecognized systemd unit/);
      expect(commandCalled).toBe(false);
    } finally {
      await rm(tempDirectory, { recursive: true, force: true });
    }
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

  test("all Compose subprocesses receive fresh env values instead of stale startup values", async () => {
    const tempDirectory = await mkdtemp(join(tmpdir(), "test-compose-env-"));
    const envPath = join(tempDirectory, ".env");
    const originalSpawn = Bun.spawn;
    const originalValues = {
      TS_INGRESS_SUBNET: process.env.TS_INGRESS_SUBNET,
      TS_ROUTES: process.env.TS_ROUTES,
      TS_DNS_SERVER: process.env.TS_DNS_SERVER,
      TRAEFIK_IP: process.env.TRAEFIK_IP,
      TS_API_TOKEN: process.env.TS_API_TOKEN,
    };
    const composeCalls: Array<{ command: string[]; env?: Record<string, string> }> = [];
    const envUpdates = {
      TS_INGRESS_SUBNET: "10.128.0.0/24",
      TS_ROUTES: "10.128.0.0/24",
      TS_DNS_SERVER: "10.128.0.10",
      TRAEFIK_IP: "10.128.0.2",
    };

    try {
      process.env.TS_INGRESS_SUBNET = "10.10.10.0/24";
      process.env.TS_ROUTES = "10.10.10.0/24";
      process.env.TS_DNS_SERVER = "10.10.10.10";
      process.env.TRAEFIK_IP = "10.10.10.2";
      process.env.TS_API_TOKEN = "transient-api-token-must-not-reach-compose";
      await Bun.write(
        envPath,
        "TS_INGRESS_SUBNET=10.10.10.0/24\nTS_ROUTES=10.10.10.0/24\nTS_DNS_SERVER=10.10.10.10\nTRAEFIK_IP=10.10.10.2\n",
      );
      await mergeEnvFile(envPath, envUpdates);

      Bun.spawn = ((command: string[], options?: { env?: Record<string, string> }) => {
        composeCalls.push({ command, env: options?.env });
        const stdout = command.includes("ps") ? "[]" : "";
        return {
          exited: Promise.resolve(0),
          stdout: new Response(stdout),
          stderr: new Response(""),
        };
      }) as unknown as typeof Bun.spawn;

      await startTraefikStack(tempDirectory, false, envUpdates);
      await getTraefikServicesStatus(tempDirectory, envUpdates);
      await exportCertsFromContainer(tempDirectory, envUpdates);

      expect(composeCalls.map((call) => call.command.slice(0, 3))).toEqual([
        ["docker", "compose", "up"],
        ["docker", "compose", "ps"],
        ["docker", "compose", "exec"],
        ["docker", "compose", "cp"],
      ]);
      for (const call of composeCalls) {
        expect(call.env?.TS_INGRESS_SUBNET).toBe("10.128.0.0/24");
        expect(call.env?.TS_ROUTES).toBe("10.128.0.0/24");
        expect(call.env?.TS_DNS_SERVER).toBe("10.128.0.10");
        expect(call.env?.TRAEFIK_IP).toBe("10.128.0.2");
        expect(call.env?.TS_API_TOKEN).toBeUndefined();
      }

      const writtenEnv = parseEnv(await Bun.file(envPath).text());
      expect(writtenEnv).toMatchObject(envUpdates);
      expect(writtenEnv.TS_API_TOKEN).toBeUndefined();
    } finally {
      Bun.spawn = originalSpawn;
      for (const [key, value] of Object.entries(originalValues)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      await rm(tempDirectory, { recursive: true, force: true });
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
              isEphemeral: true,
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
      expect(devices[0]?.isEphemeral).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("getDevices preserves false and missing isEphemeral API values", async () => {
    const mockFetch = async () =>
      new Response(
        JSON.stringify({
          devices: [
            { id: "old", name: "router-old", hostname: "router-old", isEphemeral: false },
            { id: "unknown", name: "router-unknown", hostname: "router-unknown" },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );

    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetch as any;
    try {
      const { TailscaleApiClient } = await import("./tailscale-api");
      const devices = await new TailscaleApiClient("mock-token").getDevices();
      expect(devices[0]?.isEphemeral).toBe(false);
      expect(devices[1]?.isEphemeral).toBeUndefined();
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

      const duplicateDevices = [
        {
          id: "old-persistent",
          name: "my-router.tailnet.ts.net",
          hostname: "my-router",
          isEphemeral: false,
          tags: ["tag:docker"],
        },
        {
          id: "new-ephemeral",
          name: "my-router.tailnet.ts.net",
          hostname: "my-router",
          isEphemeral: true,
          tags: ["tag:docker"],
        },
      ];
      expect(findRouterDevice(duplicateDevices as any, "my-router", "tag:docker")?.id).toBe("new-ephemeral");

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

  test("route verification rejects an enabled-only stale expected route", async () => {
    const { verifyDeviceRoutes } = await import("./verify");
    const results = verifyDeviceRoutes(
      { advertisedRoutes: [], enabledRoutes: ["10.128.0.0/24"] },
      ["10.128.0.0/24"],
    );
    expect(results[0]?.passed).toBe(false);
    expect(results[0]?.message).toContain("approved but no longer advertised");
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
              isEphemeral: true,
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
            isEphemeral: true,
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
    expect(res.routerIsEphemeral).toBe(true);
    expect(res.tagMatched).toBe(true);
    expect(res.routeResults.every((r) => r.passed)).toBe(true);
    expect(callCount).toBe(2);
  });

  test.each([
    ["non-ephemeral", false],
    ["missing ephemeral status", undefined],
  ])("pollRouterDeviceAndRoutes rejects %s router identity", async (_label, isEphemeral) => {
    const { pollRouterDeviceAndRoutes } = await import("./verify");
    const fakeClient = {
      getDevices: async () => [
        {
          id: "dev-1",
          name: "router.tailnet.ts.net",
          hostname: "router",
          isEphemeral,
          tags: ["tag:docker"],
          advertisedRoutes: ["10.128.64.0/24"],
          enabledRoutes: ["10.128.64.0/24"],
        },
      ],
    } as any;

    const res = await pollRouterDeviceAndRoutes({
      apiClient: fakeClient,
      tsHostname: "router",
      routerTag: "tag:docker",
      routesToCheck: ["10.128.64.0/24"],
      timeoutMs: 0,
      intervalMs: 1,
    });

    expect(res.deviceFound).toBe(true);
    expect(res.routerIsEphemeral).toBe(isEphemeral);
    expect(res.tagMatched).toBe(true);
    expect(res.routeResults.every((result) => result.passed)).toBe(true);
  });

  test("pollRouterDeviceAndRoutes inspects once at zero timeout even if the clock advances", async () => {
    const { pollRouterDeviceAndRoutes } = await import("./verify");
    const originalNow = Date.now;
    let tick = 0;
    let calls = 0;
    try {
      Date.now = () => tick++;
      const res = await pollRouterDeviceAndRoutes({
        apiClient: {
          getDevices: async () => {
            calls++;
            return [{ id: "dev-1", hostname: "router", tags: ["tag:docker"], isEphemeral: false }];
          },
        } as any,
        tsHostname: "router",
        routerTag: "tag:docker",
        routesToCheck: ["10.128.0.0/24"],
        timeoutMs: 0,
        intervalMs: 1,
      });
      expect(calls).toBe(1);
      expect(res.deviceFound).toBe(true);
      expect(res.routerIsEphemeral).toBe(false);
    } finally {
      Date.now = originalNow;
    }
  });

  test("pollRouterDeviceAndRoutes reports extra advertised and enabled router routes", async () => {
    const { pollRouterDeviceAndRoutes } = await import("./verify");
    const fakeClient = {
      getDevices: async () => [
        {
          id: "dev-1",
          name: "router.tailnet.ts.net",
          hostname: "router",
          isEphemeral: true,
          tags: ["tag:docker"],
          advertisedRoutes: ["10.128.0.0/24", "172.19.0.0/16"],
          enabledRoutes: ["10.128.0.0/24", "10.10.10.0/24"],
        },
      ],
    } as any;

    const res = await pollRouterDeviceAndRoutes({
      apiClient: fakeClient,
      tsHostname: "router",
      routerTag: "tag:docker",
      routesToCheck: ["10.128.0.0/24"],
      timeoutMs: 0,
      intervalMs: 1,
    });

    expect(res.routeResults.every((result) => result.passed)).toBe(true);
    expect(res.unexpectedRoutes).toEqual(["172.19.0.0/16", "10.10.10.0/24"]);
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

describe("Local ingress route readiness", () => {
  const network = {
    name: "traefik_ingress",
    id: "1234567890abcdef1234567890abcdef",
    driver: "bridge",
    subnets: ["10.128.64.0/24"],
    labels: {
      "com.docker.compose.project": "traefik",
      "com.docker.compose.network": "ingress",
    },
  };
  const bridge = "br-1234567890ab";

  test("requires the exact main-table route and effective bridge/source for both endpoints", async () => {
    const result = await inspectLocalIngressRouteReadiness({
      routedSubnet: "10.128.64.0/24",
      dnsResolverIp: "10.128.64.10",
      traefikIp: "10.128.64.2",
      networks: [network],
      runCommand: async (command) => command.includes("show")
        ? JSON.stringify([{
          dst: "10.128.64.0/24",
          dev: bridge,
          protocol: "kernel",
          scope: "link",
          prefsrc: "10.128.64.1",
        }])
        : JSON.stringify([{
          dst: command.at(-1),
          dev: bridge,
          prefsrc: "10.128.64.1",
        }]),
    });
    expect(result.ready).toBe(true);
  });

  test.each([
    ["connected route on a different bridge", "connected", "br-deadbeef0000", "10.128.64.1"],
    ["DNS route through tailscale", "10.128.64.10", "tailscale0", "100.64.0.1"],
    ["Traefik route with an outside source", "10.128.64.2", bridge, "192.168.1.2"],
  ])("fails closed for %s", async (_label, failingTarget, dev, source) => {
    const result = await inspectLocalIngressRouteReadiness({
      routedSubnet: "10.128.64.0/24",
      dnsResolverIp: "10.128.64.10",
      traefikIp: "10.128.64.2",
      networks: [network],
      runCommand: async (command) => {
        if (command.includes("show")) {
          return JSON.stringify([{
            dst: "10.128.64.0/24",
            dev: failingTarget === "connected" ? dev : bridge,
            protocol: "kernel",
            scope: "link",
            prefsrc: "10.128.64.1",
          }]);
        }
        const destination = command.at(-1);
        return JSON.stringify([{
          dst: destination,
          dev: destination === failingTarget ? dev : bridge,
          prefsrc: destination === failingTarget ? source : "10.128.64.1",
        }]);
      },
    });
    expect(result.ready).toBe(false);
  });

  test("rejects a same-named bridge without exact Compose ownership labels", async () => {
    const result = await inspectLocalIngressRouteReadiness({
      routedSubnet: "10.128.64.0/24",
      dnsResolverIp: "10.128.64.10",
      traefikIp: "10.128.64.2",
      networks: [{ ...network, labels: {} }],
      runCommand: async () => { throw new Error("route commands must not run"); },
    });
    expect(result.ready).toBe(false);
    expect(result.details).toContain("Compose-owned");
  });
});

describe("Split DNS prerequisites and gating", () => {
  const basePrereqs: SplitDnsPrerequisites = {
    servicesHealthy: true,
    localIngressRouteReady: true,
    routerFound: true,
    routerIsEphemeral: true,
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

  test.each([
    "main table lacks the exact connected ingress route",
    "effective DNS route selected tailscale0",
    "effective Traefik route source is outside ingress /24",
  ])("proves route failure prevents a split DNS write: %s", async (failureDetails) => {
    let updateSplitDnsCalled = false;
    const mockApiClient: any = {
      updateSplitDns: async () => { updateSplitDnsCalled = true; },
    };
    try {
      assertSplitDnsPrerequisites({
        ...basePrereqs,
        localIngressRouteReady: false,
        localIngressRouteDetails: failureDetails,
      });
      await reconcileSplitDns({
        client: mockApiClient,
        currentSplitDns: {},
        dnsZone: "example.ts.net",
        dnsResolverIp: "10.128.64.10",
        forceReplace: false,
      });
    } catch (error) {
      expect((error as Error).message).toContain("local ingress route readiness failed");
      expect((error as Error).message).toContain(failureDetails);
    }
    expect(updateSplitDnsCalled).toBe(false);
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

  test("assertSplitDnsPrerequisites rejects a non-ephemeral router with migration boundaries", () => {
    expect(() =>
      assertSplitDnsPrerequisites({
        ...basePrereqs,
        routerIsEphemeral: false,
      }),
    ).toThrow(/back up the task-owned 'traefik_tailscale' state volume/);

    expect(() =>
      assertSplitDnsPrerequisites({
        ...basePrereqs,
        routerIsEphemeral: false,
      }),
    ).toThrow(/Do not change CA\/ACME state, traefik_proxy, or application backends/);
  });

  test("assertSplitDnsPrerequisites rejects missing ephemeral status", () => {
    expect(() =>
      assertSplitDnsPrerequisites({
        ...basePrereqs,
        routerIsEphemeral: undefined,
      }),
    ).toThrow(/did not confirm.*is ephemeral/);
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

  test("assertSplitDnsPrerequisites rejects extra legacy routes on the selected router", () => {
    expect(() =>
      assertSplitDnsPrerequisites({
        ...basePrereqs,
        unexpectedRouterRoutes: ["10.10.10.0/24", "172.19.0.0/16"],
      }),
    ).toThrow(/still advertises or enables unexpected route.*10\.10\.10\.0\/24.*172\.19\.0\.0\/16/);
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

  test.each([
    ["non-ephemeral", false],
    ["missing ephemeral status", undefined],
  ])("preserves split DNS for a %s router", async (_label, routerIsEphemeral) => {
    let updateSplitDnsCalled = false;
    const mockApiClient: any = {
      updateSplitDns: async () => {
        updateSplitDnsCalled = true;
      },
    };

    try {
      assertSplitDnsPrerequisites({ ...basePrereqs, routerIsEphemeral });
      await reconcileSplitDns({
        client: mockApiClient,
        currentSplitDns: { "example.ts.net": ["10.128.64.20"] },
        dnsZone: "example.ts.net",
        dnsResolverIp: "10.128.64.10",
        forceReplace: true,
      });
    } catch {}

    expect(updateSplitDnsCalled).toBe(false);
  });
});

describe("Router identity preflight", () => {
  const baseDevice = {
    id: "device-123",
    name: "router.tailnet.ts.net",
    hostname: "router",
    tags: ["tag:docker"],
    addresses: ["100.64.0.1"],
  };

  test("accepts only an explicitly ephemeral existing identity", () => {
    expect(() =>
      assertRouterIdentityPreflight({
        device: { ...baseDevice, isEphemeral: true },
        tsHostname: "router",
      }),
    ).not.toThrow();
  });

  test("rejects a non-ephemeral existing identity before mutations with migration advice", () => {
    expect(() =>
      assertRouterIdentityPreflight({
        device: { ...baseDevice, isEphemeral: false },
        tsHostname: "router",
      }),
    ).toThrow(/A normal run stops before policy, network, credential, state, container, or split-DNS mutations.*Back up the task-owned 'traefik_tailscale' state volume/);
  });

  test("rejects missing existing identity status before mutations", () => {
    expect(() =>
      assertRouterIdentityPreflight({
        device: baseDevice,
        tsHostname: "router",
      }),
    ).toThrow(/did not report isEphemeral.*A normal run stops before policy, network, credential, state, container, or split-DNS mutations/);
  });

  test.each([
    ["non-ephemeral", false],
    ["missing status", undefined],
  ])("reports %s identity as a nonfatal dry-run prerequisite", (_label, isEphemeral) => {
    const warning = assertRouterIdentityPreflight({
      device: { ...baseDevice, isEphemeral },
      tsHostname: "router",
      dryRun: true,
    });

    expect(warning).toContain("router");
    expect(warning).toContain("A normal run stops before policy, network, credential, state, container, or split-DNS mutations");
  });

  test("runs Tailnet discovery and identity preflight before Docker installation", () => {
    const cliSource = readFileSync(join(import.meta.dir, "cli.ts"), "utf-8");
    const runCliSource = cliSource.slice(cliSource.indexOf("export async function runOnboardingCli"));
    const tailnetDiscovery = runCliSource.indexOf("await inspectTailnet(apiClient)");
    const identityPreflight = runCliSource.indexOf("assertRouterIdentityPreflight({");
    const dockerInstallation = runCliSource.indexOf("await installDockerIfMissing(cliOptions.dryRun)");
    const firstHostMutation = runCliSource.indexOf("await ensureIpForwarding(cliOptions.dryRun)");

    expect(tailnetDiscovery).toBeGreaterThan(-1);
    expect(identityPreflight).toBeGreaterThan(tailnetDiscovery);
    expect(dockerInstallation).toBeGreaterThan(identityPreflight);
    expect(firstHostMutation).toBeGreaterThan(identityPreflight);
  });
});
