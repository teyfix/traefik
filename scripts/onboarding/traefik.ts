export interface ServiceStatus {
  name: string;
  state: string;
  health?: string;
  running: boolean;
}

export async function startTraefikStack(
  repoRoot: string,
  dryRun = false,
  extraEnv?: Record<string, string>,
): Promise<void> {
  if (dryRun) return;

  const env = {
    ...process.env,
    ...(extraEnv || {}),
  };

  const proc = Bun.spawn(["docker", "compose", "up", "-d", "--remove-orphans"], {
    cwd: repoRoot,
    env,
    stdout: "inherit",
    stderr: "inherit",
  });
  const code = await proc.exited;
  if (code !== 0) {
    throw new Error(`Failed to start Traefik stack (exit code ${code})`);
  }
}

export async function getTraefikServicesStatus(
  repoRoot: string,
): Promise<ServiceStatus[]> {
  try {
    const proc = Bun.spawn(["docker", "compose", "ps", "--format", "json"], {
      cwd: repoRoot,
      stdout: "pipe",
      stderr: "pipe",
    });
    const output = await new Response(proc.stdout).text();
    const code = await proc.exited;
    if (code !== 0 || !output.trim()) return [];

    // Parse JSON Lines or JSON array
    let items: any[] = [];
    try {
      items = JSON.parse(output);
      if (!Array.isArray(items)) items = [items];
    } catch {
      items = output
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean)
        .map((l) => {
          try {
            return JSON.parse(l);
          } catch {
            return null;
          }
        })
        .filter(Boolean);
    }

    return items.map((item) => ({
      name: item.Service || item.Name || "",
      state: item.State || "",
      health: item.Health || "",
      running: item.State === "running",
    }));
  } catch {
    return [];
  }
}

export async function waitForTraefikHealthy(
  repoRoot: string,
  timeoutMs = 30000,
): Promise<{ healthy: boolean; details: Record<string, string> }> {
  const startTime = Date.now();
  const requiredServices = ["traefik", "stepca", "coredns", "tailscale"];

  while (Date.now() - startTime < timeoutMs) {
    const statuses = await getTraefikServicesStatus(repoRoot);
    const statusMap: Record<string, string> = {};
    for (const s of statuses) {
      statusMap[s.name] = s.health ? `${s.state} (${s.health})` : s.state;
    }

    const allHealthy = requiredServices.every((req) => {
      const s = statuses.find((item) => item.name === req);
      if (!s || !s.running) return false;
      // If service has a declared healthcheck, verify it's healthy
      if (s.health && s.health !== "healthy") return false;
      return true;
    });

    if (allHealthy && statuses.length >= requiredServices.length) {
      return { healthy: true, details: statusMap };
    }

    await Bun.sleep(1500);
  }

  const finalStatuses = await getTraefikServicesStatus(repoRoot);
  const details: Record<string, string> = {};
  for (const s of finalStatuses) {
    details[s.name] = s.health ? `${s.state} (${s.health})` : s.state;
  }

  return { healthy: false, details };
}

