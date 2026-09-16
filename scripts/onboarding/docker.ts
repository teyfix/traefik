import { readFile, unlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";

export interface DockerNetworkInfo {
  name: string;
  id: string;
  driver: string;
  subnets: string[];
}

export async function isDockerInstalled(): Promise<boolean> {
  try {
    const proc = Bun.spawn(["which", "docker"], { stdout: "pipe", stderr: "pipe" });
    const code = await proc.exited;
    return code === 0;
  } catch {
    return false;
  }
}

export async function isDockerDaemonReachable(): Promise<boolean> {
  try {
    const proc = Bun.spawn(["docker", "info", "--format", "{{.ServerVersion}}"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const code = await proc.exited;
    return code === 0;
  } catch {
    return false;
  }
}

export async function installDockerIfMissing(dryRun = false): Promise<void> {
  const installed = await isDockerInstalled();
  if (installed) return;

  if (dryRun) {
    return;
  }

  const res = await fetch("https://get.docker.com");
  if (!res.ok) {
    throw new Error(`Failed to download Docker convenience script: HTTP ${res.status}`);
  }
  const scriptContent = await res.text();
  const tmpScript = `/tmp/get-docker-${Date.now()}.sh`;
  await writeFile(tmpScript, scriptContent, { mode: 0o700 });

  try {
    const proc = Bun.spawn(["sudo", "sh", tmpScript], {
      stdout: "inherit",
      stderr: "inherit",
    });
    const code = await proc.exited;
    if (code !== 0) {
      throw new Error(`Docker installation failed with exit code ${code}`);
    }
  } finally {
    try {
      await unlink(tmpScript);
    } catch {}
  }
}

export async function inspectDockerNetworks(): Promise<DockerNetworkInfo[]> {
  try {
    const proc = Bun.spawn(["docker", "network", "ls", "-q"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const out = await new Response(proc.stdout).text();
    const ids = out.trim().split(/\s+/).filter(Boolean);
    if (ids.length === 0) return [];

    const inspectProc = Bun.spawn(
      ["docker", "network", "inspect", ...ids],
      { stdout: "pipe", stderr: "pipe" },
    );
    const jsonStr = await new Response(inspectProc.stdout).text();
    const parsed = JSON.parse(jsonStr) as any[];

    return parsed.map((item) => {
      const subnets: string[] = [];
      if (Array.isArray(item.IPAM?.Config)) {
        for (const cfg of item.IPAM.Config) {
          if (cfg.Subnet) subnets.push(cfg.Subnet);
        }
      }
      return {
        name: item.Name,
        id: item.Id,
        driver: item.Driver,
        subnets,
      };
    });
  } catch {
    return [];
  }
}

export function mergeDaemonJson(
  existingContent: string,
  newPool: { base: string; size: number },
): { merged: Record<string, any>; changed: boolean } {
  let config: Record<string, any> = {};
  if (existingContent.trim()) {
    try {
      config = JSON.parse(existingContent);
    } catch (e) {
      throw new Error(`Failed to parse existing /etc/docker/daemon.json: ${(e as Error).message}`);
    }
  }

  const existingPools = config["default-address-pools"] as
    | Array<{ base: string; size: number }>
    | undefined;

  const poolMatches =
    existingPools &&
    existingPools.length === 1 &&
    existingPools[0] !== undefined &&
    existingPools[0].base === newPool.base &&
    existingPools[0].size === newPool.size;

  if (poolMatches) {
    return { merged: config, changed: false };
  }

  config["default-address-pools"] = [newPool];
  return { merged: config, changed: true };
}

export async function configureDaemonAddressPool(
  poolCidr: string,
  dryRun = false,
): Promise<{ changed: boolean; restarted: boolean; needsReload: boolean }> {
  const daemonPath = "/etc/docker/daemon.json";
  let existingContent = "";
  if (existsSync(daemonPath)) {
    try {
      existingContent = await readFile(daemonPath, "utf-8");
    } catch {}
  }

  const { merged, changed } = mergeDaemonJson(existingContent, {
    base: poolCidr,
    size: 24,
  });

  if (!changed) {
    return { changed: false, restarted: false, needsReload: false };
  }

  if (dryRun) {
    return { changed: true, restarted: true, needsReload: true };
  }

  const formatted = JSON.stringify(merged, null, 2);
  const tmpFile = `/tmp/daemon-json-${Date.now()}.json`;
  await writeFile(tmpFile, formatted, "utf-8");

  try {
    // Validate configuration before applying
    try {
      const valProc = Bun.spawn(["dockerd", "--validate", "--config-file", tmpFile], {
        stdout: "pipe",
        stderr: "pipe",
      });
      const valCode = await valProc.exited;
      if (valCode !== 0) {
        const valErr = await new Response(valProc.stderr).text();
        throw new Error(`Generated daemon.json is invalid: ${valErr.trim()}`);
      }
    } catch (valErr) {
      if ((valErr as Error).message.includes("Generated daemon.json is invalid")) {
        throw valErr;
      }
      // If dockerd binary is not directly executable by current user, proceed to cp
    }

    const cpProc = Bun.spawn(["sudo", "cp", tmpFile, daemonPath], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const cpCode = await cpProc.exited;
    if (cpCode !== 0) {
      throw new Error(`Failed to write ${daemonPath}`);
    }

    // Restart Docker daemon directly to apply default-address-pools
    const restartProc = Bun.spawn(["sudo", "systemctl", "restart", "docker"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const restartCode = await restartProc.exited;
    if (restartCode !== 0) {
      const err = await new Response(restartProc.stderr).text();
      throw new Error(`Failed to restart Docker daemon: ${err.trim()}`);
    }
  } finally {
    try {
      await unlink(tmpFile);
    } catch {}
  }

  return { changed: true, restarted: true, needsReload: true };
}

export async function ensureDockerNetwork(
  networkName: string,
  driver = "bridge",
  dryRun = false,
  subnet?: string,
): Promise<void> {
  try {
    const inspectProc = Bun.spawn(["docker", "network", "inspect", networkName], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const code = await inspectProc.exited;
    if (code === 0) return; // Network already exists
  } catch {}

  if (dryRun) return;

  const args = ["docker", "network", "create", "--driver", driver];
  if (subnet) {
    args.push("--subnet", subnet);
  }
  args.push(networkName);

  const createProc = Bun.spawn(args, {
    stdout: "pipe",
    stderr: "pipe",
  });
  const createCode = await createProc.exited;
  if (createCode !== 0) {
    const err = await new Response(createProc.stderr).text();
    throw new Error(`Failed to create Docker network ${networkName}: ${err}`);
  }
}

export async function hasLocalTailscaleState(): Promise<boolean> {
  try {
    const proc = Bun.spawn(["docker", "volume", "inspect", "traefik_tailscale"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const code = await proc.exited;
    if (code !== 0) return false;

    const inspectProc = Bun.spawn(
      ["docker", "inspect", "-f", "{{.State.Status}}", "traefik_tailscale"],
      { stdout: "pipe", stderr: "pipe" },
    );
    const inspectCode = await inspectProc.exited;
    return inspectCode === 0;
  } catch {
    return false;
  }
}
