import { mkdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { composeSubprocessEnv } from "./compose";

export async function isRootCaTrusted(rootCaPath: string): Promise<boolean> {
  const hostCertPath = "/usr/local/share/ca-certificates/traefik-stepca-root-ca.crt";
  if (!existsSync(hostCertPath) || !existsSync(rootCaPath)) {
    return false;
  }
  try {
    const [sourceContent, installedContent] = await Promise.all([
      readFile(rootCaPath, "utf-8"),
      readFile(hostCertPath, "utf-8"),
    ]);
    return sourceContent.trim() === installedContent.trim();
  } catch {
    return false;
  }
}

export async function exportCertsFromContainer(
  repoRoot: string,
  extraEnv?: Record<string, string>,
): Promise<string> {
  const certsDir = resolve(repoRoot, "certs");
  await mkdir(certsDir, { recursive: true });

  const procExec = Bun.spawn(
    ["docker", "compose", "exec", "stepca", "sh", "-c", "mkdir -p /tmp/exported && cp /home/step/certs/*.crt /tmp/exported"],
    { cwd: repoRoot, env: composeSubprocessEnv(extraEnv), stdout: "pipe", stderr: "pipe" },
  );
  await procExec.exited;

  const procCp = Bun.spawn(
    ["docker", "compose", "cp", "stepca:/tmp/exported/.", "./certs"],
    { cwd: repoRoot, env: composeSubprocessEnv(extraEnv), stdout: "pipe", stderr: "pipe" },
  );
  await procCp.exited;

  return resolve(certsDir, "root_ca.crt");
}

export async function installRootCa(
  repoRoot: string,
  dryRun = false,
  extraEnv?: Record<string, string>,
): Promise<{ installed: boolean; reason: string }> {
  const rootCaPath = resolve(repoRoot, "certs/root_ca.crt");

  // If certs/root_ca.crt does not exist yet on host, try exporting it from stepca container
  if (!existsSync(rootCaPath)) {
    try {
      await exportCertsFromContainer(repoRoot, extraEnv);
    } catch {}
  }

  if (!existsSync(rootCaPath)) {
    return {
      installed: false,
      reason: "Root CA certificate not found yet (stepca may need to run first).",
    };
  }

  const alreadyTrusted = await isRootCaTrusted(rootCaPath);
  if (alreadyTrusted) {
    return {
      installed: false,
      reason: "Root CA is already installed and trusted on the host.",
    };
  }

  if (dryRun) {
    return {
      installed: true,
      reason: "Dry run: Would install root CA into /usr/local/share/ca-certificates/",
    };
  }

  const hostCertPath = "/usr/local/share/ca-certificates/traefik-stepca-root-ca.crt";
  const cpProc = Bun.spawn(["sudo", "cp", rootCaPath, hostCertPath], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const cpCode = await cpProc.exited;
  if (cpCode !== 0) {
    throw new Error("Failed to copy root CA to /usr/local/share/ca-certificates/");
  }

  const chmodProc = Bun.spawn(["sudo", "chmod", "644", hostCertPath], {
    stdout: "pipe",
    stderr: "pipe",
  });
  await chmodProc.exited;

  const updateProc = Bun.spawn(["sudo", "update-ca-certificates"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const updateCode = await updateProc.exited;
  if (updateCode !== 0) {
    throw new Error("Failed to run update-ca-certificates");
  }

  return {
    installed: true,
    reason: "Root CA installed and trusted in host system trust store.",
  };
}
