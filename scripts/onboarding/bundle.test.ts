import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bundleOptions, runBundleOnboarding } from "./bundle";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "ingress-bootstrap-"));
  const source = join(root, "source with spaces");
  const installation = join(root, "installation with spaces");
  await mkdir(join(source, "svc/traefik/helper"), { recursive: true });
  await mkdir(join(source, "svc/traefik/example"), { recursive: true });
  await mkdir(installation);
  await writeFile(
    join(source, "svc/traefik/helper/compose.yaml"),
    "services: {}\n",
  );
  await writeFile(
    join(source, "svc/traefik/helper/go.mod"),
    "module fixture\n",
  );
  await writeFile(join(source, "docker-bake.hcl"), "");
  await writeFile(
    join(source, "svc/traefik/example/compose.yaml"),
    "name: traefik\nservices:\n  traefik:\n    image: teyfix/traefik:dev\n    volumes: []\n",
  );
  return { root, source, installation };
}

describe("Local bundle entrypoint", () => {
  test("keeps native flags intact and paths as data", () => {
    expect(
      bundleOptions([
        "--bundle-source=/source with spaces",
        "--domain",
        "dev.example.test",
      ]),
    ).toEqual({
      source: "/source with spaces",
      forwarded: ["--domain", "dev.example.test"],
    });
    expect(() => bundleOptions(["--bundle-source"])).toThrow("requires a path");
    expect(bundleOptions(["--install-dir", "/tmp"])).toEqual({
      installation: "/tmp",
      forwarded: [],
    });
    expect(() =>
      bundleOptions(["--bundle-source", "/a", "--output=/unsafe"]),
    ).toThrow("managed");
  });

  for (const dryRun of [false, true]) {
    test(`delegates to Go with private build inputs; dry run=${dryRun}`, async () => {
      const f = await fixture();
      const originalSpawn = Bun.spawn;
      const originalKey = process.env.TS_API_KEY;
      const calls: Array<{
        args: string[];
        cwd?: string;
        env?: NodeJS.ProcessEnv;
      }> = [];
      process.env.TS_API_KEY = "fixture-setup-key";
      try {
        Bun.spawn = ((
          args: string[],
          options?: { cwd?: string; env?: NodeJS.ProcessEnv },
        ) => {
          calls.push({ args, cwd: options?.cwd, env: options?.env });
          const exited = args.includes("onboarding")
            ? writeFile(
                join(f.installation, ".state/traefik/compose.env"),
                'TS_INGRESS_SUBNET="10.90.0.0/24"\nTRAEFIK_IP="10.90.0.2"\n',
              ).then(() => 0)
            : Promise.resolve(0);
          return { exited };
        }) as unknown as typeof Bun.spawn;
        await runBundleOnboarding(
          [
            "--bundle-source",
            f.source,
            "--install-dir",
            f.installation,
            "--domain",
            "dev.example.test",
            ...(dryRun ? ["--dry-run=true"] : []),
          ],
          f.installation,
        );
        expect(calls).toHaveLength(3);
        for (const call of calls.slice(0, 2)) {
          expect(call.args[0]).toBe("docker");
          expect(call.cwd).toBe(f.source);
          expect(call.env?.PWD).toBe(f.source);
          expect(call.env?.TS_API_KEY).toBeUndefined();
          expect(call.env?.TS_API_TOKEN).toBeUndefined();
        }
        expect(calls[0]!.args).toContain("CGO_ENABLED=0");
        const delegated = calls[2]!;
        expect(delegated.args).toContain("onboarding");
        if (process.geteuid?.() !== 0) {
          expect(delegated.args[1]).toBe(
            "--preserve-env=TS_API_KEY,TS_API_TOKEN,TRAEFIK_INGRESS_DOMAIN,TRAEFIK_HOSTNAME",
          );
        }
        expect(delegated.args).toContain(join(f.installation, "traefik.yaml"));
        expect(delegated.args).toContain(
          join(f.installation, ".state/traefik/bundle.compose.yaml"),
        );
        expect(delegated.env?.TS_API_KEY).toBe("fixture-setup-key");
        expect(delegated.cwd).toBe(f.installation);
        const overlay = JSON.parse(
          await readFile(
            join(
              f.installation,
              ".cache/traefik-bootstrap/helper.compose.yaml",
            ),
            "utf8",
          ),
        );
        expect(overlay.services.check.volumes[0]).toMatchObject({
          source: f.source,
          target: "/workspace",
          read_only: true,
        });
        const deployment = Bun.YAML.parse(
          await readFile(
            join(f.installation, ".state/traefik/bundle.compose.yaml"),
            "utf8",
          ),
        ) as { name: string; services: { traefik: { image: string } } };
        expect(deployment.name).toBe("traefik");
        expect(deployment.services.traefik.image).toBe(
          "teyfix/traefik:local-bootstrap",
        );
        expect(existsSync(join(f.installation, ".env"))).toBe(!dryRun);
        if (!dryRun) {
          expect(
            await readFile(join(f.installation, ".env"), "utf8"),
          ).toContain('TRAEFIK_IP="10.90.0.2"');
          await writeFile(
            join(f.installation, ".env"),
            (await readFile(join(f.installation, ".env"), "utf8")) +
              "KEEP_ME=preserved\n",
          );
          await runBundleOnboarding(
            ["--bundle-source", f.source, "--install-dir", f.installation],
            f.installation,
          );
          expect(
            await readFile(join(f.installation, ".env"), "utf8"),
          ).toContain("KEEP_ME=preserved");
        }
      } finally {
        Bun.spawn = originalSpawn;
        if (originalKey === undefined) delete process.env.TS_API_KEY;
        else process.env.TS_API_KEY = originalKey;
        await rm(f.root, { recursive: true, force: true });
      }
    });
  }

  test("refuses existing installations before launching anything", async () => {
    const f = await fixture();
    const originalSpawn = Bun.spawn;
    try {
      await writeFile(
        join(f.installation, ".env"),
        "OPERATOR_SETTING=preserve\n",
      );
      Bun.spawn = (() => {
        throw new Error("unexpected launch");
      }) as unknown as typeof Bun.spawn;
      await expect(
        runBundleOnboarding(
          ["--bundle-source", f.source, "--install-dir", f.installation],
          f.installation,
        ),
      ).rejects.toThrow("migration");
      expect(await readFile(join(f.installation, ".env"), "utf8")).toBe(
        "OPERATOR_SETTING=preserve\n",
      );
    } finally {
      Bun.spawn = originalSpawn;
      await rm(f.root, { recursive: true, force: true });
    }
  });

  test("failed native onboarding never activates the generated deployment", async () => {
    const f = await fixture();
    const originalSpawn = Bun.spawn;
    try {
      let calls = 0;
      Bun.spawn = (() => ({
        exited: Promise.resolve(++calls === 3 ? 1 : 0),
      })) as unknown as typeof Bun.spawn;
      await expect(
        runBundleOnboarding(
          ["--bundle-source", f.source, "--install-dir", f.installation],
          f.installation,
        ),
      ).rejects.toThrow("status 1");
      expect(existsSync(join(f.installation, ".env"))).toBe(false);
      expect(
        existsSync(join(f.installation, ".state/traefik/bootstrap.json")),
      ).toBe(true);
    } finally {
      Bun.spawn = originalSpawn;
      await rm(f.root, { recursive: true, force: true });
    }
  });
  test("interruption cancels the child and never activates even if it exits zero", async () => {
    const f = await fixture();
    const originalSpawn = Bun.spawn;
    const listeners = process.listenerCount("SIGINT");
    const signals: string[] = [];
    try {
      let calls = 0;
      Bun.spawn = (() => {
        if (++calls === 3) queueMicrotask(() => process.emit("SIGINT"));
        return {
          exited: Promise.resolve(0),
          kill: (signal: string) => signals.push(signal),
        };
      }) as unknown as typeof Bun.spawn;
      await expect(
        runBundleOnboarding(
          ["--bundle-source", f.source, "--install-dir", f.installation],
          f.installation,
        ),
      ).rejects.toThrow("interrupted");
      expect(signals).toEqual(["SIGINT"]);
      expect(existsSync(join(f.installation, ".env"))).toBe(false);
      expect(process.listenerCount("SIGINT")).toBe(listeners);
    } finally {
      Bun.spawn = originalSpawn;
      await rm(f.root, { recursive: true, force: true });
    }
  });
});

