/**
 * Builds the environment for Docker Compose subprocesses.
 *
 * Values selected during onboarding must override Bun's startup environment:
 * Compose gives shell variables precedence over the freshly-written .env file.
 * The Tailnet API token is CLI-only and must never reach Compose or a container.
 */
export function composeSubprocessEnv(
  envUpdates: Record<string, string> = {},
): Record<string, string | undefined> {
  const env = {
    ...process.env,
    ...envUpdates,
  };
  delete env.TS_API_TOKEN;
  return env;
}
