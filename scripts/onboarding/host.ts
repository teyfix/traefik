import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { is10Slash24 } from "./network";

export const LOCAL_INGRESS_ROUTE_PRIORITY = 2500;
export const LEGACY_LOCAL_INGRESS_ROUTE_PRIORITY = 5200;
export const LOCAL_INGRESS_ROUTE_SERVICE = "traefik-ingress-route.service";
export const LOCAL_INGRESS_ROUTE_UNIT_PATH =
  `/etc/systemd/system/${LOCAL_INGRESS_ROUTE_SERVICE}`;

export function renderLocalIngressRouteService(routedSubnet: string): string {
  if (!is10Slash24(routedSubnet)) {
    throw new Error(`Local ingress route preference requires a 10.* /24, got '${routedSubnet}'`);
  }

  const exactRule =
    `pref ${LOCAL_INGRESS_ROUTE_PRIORITY} to ${routedSubnet} lookup main`;
  // Character classes keep dots literal without backslash escapes that systemd
  // would need to preserve while parsing the ExecStart command string.
  const escapedSubnet = routedSubnet.replace(/\./g, "[.]");
  const renderedRulePattern =
    `^${LOCAL_INGRESS_ROUTE_PRIORITY}:[[:space:]]+from all to ${escapedSubnet} lookup main suppress_prefixlength 0$`;
  return `[Unit]
Description=Prefer the local Docker ingress route over Tailscale's accepted copy
After=network-online.target docker.service tailscaled.service
Wants=network-online.target

[Service]
Type=oneshot
ExecStart=/bin/sh -ec 'if ip -4 rule show | grep -Eq "${renderedRulePattern}"; then exit 0; fi; while ip -4 rule del ${exactRule} 2>/dev/null; do :; done; ip -4 rule add ${exactRule} suppress_prefixlength 0'
ExecStop=/bin/sh -c 'while ip -4 rule del ${exactRule} 2>/dev/null; do :; done'
RemainAfterExit=yes

[Install]
WantedBy=multi-user.target
`;
}

function normalizeRuleLine(line: string): string {
  return line.trim().replace(/\s+/g, " ");
}

function isKnownLocalRouteRule(
  line: string,
  routedSubnet: string,
  priority = LOCAL_INGRESS_ROUTE_PRIORITY,
): boolean {
  const normalized = normalizeRuleLine(line);
  const base =
    `${priority}: from all to ${routedSubnet} lookup main`;
  return normalized === base || normalized === `${base} suppress_prefixlength 0`;
}

function assertLegacyLocalRouteSafe(rulesOutput: string, routedSubnet: string): void {
  const conflicts = rulesOutput
    .split("\n")
    .filter((line) => normalizeRuleLine(line).startsWith(`${LEGACY_LOCAL_INGRESS_ROUTE_PRIORITY}:`))
    .filter((line) => normalizeRuleLine(line).includes(`to ${routedSubnet}`))
    .filter((line) =>
      !isKnownLocalRouteRule(line, routedSubnet, LEGACY_LOCAL_INGRESS_ROUTE_PRIORITY),
    );
  if (conflicts.length > 0) {
    throw new Error(
      `Refusing to migrate unexpected priority-${LEGACY_LOCAL_INGRESS_ROUTE_PRIORITY} rule '${normalizeRuleLine(conflicts[0]!)}'`,
    );
  }
}

function hasLegacyLocalRouteRule(rulesOutput: string, routedSubnet: string): boolean {
  return rulesOutput.split("\n").some((line) =>
    isKnownLocalRouteRule(line, routedSubnet, LEGACY_LOCAL_INGRESS_ROUTE_PRIORITY),
  );
}

function managedUnitSubnet(unitContent: string): string | undefined {
  const subnet = new RegExp(
    `rule del pref ${LOCAL_INGRESS_ROUTE_PRIORITY} to ([0-9.]+\\/\\d+) lookup main`,
  ).exec(unitContent)?.[1];
  if (!subnet || !is10Slash24(subnet)) return undefined;
  return unitContent === renderLocalIngressRouteService(subnet) ? subnet : undefined;
}

export function assertLocalRoutePriorityAvailable(
  rulesOutput: string,
  routedSubnet: string,
  previouslyManagedSubnet?: string,
): void {
  const allowedTargets = new Set([routedSubnet, previouslyManagedSubnet].filter(Boolean));
  const conflicts = rulesOutput
    .split("\n")
    .filter((line) => normalizeRuleLine(line).startsWith(`${LOCAL_INGRESS_ROUTE_PRIORITY}:`))
    .filter((line) => {
      return ![...allowedTargets].some((target) =>
        isKnownLocalRouteRule(line, target!),
      );
    });

  if (conflicts.length > 0) {
    throw new Error(
      `Cannot install local ingress route preference: ip rule priority ${LOCAL_INGRESS_ROUTE_PRIORITY} is already used by '${normalizeRuleLine(conflicts[0]!)}'`,
    );
  }
}

