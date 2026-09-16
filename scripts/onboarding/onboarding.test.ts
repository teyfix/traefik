import { describe, expect, test } from "bun:test";
import { parseCidr, cidrsOverlap, deriveDnsResolverIp, allocateDockerPool } from "./network";
import { parseEnv, updateEnvContent, redactSecret } from "./env";
import { mergeDaemonJson } from "./docker";
import { mergeTailscalePolicy } from "./policy";
import { parseCliArgs, resolveOptionValue, DockerPoolSchema, DnsZoneSchema } from "./options";
import { deriveDnsZoneFromHost } from "./host";

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
      "--docker-pool",
      "10.128.64.0/18",
      "--ts-dns-zone",
      "dixie.gg",
      "--rotate-authkey",
      "--yes",
      "--dry-run",
    ]);
    expect(options.dockerPool).toBe("10.128.64.0/18");
    expect(options.tsDnsZone).toBe("dixie.gg");
    expect(options.rotateAuthKey).toBe(true);
    expect(options.yes).toBe(true);
    expect(options.dryRun).toBe(true);
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
});

describe("Tailscale API Client semantics", () => {
  test("creates reusable tagged auth key payload", async () => {
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
      expect(capturedBody.capabilities.devices.create.ephemeral).toBe(false);
      expect(capturedBody.capabilities.devices.create.preauthorized).toBe(true);
      expect(capturedBody.capabilities.devices.create.tags).toEqual(["tag:docker"]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("getDevices requests fields=all and captures routes", async () => {
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
              tags: ["tag:docker"],
              advertisedRoutes: ["10.128.64.0/24"],
              enabledRoutes: ["10.128.64.0/24"],
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
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("ensureRouterAuthKey regenerates key when unregistered or forced", async () => {
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

      // When local state is missing (hasLocalState: false), old key triggers regeneration
      const safeExistingKey = ["tskey", "auth", "oldvalidkey123"].join("-");
      const res1 = await ensureRouterAuthKey({
        client,
        existingKey: safeExistingKey,
        routerTag: "tag:docker",
        hostname: "router",
        hasLocalState: false,
      });
      expect(res1.generated).toBe(true);
      expect(res1.authKey).toBe("fresh-auth-key");

      // If local state is present (hasLocalState: true) and forceRotate is false, reuses existing key
      const res2 = await ensureRouterAuthKey({
        client,
        existingKey: safeExistingKey,
        routerTag: "tag:docker",
        hostname: "router",
        hasLocalState: true,
      });
      expect(res2.generated).toBe(false);
      expect(res2.authKey).toBe(safeExistingKey);

      // If forceRotate is true, generates new key even if local state is present
      const res3 = await ensureRouterAuthKey({
        client,
        existingKey: safeExistingKey,
        routerTag: "tag:docker",
        hostname: "router",
        hasLocalState: true,
        forceRotate: true,
      });
      expect(res3.generated).toBe(true);
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
    } finally {
      Bun.spawn = originalSpawn;
    }
  });
});
