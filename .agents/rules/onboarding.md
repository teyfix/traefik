---
trigger: manual
description: Load only for an explicit request to start or resume onboarding for Traefik/Tailscale; collect assigned network inputs and preserve shared infrastructure.
---

# Configure the selected installation

Activate on "I want to start onboarding" or an explicit resume request.
Read `compose/tailscale/ONBOARDING.md` only for that setup. Do not check for a
readiness marker at session startup. Optional `.local/onboarding.json` may
retain non-secret inputs during onboarding; its absence never blocks normal
work. Reuse saved inputs only for their intended machine and revalidate
affected network facts before changes.

Developer onboarding uses existing configuration inputs. Cloning this
repository or requesting a suffix does not authorize changing the shared
DNS/routing implementation or live infrastructure. An explicit user request
or owning infrastructure issue can authorize those changes; do not ask again
when that authority already exists.

## Required setup order

1. Read this repository's README and Tailscale guide. Inspect the current diff
   without reverting existing work.
2. Establish the target machine, OS/Docker runtime, and whether this is an
   access-only contributor or an operator of an independent ingress installation.
   Application development does not itself require independent ingress. Identify
   the owner of the Tailnet DNS, routes, ingress, and CA. Resolve missing
   choices before dependent mutations; continue read-only inspection meanwhile.
   Complete `compose/tailscale/ONBOARDING.md`: start with the administrator's
   allocation and existing DNS/routing configuration, reusing supplied answers. Repository
   defaults, earlier screenshots, and this host's settings do not establish
   another machine's network. Missing route ownership or masks block network
   changes even when the DNS page is available.
3. State the selected suffix, application names, destination ingress, and
   subnet ownership. Ingress uses one explicit routed ingress /24
   (`TS_INGRESS_SUBNET`) containing Tailscale, CoreDNS (`TS_DNS_SERVER`), and
   Traefik (`TRAEFIK_IP`), with backends isolated on private unadvertised
   `traefik_proxy`. If the developer only needs access to existing services,
   use the existing Tailnet and public CA certificate; do not bootstrap a
   second infrastructure stack.
4. Inspect the existing environment inputs and how Task/Compose loads them.
   Present the existing/proposed DNS and routing map, overlap findings, and
   exact authorized changes before applying them. Preserve unrelated zones,
   nameservers, routes, and access settings. Ask for missing inputs or scope;
   do not infer permission from an unanswered question.
   Configure only the authorized installation using that supported mechanism.
   Do not assume an arbitrary local override filename is automatically loaded.
5. Validate the selected Compose model without printing credentials. Start
   only the authorized installation/services, then verify DNS, HTTPS with
   certificate validation, and the intended application from the client.

## Personal access and optional client tools

Use the developer's own credentials and authorized service access. Keep
secrets in the documented ignored configuration and use placeholder examples;
do not copy another person's login or invent dummy credentials. Application
tooling and agent orchestration belong to the application repository's setup.

This repository supplies no workspace MCP configuration. When client tools
are part of the selected setup, follow the local guide's
[connection checks](../../compose/tailscale/ONBOARDING.md#optional-client-tools-and-mcp).
Discover the installed client's effective configuration and version, preserve
the actual shared endpoint names, and verify personal permissions and real
read-only calls. Check DNS and CA trust only for endpoints the role uses.
Commands must target the intended checkout, runtime and service; configuration
presence alone is not runtime evidence. Do not start optional services merely
to complete onboarding or use a write operation as a connectivity test.

Report browser, terminal, IDE and isolated runtime checks separately when
applicable. Label unavailable-client evidence unverified and identify the next
required check without blocking unrelated work.

## Suffix configuration

- `TAIL_DOMAIN` selects the private DNS zone. `TRAEFIK_DOMAIN` selects the
  dashboard hostname. Inspect other service hostnames and application-owned
  routes separately. Direct-container DNS zones (`DIRECT_DOMAIN`) and direct
  container routes are eliminated under the ingress-only architecture.
- For an explicitly selected independent `babo.gg` installation, the relevant
  DNS input is `TAIL_DOMAIN=babo.gg`. This is a configuration example, not
  authorization to start a second router or change Tailnet settings. The
  domain value has no leading dot.
- `compose/tailscale/coredns/Corefile.gotpl` already reads `TAIL_DOMAIN` and
  synthesizes wildcard A records to `TRAEFIK_IP`. `entrypoint.sh` renders
  the runtime Corefile. Do not edit the template, entrypoint, or generated
  Corefile to substitute a developer's suffix.
- The current template serves a single private zone (`TAIL_DOMAIN`). Selecting
  another suffix replaces that installation's zone; it does not add another
  zone alongside the existing one. Serving multiple suffixes on shared
  ingress requires an explicitly scoped infrastructure change.
- Tailnet restricted nameservers must route each selected suffix to its actual
  resolver. Split-DNS configuration is suffix-specific: registering or
  updating an installation's suffix preserves all unrelated split-DNS zones
  and routes on the tailnet. Application routes and certificates must match the
  intended hostname. A wildcard DNS response alone does not prove those
  boundaries. Keep shared service endpoints at their actual names.

## Shared infrastructure boundary

Onboarding must not change shared CoreDNS/Traefik implementation, split DNS,
grants, route approval/advertisements, or CA/ACME state without explicit scope
for those changes. Record affected zones, destinations, existing users, and
verification in the owning infrastructure issue before implementation.

Do not copy the default advertised ranges onto another independent host on
the same Tailnet without an approved address/routing design. Do not replace
existing `tail.gg` settings globally to satisfy a personal `babo.gg` request.
Do not reset volumes, recreate a CA, delete certificates, or use insecure TLS
to make a setup check pass.

Share the public CA certificate and required access invitations. `TS_API_TOKEN`
is transient and must never be written to disk. The onboarding CLI provisions a
tagged, preauthorized, reusable ephemeral `TS_AUTHKEY` and atomically stores it
only in gitignored `env/.env.tailscale.local` with mode `0600`. It expires in at
most 90 days and requires operator replacement before expiry. Preserve the
`traefik_tailscale` volume on ordinary restarts. Never copy
CA private keys or another machine's Tailscale identity. Report missing access
or a shared configuration gap with one precise next action. Configuration
presence is not runtime verification.

A tagged auth key can satisfy existing auto-approval/access policy. Confirm
the supplied policy rather than asking to edit it again. Tags do not allocate
addresses or configure route advertisements. The subnet router advertises
solely the dedicated ingress /24 (`TS_INGRESS_SUBNET`) containing Tailscale,
CoreDNS, and Traefik. Application backends remain isolated on the private,
unadvertised `traefik_proxy` network.

If migrating an existing host with active legacy `tailscale_services` or
`traefik_ingress` containers, remove only the task-owned containers by exact
name, tolerating ones already absent, before removing the scoped network:
`docker rm -f traefik_tailscale traefik_coredns 2>/dev/null || true`, then
`docker network rm tailscale_services` (or for ingress:
`docker rm -f traefik traefik_tailscale traefik_coredns 2>/dev/null || true`,
then `docker network rm traefik_ingress`).
This avoids Compose failures on legacy `.env` files lacking `TRAEFIK_IP` and
preserves shared application networks such as `traefik_proxy`.
Also inspect Compose ownership labels. Remove an inactive unlabeled matching
network so Compose can recreate it. If it is active, stop and give targeted
attachment migration instructions; never remove backend containers or volumes.
The current `teyfix-router` is confirmed ephemeral; preserve its state volume.
If a future API check reports false or missing ephemeral status, fail closed
and require a separately authorized, backed-up identity migration rather than
resetting state during an ordinary source upgrade.
