import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { composeSubprocessEnv } from "./compose";
import { mergeEnvFile, parseEnv } from "./env";

export function bundleOptions(args: string[]): {
  source?: string;
  installation?: string;
  forwarded: string[];
} {
  const result: {
    source?: string;
    installation?: string;
    forwarded: string[];
  } = {
    forwarded: [],
  };
  for (let i = 0; i < args.length; i++) {
    const argument = args[i]!;
    const option = argument.split("=", 1)[0];
    if (option !== "--bundle-source" && option !== "--install-dir") {
      if (["--compose-file", "--output", "--service"].includes(option!)) {
        throw new Error(
          `${option} is managed by bundle onboarding; select --install-dir instead.`,
        );
      }
      result.forwarded.push(argument);
      continue;
    }
    const value = argument.includes("=")
      ? argument.slice(argument.indexOf("=") + 1)
      : args[++i];
    if (!value || value.startsWith("--"))
      throw new Error(`${option} requires a path.`);
    const key = option === "--bundle-source" ? "source" : "installation";
    if (result[key]) throw new Error(`${option} was supplied more than once.`);
    result[key] = value;
  }
  if (result.installation && !result.source) {
    throw new Error(
      "--install-dir requires --bundle-source for the local bundle preview.",
    );
  }
  return result;
}

