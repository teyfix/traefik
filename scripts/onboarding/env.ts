import { chmod, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";

export function redactSecret(secret?: string): string {
  if (!secret) return "";
  if (secret.length <= 8) return "********";
  return `${secret.slice(0, 4)}...${secret.slice(-4)}`;
}

export function parseEnv(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  const lines = content.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    let val = trimmed.slice(eqIdx + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    result[key] = val;
  }
  return result;
}

export const LEGACY_KEYS_TO_SCRUB = [
  "TS_API_TOKEN",
  "TS_AUTHKEY",
  "DOCKER_POOL",
  "TS_SERVICE_SUBNET",
  "DIRECT_DOMAIN",
] as const;

export function updateEnvContent(
  originalContent: string,
  updates: Record<string, string>,
  scrubKeys: string[] = [...LEGACY_KEYS_TO_SCRUB],
): string {
  const remaining = new Map(Object.entries(updates));
  // Strictly prevent TS_API_TOKEN and TS_AUTHKEY from ever being stored
  remaining.delete("TS_API_TOKEN");
  remaining.delete("TS_AUTHKEY");

  const scrubSet = new Set(scrubKeys);

  const lines = originalContent ? originalContent.split(/\r?\n/) : [];
  const updatedLines: string[] = [];

  for (const line of lines) {
    const trimmed = line.trimStart();
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=/.exec(trimmed);
    const key = match?.[1];
    if (!key) {
      updatedLines.push(line);
      continue;
    }
    if (key === "TS_API_TOKEN" || key === "TS_AUTHKEY") {
      continue;
    }
    if (remaining.has(key)) {
      const newVal = remaining.get(key)!;
      remaining.delete(key);
      updatedLines.push(`${key}=${JSON.stringify(newVal)}`);
    } else if (scrubSet.has(key)) {
      // Scrub stale/deprecated legacy keys so they do not persist into Compose
      continue;
    } else {
      updatedLines.push(line);
    }
  }

  if (remaining.size > 0) {
    if (updatedLines.length > 0 && updatedLines[updatedLines.length - 1] !== "") {
      updatedLines.push("");
    }
    for (const [key, val] of remaining.entries()) {
      updatedLines.push(`${key}=${JSON.stringify(val)}`);
    }
  }

  const result = updatedLines.join("\n");
  return result.endsWith("\n") ? result : `${result}\n`;
}

export async function mergeEnvFile(
  filePath: string,
  updates: Record<string, string>,
): Promise<void> {
  let original = "";
  if (existsSync(filePath)) {
    original = await readFile(filePath, "utf-8");
  }
  const merged = updateEnvContent(original, updates);
  await writeFile(filePath, merged, { mode: 0o600 });
  await chmod(filePath, 0o600).catch(() => {});
}

/**
 * Scrubs credentials and stale legacy keys from legacy env files such as env/.env.tailscale.local
 * without printing secret values to logs or console.
 */
export async function scrubLegacyEnvFile(
  filePath: string,
  extraKeysToScrub: string[] = ["TS_ROUTES"],
): Promise<{ scrubbed: boolean; removedKeys: string[] }> {
  if (!existsSync(filePath)) {
    return { scrubbed: false, removedKeys: [] };
  }

  const original = await readFile(filePath, "utf-8");
  const scrubTargetSet = new Set([...LEGACY_KEYS_TO_SCRUB, ...extraKeysToScrub]);
  const lines = original.split(/\r?\n/);
  const remainingLines: string[] = [];
  const removedKeys: string[] = [];

  for (const line of lines) {
    const trimmed = line.trimStart();
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=/.exec(trimmed);
    const key = match?.[1];
    if (key && scrubTargetSet.has(key)) {
      removedKeys.push(key);
      continue;
    }
    remainingLines.push(line);
  }

  if (removedKeys.length > 0) {
    const newContent = remainingLines.join("\n");
    await writeFile(filePath, newContent.endsWith("\n") ? newContent : `${newContent}\n`, { mode: 0o600 });
    await chmod(filePath, 0o600).catch(() => {});
    return { scrubbed: true, removedKeys };
  }

  return { scrubbed: false, removedKeys: [] };
}
