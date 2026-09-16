import { parseArgs } from "node:util";
import { z } from "zod";

export const DockerPoolSchema = z
  .string()
  .refine(
    (val) =>
      val === "auto" ||
      /^(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\/18$/.test(
        val,
      ),
    { message: "Must be 'auto' or a valid /18 IPv4 CIDR (e.g. 10.128.64.0/18)" },
  );

export const DnsZoneSchema = z
  .string()
  .refine(
    (val) =>
      val === "auto" ||
      /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i.test(
        val,
      ),
    { message: "Must be 'auto' or a valid domain suffix (e.g. dixie.gg)" },
  );

export const CliOptionsSchema = z.object({
  dockerPool: DockerPoolSchema.optional(),
  tsDnsZone: DnsZoneSchema.optional(),
  tsRouterTag: z.string().default("tag:docker"),
  tsHostname: z.string().optional(),
  rotateAuthKey: z.boolean().default(false),
  yes: z.boolean().default(false),
  dryRun: z.boolean().default(false),
  help: z.boolean().default(false),
});

export type RawCliOptions = z.infer<typeof CliOptionsSchema>;

export interface ResolvedOptions {
  dockerPool: string; // CIDR or "auto"
  tsDnsZone: string; // domain or "auto"
  tsRouterTag: string;
  tsHostname: string;
  rotateAuthKey: boolean;
  yes: boolean;
  dryRun: boolean;
}

export function parseCliArgs(args: string[] = process.argv.slice(2)): RawCliOptions {
  const { values } = parseArgs({
    args,
    options: {
      "docker-pool": { type: "string" },
      "ts-dns-zone": { type: "string" },
      "ts-router-tag": { type: "string" },
      "ts-hostname": { type: "string" },
      "rotate-authkey": { type: "boolean" },
      yes: { type: "boolean", short: "y" },
      "dry-run": { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
    allowPositionals: false,
    strict: true,
  });

  return CliOptionsSchema.parse({
    dockerPool: values["docker-pool"],
    tsDnsZone: values["ts-dns-zone"],
    tsRouterTag: values["ts-router-tag"] ?? "tag:docker",
    tsHostname: values["ts-hostname"],
    rotateAuthKey: values["rotate-authkey"] ?? false,
    yes: values.yes ?? false,
    dryRun: values["dry-run"] ?? false,
    help: values.help ?? false,
  });
}

export function getHelpText(): string {
  return `Traefik & Tailscale Onboarding CLI

Usage:
  TS_API_TOKEN="..." bun scripts/onboarding.ts [options]

Options:
  --docker-pool <cidr|auto>   Custom Docker address pool (e.g. 10.128.64.0/18 or "auto")
  --ts-dns-zone <zone|auto>   Tailscale private split-DNS zone (e.g. dixie.gg or "auto")
  --ts-router-tag <tag>       Tailscale tag for router device (default: tag:docker)
  --ts-hostname <name>        Tailscale router hostname (default: $(hostname -s)-router)
  --rotate-authkey            Force generation of a new Tailscale auth key instead of reusing existing key
  -y, --yes                   Accept recommended/default values without confirmation
  --dry-run                   Plan mutations without applying any changes
  -h, --help                  Show this help text

Authentication:
  TS_API_TOKEN is transiently read from the environment and is never persisted to disk.
`;
}

/**
 * Resolves an individual option value following the contract:
 * explicit CLI value -> explicit "auto" -> --yes recommended value -> interactive prompt
 */
export async function resolveOptionValue(params: {
  cliValue: string | undefined;
  defaultValue: string;
  isYes: boolean;
  promptFn: (recommendation: string) => Promise<string>;
}): Promise<string> {
  const { cliValue, defaultValue, isYes, promptFn } = params;

  // 1. Explicit CLI value (including explicit "auto")
  if (cliValue !== undefined && cliValue !== "") {
    return cliValue;
  }

  // 2. --yes flag with recommended/default value
  if (isYes) {
    return defaultValue;
  }

  // 3. Interactive prompt
  return await promptFn(defaultValue);
}
