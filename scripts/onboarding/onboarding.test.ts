import { describe, expect, test } from "bun:test";
import { parseCidr, cidrsOverlap, deriveDnsResolverIp, allocateDockerPool } from "./network";
import { parseEnv, updateEnvContent, redactSecret } from "./env";
import { mergeDaemonJson } from "./docker";
import { mergeTailscalePolicy } from "./policy";
import { parseCliArgs, resolveOptionValue } from "./options";
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
    expect(pool.dnsResolver).toBe("10.128.64.10");
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
});

describe("CLI resolution contract", () => {
  test("parses explicit CLI flags", () => {
    const options = parseCliArgs([
      "--docker-pool",
      "10.128.64.0/18",
      "--ts-dns-zone",
      "dixie.gg",
      "--yes",
      "--dry-run",
    ]);
    expect(options.dockerPool).toBe("10.128.64.0/18");
    expect(options.tsDnsZone).toBe("dixie.gg");
    expect(options.yes).toBe(true);
    expect(options.dryRun).toBe(true);
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
