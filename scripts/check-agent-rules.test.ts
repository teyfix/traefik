import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkAgentRuleSizes, RULE_CHARACTER_LIMIT } from "./check-agent-rules";

const temporaryRoots: string[] = [];

async function fixture(rootRule: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "traefik-rule-check-"));
  temporaryRoots.push(root);
  await mkdir(join(root, ".agents/rules/nested"), { recursive: true });
  await writeFile(join(root, "AGENTS.md"), rootRule);
  return root;
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

test("accepts exactly 12,000 Unicode code points including frontmatter", async () => {
  const frontmatter = "---\ntitle: Rule map\n---\n";
  const root = await fixture(
    frontmatter + "😀".repeat(RULE_CHARACTER_LIMIT - frontmatter.length),
  );
  expect(await checkAgentRuleSizes(root)).toEqual([]);
});

test("rejects 12,001 code points without discarding frontmatter", async () => {
  const frontmatter = "---\ntitle: Rule map\n---\n";
  const root = await fixture(
    frontmatter + "é".repeat(RULE_CHARACTER_LIMIT + 1 - frontmatter.length),
  );
  expect(await checkAgentRuleSizes(root)).toEqual([
    "AGENTS.md: 12001 characters exceeds 12000",
  ]);
});

test("checks direct and nested Markdown rules, but leaves docs and other formats alone", async () => {
  const root = await fixture("# Agent rule map\n");
  const tooLong = "x".repeat(RULE_CHARACTER_LIMIT + 1);
  await writeFile(join(root, ".agents/rules/onboarding.md"), tooLong);
  await writeFile(join(root, ".agents/rules/nested/deployment.md"), tooLong);
  await writeFile(join(root, ".agents/rules/example.json"), tooLong);
  await writeFile(join(root, "README.md"), tooLong);
  expect(await checkAgentRuleSizes(root)).toEqual([
    ".agents/rules/nested/deployment.md: 12001 characters exceeds 12000",
    ".agents/rules/onboarding.md: 12001 characters exceeds 12000",
  ]);
});

test("a missing root rule map fails instead of reporting a clean check", async () => {
  const root = await fixture("# Agent rule map\n");
  await rm(join(root, "AGENTS.md"));
  await expect(checkAgentRuleSizes(root)).rejects.toThrow();
});
