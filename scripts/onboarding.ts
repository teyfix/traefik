#!/usr/bin/env bun
import { runOnboardingCli } from "./onboarding/cli";

if (import.meta.main) {
  runOnboardingCli().catch((err) => {
    console.error(`\nOnboarding failed: ${(err as Error).message}`);
    process.exit(1);
  });
}