describe("Public default onboarding", () => {
  for (const failure of [undefined, "create", "cp"]) {
    test(`retrieves the helper without private source and cleans its extraction container; failure=${failure ?? "none"}`, async () => {
      const f = await fixture();
      await writeFile(
        join(f.root, "docker-compose.yaml"),
        "name: traefik\nservices:\n  traefik:\n    image: teyfix/traefik:edge\n    labels:\n      teyfix/traefik.http: '80'\n",
      );
      const originalSpawn = Bun.spawn;
      const originalKey = process.env.TS_API_KEY;
      const calls: Array<{ args: string[]; env?: NodeJS.ProcessEnv }> = [];
      process.env.TS_API_KEY = "fixture-private-key";
      try {
        Bun.spawn = ((
          args: string[],
          options?: { env?: NodeJS.ProcessEnv },
        ) => {
          calls.push({ args, env: options?.env });
          return {
            exited: args.includes("onboarding")
              ? writeFile(
                  join(f.installation, ".state/traefik/compose.env"),
                  'TS_INGRESS_SUBNET="10.90.0.0/24"\nTRAEFIK_IP="10.90.0.2"\n',
                ).then(() => 0)
              : Promise.resolve(args[1] === failure ? 1 : 0),
          };
        }) as unknown as typeof Bun.spawn;
        const operation = runBundleOnboarding(
          ["--install-dir", f.installation],
          f.root,
        );
        if (failure) await expect(operation).rejects.toThrow("status 1");
        else await operation;
        const dockerCalls = calls.filter((c) => c.args[0] === "docker");
        expect(dockerCalls.map((c) => c.args[1])).toEqual(
          failure === "create"
            ? ["pull", "create", "rm"]
            : ["pull", "create", "cp", "rm"],
        );
        for (const call of dockerCalls) {
          expect(call.env?.TS_API_KEY).toBeUndefined();
          expect(call.env?.TS_API_TOKEN).toBeUndefined();
        }
        if (failure !== "create")
          expect(calls[2]!.args[2]).toEndWith(":/usr/local/bin/ingressctl");
        expect(dockerCalls.at(-1)!.args[2]).toBe(calls[1]!.args[3]!);
        expect(existsSync(join(f.installation, ".env"))).toBe(!failure);
        if (!failure) {
          expect(calls[4]!.args).toContain("onboarding");
          expect(calls[4]!.env?.TS_API_KEY).toBe("fixture-private-key");
          const deployment = await readFile(
            join(f.installation, ".state/traefik/bundle.compose.yaml"),
            "utf8",
          );
          expect(deployment).toContain("teyfix/traefik:edge");
          expect(deployment).toContain("teyfix/traefik.http");
        }
      } finally {
        Bun.spawn = originalSpawn;
        if (originalKey === undefined) delete process.env.TS_API_KEY;
        else process.env.TS_API_KEY = originalKey;
        await rm(f.root, { recursive: true, force: true });
      }
    });
  }
});
