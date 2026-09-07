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
   existing shared installation or a new independent installation. Identify
   the owner of the Tailnet DNS, routes, ingress, and CA. Resolve missing
   choices before dependent mutations; continue read-only inspection meanwhile.
   Complete `compose/tailscale/ONBOARDING.md`: start with the administrator's
   allocation and existing DNS/routing configuration, reusing supplied answers. Repository
   defaults, earlier screenshots, and this host's settings do not establish
   another machine's network. Missing route ownership or masks block network
   changes even when the DNS page is available.
3. State the selected suffix, application names, destination ingress, and
   subnet ownership. If the developer only needs access to existing services,
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

## Suffix configuration

- `TAIL_DOMAIN` selects the ordinary DNS zone; `DIRECT_DOMAIN` selects the
  direct-container zone. `TRAEFIK_DOMAIN` selects the dashboard hostname.
  Inspect other service hostnames and application-owned routes separately.
- For an explicitly selected independent `babo.gg` installation, the relevant
  DNS inputs are `TAIL_DOMAIN=babo.gg` and `DIRECT_DOMAIN=dkr.babo.gg`.
  These are configuration examples, not authorization to start a second
  router or change Tailnet settings. The domain values have no leading dot.
- `compose/tailscale/coredns/Corefile.gotpl` already reads these inputs.
  `entrypoint.sh` renders the runtime Corefile. Do not edit the template,
  entrypoint, or generated Corefile to substitute a developer's suffix.
- The current template serves one ordinary zone and its direct zone. Selecting
  another suffix replaces that installation's zones; it does not add another
  zone alongside the existing one. Serving both suffixes on shared ingress
  requires an explicitly scoped infrastructure change.
- Tailnet restricted nameservers must route each selected suffix to its actual
  resolver. Application routes and certificates must match the intended
  hostname. A wildcard DNS response alone does not prove those boundaries.
  Keep shared service endpoints at their actual names.

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

Share the public CA certificate and required access invitations. Keep auth
keys and other credential material in the documented ignored configuration;
never copy CA private keys or another machine's Tailscale identity. Report
missing access or a shared configuration gap with one precise next action.
Configuration presence is not runtime verification.

A tagged auth key can satisfy existing auto-approval/access policy. Confirm
the supplied policy rather than asking to edit it again. Tags do not allocate
addresses or configure route advertisements. Preserve the distinction between
private local Docker networks and subnets exposed through Tailscale.
