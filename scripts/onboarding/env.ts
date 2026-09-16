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

export function updateEnvContent(
  originalContent: string,
  updates: Record<string, string>,
): string {
  const remaining = new Map(Object.entries(updates));
  // Strictly prevent TS_API_TOKEN from ever being stored
  remaining.delete("TS_API_TOKEN");

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
    if (remaining.has(key)) {
      const newVal = remaining.get(key)!;
      remaining.delete(key);
      updatedLines.push(`${key}=${JSON.stringify(newVal)}`);
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