async function run(
  command: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  const child = Bun.spawn(command, {
    cwd,
    env,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  const code = await child.exited;
  if (code !== 0) throw new Error(`${command[0]} exited with status ${code}.`);
}

/** Local source preview only: public helper/image downloads are not released yet. */
export async function runBundleOnboarding(
  args: string[],
  repositoryRoot: string,
): Promise<void> {
  const options = bundleOptions(args);
  if (!options.source)
    throw new Error("Bundle onboarding requires --bundle-source.");
  if (
    process.platform !== "linux" ||
    !["x64", "arm64"].includes(process.arch)
  ) {
    throw new Error(
      "Run server onboarding on Linux or inside its WSL Docker-host distro (AMD64/ARM64).",
    );
  }
  if (
    options.forwarded.includes("--help") ||
    options.forwarded.includes("-h")
  ) {
    console.log(
      "Local bundle preview: bun scripts/onboarding.ts --bundle-source PATH [--install-dir PATH] [--domain SUFFIX] [--hostname NAME] [--dry-run] [--skip-proxy-setup]\nRequires Docker Engine, Buildx and Compose. Missing key/location are prompted by ingressctl. No public bundle release is available yet.",
    );
    return;
  }
  const source = resolve(options.source);
  const installation = resolve(options.installation ?? repositoryRoot);
  const helperCompose = join(source, "svc/traefik/helper/compose.yaml");
  const example = join(source, "svc/traefik/example/compose.yaml");
  for (const file of [
    helperCompose,
    example,
    join(source, "docker-bake.hcl"),
    join(source, "svc/traefik/helper/go.mod"),
  ]) {
    if (!existsSync(file))
      throw new Error(`Bundle source is incomplete: ${file}`);
  }
  const state = join(installation, ".state/traefik");
  const marker = join(state, "bootstrap.json");
  if (
    !existsSync(marker) &&
    [
      ".env",
      "traefik.yaml",
      ".state/stepca/data/config/ca.json",
      ".state/tailscale/data/tailscaled.state",
    ].some((path) => existsSync(join(installation, path)))
  ) {
    throw new Error(
      "Existing ingress configuration/state found. Use the state-preserving migration procedure; this preview bootstraps fresh installations.",
    );
  }
  if (existsSync(marker)) {
    const previous = JSON.parse(await readFile(marker, "utf8")) as {
      installation?: string;
    };
    if (previous.installation !== installation)
      throw new Error("Bootstrap ownership does not match this installation.");
    const envPath = join(installation, ".env");
    if (
      existsSync(envPath) &&
      parseEnv(await readFile(envPath, "utf8")).COMPOSE_FILE !==
        join(state, "bundle.compose.yaml")
    ) {
      throw new Error(
        "This installation selects a different Compose deployment; preserve it and use the migration procedure.",
      );
    }
  }
  const cache = join(installation, ".cache/traefik-bootstrap");
  const binaries = join(cache, "bin");
  const goCache = join(cache, "go");
  for (const directory of [state, binaries, goCache])
    await mkdir(directory, { recursive: true, mode: 0o700 });
  const overrides = join(cache, "helper.compose.yaml");
  const bind = (host: string, target: string, readOnly = false) => ({
    type: "bind",
    source: host,
    target,
    read_only: readOnly,
  });
  await writeFile(
    overrides,
    JSON.stringify({
      services: {
        check: {
          volumes: [
            bind(source, "/workspace", true),
            bind(goCache, "/cache"),
            bind(binaries, "/out"),
          ],
        },
      },
    }),
    { mode: 0o600 },
  );
  const buildEnv = {
    ...composeSubprocessEnv(),
    PWD: source,
    PLATFORMS: `linux/${process.arch === "x64" ? "amd64" : "arm64"}`,
  };
  await run(
    [
      "docker",
      "compose",
      "-f",
      helperCompose,
      "-f",
      overrides,
      "run",
      "--rm",
      "--no-deps",
      "check",
      "env",
      "CGO_ENABLED=0",
      "go",
      "build",
      "-trimpath",
      "-buildvcs=false",
      "-o",
      "/out/ingressctl",
      "./cmd/ingressctl",
    ],
    source,
    buildEnv,
  );
  const image = "teyfix/traefik:local-bootstrap";
  await run(
    [
      "docker",
      "buildx",
      "bake",
      "-f",
      join(source, "docker-bake.hcl"),
      "traefik",
      "--load",
      "--set",
      `traefik.tags=${image}`,
    ],
    source,
    buildEnv,
  );
  const compose = Bun.YAML.parse(await readFile(example, "utf8")) as {
    name?: string;
    services?: { traefik?: { image?: string } };
  };
  if (!compose.services?.traefik)
    throw new Error("Bundle example has no traefik service.");
  compose.services.traefik.image = image;
  const deployment = join(state, "bundle.compose.yaml");
  await writeFile(deployment, Bun.YAML.stringify(compose), { mode: 0o600 });
  await writeFile(
    marker,
    JSON.stringify({ installation, source, image, compose: deployment }) + "\n",
    { mode: 0o600 },
  );
  const helper = join(binaries, "ingressctl");
  const command = [
    helper,
    "onboarding",
    "--compose-file",
    deployment,
    "--output",
    join(installation, "traefik.yaml"),
    ...options.forwarded,
  ];
  if (process.geteuid?.() !== 0) {
    command.unshift(
      "sudo",
      "--preserve-env=TS_API_KEY,TS_API_TOKEN,TRAEFIK_DOMAIN,TRAEFIK_HOSTNAME",
    );
  }
  await run(command, installation, { ...process.env, PWD: installation });
  const dryRunOption = [...options.forwarded]
    .reverse()
    .find((value) => value === "--dry-run" || value.startsWith("--dry-run="));
  const dryRun =
    dryRunOption === "--dry-run" ||
    ["1", "t", "true"].includes(
      dryRunOption?.split("=")[1]?.toLowerCase() ?? "",
    );
  if (!dryRun) {
    const wiring = parseEnv(await readFile(join(state, "compose.env"), "utf8"));
    if (!wiring.TS_INGRESS_SUBNET || !wiring.TRAEFIK_IP) {
      throw new Error(
        "Go onboarding did not return Compose network wiring; previous deployment selection preserved.",
      );
    }
    await mergeEnvFile(join(installation, ".env"), {
      COMPOSE_FILE: deployment,
      TS_INGRESS_SUBNET: wiring.TS_INGRESS_SUBNET,
      TRAEFIK_IP: wiring.TRAEFIK_IP,
    });
  }
}
