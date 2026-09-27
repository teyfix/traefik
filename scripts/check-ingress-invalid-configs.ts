import { resolve } from "node:path";
import { renderAndValidateIngressConfig } from "./onboarding/ingress-config";

const repoRoot = resolve(import.meta.dir, "..");
const composeGlobalArgs = process.argv.slice(2);
const invalidCases: Array<{
  name: string;
  env: Record<string, string>;
  expected: RegExp;
}> = [
  {
    name: "duplicate service address",
    env: { TS_TAILSCALE_IP: "10.10.10.2" },
    expected: /Static IP conflict/,
  },
  {
    name: "out-of-subnet service address",
    env: { TS_TAILSCALE_IP: "10.10.11.3" },
    expected: /outside TS_INGRESS_SUBNET/,
  },
  {
    name: "leading-zero service address",
    env: { TS_TAILSCALE_IP: "10.010.010.003" },
    expected: /not a valid IPv4 address/,
  },
  {
    name: "partial CIDR prefix",
    env: {
      TS_INGRESS_SUBNET: "10.10.10.0/24foo",
      TS_ROUTES: "10.10.10.0/24foo",
    },
    expected: /Invalid prefix in CIDR/,
  },
  {
    name: "leading-zero ingress subnet",
    env: {
      TS_INGRESS_SUBNET: "10.010.010.000/24",
      TS_ROUTES: "10.010.010.000/24",
    },
    expected: /Invalid IPv4 address/,
  },
  {
    name: "host-bit ingress subnet",
    env: {
      TS_INGRESS_SUBNET: "10.10.10.1/24",
      TS_ROUTES: "10.10.10.1/24",
    },
    expected: /expected 10\.10\.10\.0\/24/,
  },
];

for (const invalidCase of invalidCases) {
  try {
    await renderAndValidateIngressConfig(
      repoRoot,
      invalidCase.env,
      composeGlobalArgs,
    );
  } catch (error) {
    const message = (error as Error).message;
    if (invalidCase.expected.test(message)) {
      console.log(`Rejected ${invalidCase.name}: ${message}`);
      continue;
    }
    throw new Error(
      `${invalidCase.name} failed with an unexpected error: ${message}`,
    );
  }
  throw new Error(`${invalidCase.name} unexpectedly passed validation.`);
}

console.log(
  `Validated ${invalidCases.length} representative invalid rendered configurations.`,
);
