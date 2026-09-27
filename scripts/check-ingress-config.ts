import { resolve } from "node:path";
import { renderAndValidateIngressConfig } from "./onboarding/ingress-config";

const repoRoot = resolve(import.meta.dir, "..");

try {
  const allocation = await renderAndValidateIngressConfig(
    repoRoot,
    undefined,
    process.argv.slice(2),
  );
  console.log(
    `Validated ingress addresses in ${allocation.ingressSubnet}: ` +
      `Traefik=${allocation.traefikIp}, ` +
      `Tailscale=${allocation.tailscaleIp}, ` +
      `CoreDNS=${allocation.dnsResolverIp}`,
  );
} catch (error) {
  console.error((error as Error).message);
  process.exit(1);
}
