import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

export const RULE_CHARACTER_LIMIT = 12_000;

export async function checkAgentRuleSizes(
  repositoryRoot: string,
): Promise<string[]> {
  const rulePaths = ["AGENTS.md"];
  for await (const path of new Bun.Glob(".agents/rules/**/*.md").scan({
    cwd: repositoryRoot,
    dot: true,
    onlyFiles: true,
  })) {
    rulePaths.push(path);
  }

  const failures: string[] = [];
  for (const path of rulePaths.sort()) {
    const source = await readFile(resolve(repositoryRoot, path), "utf8");
    // Unicode code points, including frontmatter; UTF-8 bytes and UTF-16
    // code units would incorrectly charge non-ASCII text more than once.
    const count = Array.from(source).length;
    if (count > RULE_CHARACTER_LIMIT) {
      failures.push(
        `${path}: ${count} characters exceeds ${RULE_CHARACTER_LIMIT}`,
      );
    }
  }
  return failures;
}

if (import.meta.main) {
  try {
    const failures = await checkAgentRuleSizes(resolve(import.meta.dir, ".."));
    if (failures.length > 0) {
      for (const failure of failures) console.error(failure);
      process.exitCode = 1;
    } else {
      console.log("Agent rules satisfy the 12,000-character limit.");
    }
  } catch (error) {
    console.error("Unable to check agent rules:", error);
    process.exitCode = 1;
  }
}
