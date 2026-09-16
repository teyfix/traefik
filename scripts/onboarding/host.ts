import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";

export async function getHostShortName(): Promise<string> {
  try {
    const proc = Bun.spawn(["hostname", "-s"], { stdout: "pipe", stderr: "pipe" });
    const out = await new Response(proc.stdout).text();
    const code = await proc.exited;
    if (code === 0 && out.trim()) {
      return out.trim().toLowerCase();
    }
  } catch {}
  return os.hostname().split(".")[0]?.toLowerCase() || "host";
}

export function deriveDnsZoneFromHost(hostname: string, tld = "gg"): string {
  const cleanHost = hostname
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/^-+|-+$/g, "");
  return `${cleanHost}.${tld.replace(/^\./, "")}`;
}

export async function checkIpForwarding(): Promise<boolean> {
  try {
    if (existsSync("/proc/sys/net/ipv4/ip_forward")) {
      const val = (await readFile("/proc/sys/net/ipv4/ip_forward", "utf-8")).trim();
      return val === "1";
    }
  } catch {}
  return false;
}

export async function ensureIpForwarding(dryRun = false): Promise<void> {
  if (dryRun) {
    return;
  }

  const isForwarding = await checkIpForwarding();
  if (!isForwarding) {
    // Apply immediately via sysctl
    const proc = Bun.spawn(["sudo", "sysctl", "-w", "net.ipv4.ip_forward=1"], {
      stdout: "inherit",
      stderr: "inherit",
    });
    const code = await proc.exited;
    if (code !== 0) {
      throw new Error(`Failed to set net.ipv4.ip_forward=1 (exit code: ${code})`);
    }
  }

  // Persist idempotently into /etc/sysctl.d/99-tailscale.conf
  const confPath = "/etc/sysctl.d/99-tailscale.conf";
  let existing = "";
  if (existsSync(confPath)) {
    try {
      existing = await readFile(confPath, "utf-8");
    } catch {}
  }
  if (!/^\s*net\.ipv4\.ip_forward\s*=\s*1\s*$/m.test(existing)) {
    const procAppend = Bun.spawn(
      [
        "sudo",
        "sh",
        "-c",
        'printf "\\n# Tailscale subnet router forwarding\\nnet.ipv4.ip_forward = 1\\n" >> /etc/sysctl.d/99-tailscale.conf',
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const code = await procAppend.exited;
    if (code !== 0) {
      throw new Error(`Failed to persist net.ipv4.ip_forward=1 to /etc/sysctl.d/99-tailscale.conf (exit code: ${code})`);
    }
  }
}

export async function getLocalRoutes(): Promise<string[]> {
  const routes: string[] = [];
  try {
    const proc = Bun.spawn(["ip", "-o", "route", "show"], { stdout: "pipe", stderr: "pipe" });
    const output = await new Response(proc.stdout).text();
    for (const line of output.split("\n")) {
      const match = /^([0-9]+\.[0-9]+\.[0-9]+\.[0-9]+\/[0-9]+)/.exec(line.trim());
      if (match?.[1]) {
        routes.push(match[1]);
      }
    }
  } catch {}
  return routes;
}
