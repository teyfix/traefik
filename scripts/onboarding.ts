#!/usr/bin/env bun
import { bundleOptions, runBundleOnboarding } from "./onboarding/bundle";
import { resolve } from "node:path";

if (import.meta.main) {
  const run = async () => {
    const args = process.argv.slice(2);
    const options = bundleOptions(args);
    if (options.source) {
      await runBundleOnboarding(args, resolve(import.meta.dir, ".."));
    } else {
      const { runOnboardingCli } = await import("./onboarding/cli");
      await runOnboardingCli();
    }
  };
  run().catch((err) => {
    console.error(`\nOnboarding failed: ${(err as Error).message}`);
    process.exit(1);
  });
}
