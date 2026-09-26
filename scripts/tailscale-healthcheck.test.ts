import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const healthcheck = new URL("../compose/tailscale/healthcheck.sh", import.meta.url).pathname;

function check(status: unknown, options: { endpointFails?: boolean; statusFails?: boolean } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "tailscale-healthcheck-"));
  try {
    writeFileSync(join(directory, "status.json"), JSON.stringify(status, null, 2));
    writeFileSync(join(directory, "wget"), `#!/bin/sh\nexit ${options.endpointFails ? 1 : 0}\n`, { mode: 0o755 });
    writeFileSync(join(directory, "tailscale"), `#!/bin/sh
# Refuse to return a fixture unless the check explicitly excludes peers.
[ "$*" = "status --json --peers=false" ] || exit 2
${options.statusFails ? "exit 1" : 'cat "$FIXTURE"'}
`, { mode: 0o755 });
    return Bun.spawnSync(["sh", healthcheck], {
      env: { ...process.env, PATH: `${directory}:${process.env.PATH}`, FIXTURE: join(directory, "status.json") },
    }).exitCode;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

describe("Tailscale connector health", () => {
  test("accepts a running online router despite unrelated route-acceptance advice", () => {
    expect(check({ BackendState: "Running", Self: { Online: true }, Peer: null,
      Health: ["Some peers are advertising routes but --accept-routes is false"] })).toBe(0);
  });

  test("rejects the observed stale identity even when local health and Running remain true", () => {
    expect(check({ BackendState: "Running", Self: { Online: false }, Peer: null })).not.toBe(0);
  });

  test("rejects a daemon needing login", () => {
    expect(check({ BackendState: "NeedsLogin", Self: { Online: true }, Peer: null })).not.toBe(0);
  });

  test("fails closed if expected identity fields are missing", () => {
    expect(check({ BackendState: "Running", Self: {}, Peer: null })).not.toBe(0);
    expect(check({ Self: { Online: true }, Peer: null })).not.toBe(0);
  });

  test("rejects local endpoint and CLI failures", () => {
    const online = { BackendState: "Running", Self: { Online: true }, Peer: null };
    expect(check(online, { endpointFails: true })).not.toBe(0);
    expect(check(online, { statusFails: true })).not.toBe(0);
  });
});
