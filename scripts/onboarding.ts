#!/usr/bin/env bun
import { runBundleOnboarding } from "./onboarding/bundle";
import { resolve } from "node:path";

if (import.meta.main) {
  runBundleOnboarding(
    process.argv.slice(2),
    resolve(import.meta.dir, ".."),
  ).catch((err) => {
    console.error(`\nOnboarding failed: ${(err as Error).message}`);
    process.exit(1);
  });
}
