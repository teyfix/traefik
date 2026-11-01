import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
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
  let interrupted = false;
  const interrupt = () => {
    interrupted = true;
    child.kill("SIGINT");
  };
  const terminate = () => {
    interrupted = true;
    child.kill("SIGTERM");
  };
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", terminate);
  try {
    const code = await child.exited;
    if (interrupted)
      throw new Error(
        "Onboarding interrupted; deployment selection unchanged.",
      );
    if (code !== 0)
      throw new Error(`${command[0]} exited with status ${code}.`);
  } finally {
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", terminate);
  }
}

/** Public onboarding; --bundle-source builds a development override. */
export async function runBundleOnboarding(
  args: string[],
  repositoryRoot: string,
): Promise<void> {
  const options = bundleOptions(args);
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
      "Usage: bun scripts/onboarding.ts [--install-dir PATH] [--domain SUFFIX] [--hostname NAME] [--dry-run] [--skip-proxy-setup]\nRequires Docker Engine and Compose. Missing Tailscale key and location are prompted automatically. Development only: --bundle-source PATH builds from source with Buildx.",
    );
    return;
  }
  const source = options.source ? resolve(options.source) : undefined;
  const installation = resolve(options.installation ?? repositoryRoot);
  const helperCompose = source
    ? join(source, "svc/traefik/helper/compose.yaml")
    : undefined;
  const example = source
    ? join(source, "svc/traefik/example/compose.yaml")
    : join(repositoryRoot, "docker-compose.yaml");
  const requiredFiles = source
    ? [
        helperCompose!,
        example,
        join(source, "docker-bake.hcl"),
        join(source, "svc/traefik/helper/go.mod"),
      ]
    : [example];
  for (const file of requiredFiles) {
    if (!existsSync(file))
      throw new Error(`Installation source is incomplete: ${file}`);
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
      "Existing ingress configuration/state found. Use the state-preserving migration procedure; onboarding bootstraps fresh installations.",
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
  let image: string;
  if (source) {
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
        helperCompose!,
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
    image = "teyfix/traefik:local-bootstrap";
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
  } else {
    const reference = Bun.YAML.parse(await readFile(example, "utf8")) as {
      services?: { traefik?: { image?: string } };
    };
    const published = reference.services?.traefik?.image;
    if (!published || !published.startsWith("teyfix/traefik:")) {
      throw new Error(
        "Default Compose file must select the public Traefik release.",
      );
    }
    image = published;
    const env = composeSubprocessEnv();
    await run(["docker", "pull", image], installation, env);
    const container = `traefik-bootstrap-${randomUUID()}`;
    await run(
      [
        "docker",
        "create",
        "--name",
        container,
        "--entrypoint",
        "/bin/true",
        image,
      ],
      installation,
      env,
    );
    try {
      await run(
        [
          "docker",
          "cp",
          `${container}:/usr/local/bin/ingressctl`,
          join(binaries, "ingressctl"),
        ],
        installation,
        env,
      );
    } finally {
      await run(["docker", "rm", container], installation, env);
    }
  }
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
      "--preserve-env=TS_API_KEY,TS_API_TOKEN,TRAEFIK_INGRESS_DOMAIN,TRAEFIK_HOSTNAME",
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