function hasDesiredLocalRouteRule(rulesOutput: string, routedSubnet: string): boolean {
  const desired =
    `${LOCAL_INGRESS_ROUTE_PRIORITY}: from all to ${routedSubnet} lookup main suppress_prefixlength 0`;
  return rulesOutput.split("\n").some((line) => normalizeRuleLine(line) === desired);
}

async function runCommand(command: string[], errorMessage: string): Promise<string> {
  const proc = Bun.spawn(command, { stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  if (code !== 0) {
    throw new Error(`${errorMessage} (exit code ${code}): ${stderr.trim()}`);
  }
  return stdout;
}

/**
 * Persists a destination-scoped policy rule ahead of Tailscale table 52.
 * suppress_prefixlength 0 excludes the main default route, so lookup can fall
 * through to accepted Tailscale routes whenever the local Docker /24 is absent.
 */
export async function ensureLocalIngressRoutePreference(
  routedSubnet: string,
  dryRun = false,
  dependencies: {
    unitPath?: string;
    runCommand?: typeof runCommand;
  } = {},
): Promise<void> {
  const desiredUnit = renderLocalIngressRouteService(routedSubnet);
  if (dryRun) return;

  const unitPath = dependencies.unitPath || LOCAL_INGRESS_ROUTE_UNIT_PATH;
  const execute = dependencies.runCommand || runCommand;
  let existingUnit = "";
  if (existsSync(unitPath)) {
    existingUnit = await readFile(unitPath, "utf-8");
  }
  const previousSubnet = managedUnitSubnet(existingUnit);
  if (existingUnit && !previousSubnet) {
    throw new Error(
      `Refusing to overwrite unrecognized systemd unit '${unitPath}'. Move or remove it explicitly before rerunning onboarding.`,
    );
  }
  const rulesOutput = await execute(
    ["ip", "-4", "rule", "show"],
    "Failed to inspect IPv4 policy routing rules",
  );
  assertLocalRoutePriorityAvailable(
    rulesOutput,
    routedSubnet,
    previousSubnet,
  );
  assertLegacyLocalRouteSafe(rulesOutput, routedSubnet);

  const unitChanged = existingUnit !== desiredUnit;
  if (unitChanged && existingUnit) {
    await execute(
      ["sudo", "systemctl", "stop", LOCAL_INGRESS_ROUTE_SERVICE],
      `Failed to stop the previous ${LOCAL_INGRESS_ROUTE_SERVICE}`,
    );
    if (previousSubnet) {
      const previousRule =
        `pref ${LOCAL_INGRESS_ROUTE_PRIORITY} to ${previousSubnet} lookup main`;
      await execute(
        [
          "sudo",
          "sh",
          "-c",
          `while ip -4 rule del ${previousRule} 2>/dev/null; do :; done`,
        ],
        "Failed to remove the previous local ingress route preference",
      );
    }
  }

  if (unitChanged) {
    const temporaryDirectory = await mkdtemp(join(tmpdir(), "traefik-route-unit-"));
    const temporaryUnit = join(temporaryDirectory, LOCAL_INGRESS_ROUTE_SERVICE);
    try {
      await writeFile(temporaryUnit, desiredUnit, { mode: 0o644 });
      await execute(
        ["sudo", "install", "-m", "0644", temporaryUnit, unitPath],
        `Failed to install ${LOCAL_INGRESS_ROUTE_SERVICE}`,
      );
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
    await execute(
      ["sudo", "systemctl", "daemon-reload"],
      "Failed to reload systemd after installing the ingress route preference",
    );
  }

  await execute(
    ["sudo", "systemctl", "enable", "--now", LOCAL_INGRESS_ROUTE_SERVICE],
    `Failed to enable ${LOCAL_INGRESS_ROUTE_SERVICE}`,
  );
  if (!unitChanged && !hasDesiredLocalRouteRule(rulesOutput, routedSubnet)) {
    await execute(
      ["sudo", "systemctl", "restart", LOCAL_INGRESS_ROUTE_SERVICE],
      `Failed to restore the local ingress route preference`,
    );
  }

  const activeRules = await execute(
    ["ip", "-4", "rule", "show"],
    "Failed to verify the local ingress route preference",
  );
  if (!hasDesiredLocalRouteRule(activeRules, routedSubnet)) {
    throw new Error(
      `Local ingress route preference ${LOCAL_INGRESS_ROUTE_PRIORITY} was not active after service installation`,
    );
  }
  assertLegacyLocalRouteSafe(activeRules, routedSubnet);
  if (hasLegacyLocalRouteRule(activeRules, routedSubnet)) {
    const legacyRule =
      `pref ${LEGACY_LOCAL_INGRESS_ROUTE_PRIORITY} to ${routedSubnet} lookup main`;
    await execute(
      [
        "sudo",
        "sh",
        "-c",
        `while ip -4 rule del ${legacyRule} 2>/dev/null; do :; done`,
      ],
      `Failed to remove the verified legacy priority-${LEGACY_LOCAL_INGRESS_ROUTE_PRIORITY} ingress rule`,
    );
  }
}

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
