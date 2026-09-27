import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { renderAndValidateIngressConfig } from "./onboarding/ingress-config";

interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function docker(args: string[]): Promise<CommandResult> {
  const proc = Bun.spawn(["docker", ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { code, stdout: stdout.trim(), stderr: stderr.trim() };
}

async function requireDocker(args: string[]): Promise<string> {
  const result = await docker(args);
  if (result.code !== 0) {
    throw new Error(
      `docker ${args.join(" ")} failed: ${result.stderr || `exit code ${result.code}`}`,
    );
  }
  return result.stdout;
}

const repoRoot = resolve(import.meta.dir, "..");
const temporaryDirectory = await mkdtemp(
  resolve(tmpdir(), "traefik-issue8-address-proof-"),
);
const suffix = `${process.pid}_${Date.now()}`;
const networkName = `traefik_issue8_proof_${suffix}`;
const roles = ["traefik", "tailscale", "coredns"] as const;
const permutations = [
  ["traefik", "tailscale", "coredns"],
  ["traefik", "coredns", "tailscale"],
  ["tailscale", "traefik", "coredns"],
  ["tailscale", "coredns", "traefik"],
  ["coredns", "traefik", "tailscale"],
  ["coredns", "tailscale", "traefik"],
] as const;
const containerNames = Object.fromEntries(
  roles.map((role) => [role, `${networkName}_${role}`]),
) as Record<(typeof roles)[number], string>;
let networkCreated = false;

async function removeProofContainers(): Promise<void> {
  await docker(["rm", "-f", ...roles.map((role) => containerNames[role])]);
}

try {
  await requireDocker(["info", "--format", "{{.ServerVersion}}"]);

  let subnet = "";
  for (let thirdOctet = 240; thirdOctet <= 255; thirdOctet++) {
    const candidate = `10.254.${thirdOctet}.0/24`;
    const created = await docker([
      "network",
      "create",
      "--driver",
      "bridge",
      "--subnet",
      candidate,
      networkName,
    ]);
    if (created.code === 0) {
      subnet = candidate;
      networkCreated = true;
      break;
    }
  }
  if (!subnet) {
    throw new Error("Could not allocate an isolated disposable 10.254.* /24 proof network.");
  }

  const prefix = subnet.slice(0, subnet.lastIndexOf(".") + 1);
  const expected = {
    traefik: `${prefix}2`,
    tailscale: `${prefix}3`,
    coredns: `${prefix}10`,
  } as const;
  const exampleEnv = await readFile(resolve(repoRoot, ".example.env"), "utf8");
  const proofEnv = exampleEnv
    .replace(/^TS_INGRESS_SUBNET=.*$/m, `TS_INGRESS_SUBNET="${subnet}"`)
    .replace(/^TS_ROUTES=.*$/m, `TS_ROUTES="${subnet}"`)
    .replace(/^TRAEFIK_IP=.*$/m, `TRAEFIK_IP="${expected.traefik}"`)
    .replace(/^TS_TAILSCALE_IP=.*$/m, `TS_TAILSCALE_IP="${expected.tailscale}"`)
    .replace(/^TS_DNS_SERVER=.*$/m, `TS_DNS_SERVER="${expected.coredns}"`);
  const envPath = resolve(temporaryDirectory, "proof.env");
  await writeFile(envPath, proofEnv, { mode: 0o600 });

  const rendered = await renderAndValidateIngressConfig(
    repoRoot,
    undefined,
    ["--env-file", envPath],
  );
  if (
    rendered.ingressSubnet !== subnet ||
    rendered.traefikIp !== expected.traefik ||
    rendered.tailscaleIp !== expected.tailscale ||
    rendered.dnsResolverIp !== expected.coredns
  ) {
    throw new Error("Rendered Compose addresses did not match the disposable proof allocation.");
  }

  for (const order of permutations) {
    for (const role of order) {
      await requireDocker([
        "create",
        "--name",
        containerNames[role],
        "--network",
        networkName,
        "--ip",
        expected[role],
        "alpine:3.24.1",
        "sleep",
        "300",
      ]);
      await requireDocker(["start", containerNames[role]]);
    }

    for (const role of roles) {
      const actual = await requireDocker([
        "inspect",
        "--format",
        `{{(index .NetworkSettings.Networks "${networkName}").IPAddress}}`,
        containerNames[role],
      ]);
      if (actual !== expected[role]) {
        throw new Error(
          `${role} received ${actual || "no address"}; expected ${expected[role]} for order ${order.join(",")}.`,
        );
      }
    }
    console.log(`Verified recreation order: ${order.join(" -> ")}`);
    await removeProofContainers();
  }

  console.log(
    `Verified all six recreation orders on disposable ${networkName} (${subnet}); no live stack services were used.`,
  );
} finally {
  await removeProofContainers();
  if (networkCreated) await docker(["network", "rm", networkName]);
  await rm(temporaryDirectory, { recursive: true, force: true });
}
