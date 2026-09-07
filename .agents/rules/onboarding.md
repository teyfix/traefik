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
   access-only contributor, personal Scion installation, additional shared-Hub
   worker, or independent ingress installation. Personal Scion with the
   developer's own AGY/GitHub credentials is the preferred Animatrix execution
   role; it does not require independent ingress. Identify
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

## Personal Scion and MCP

Use the developer's own controller/state and AGY/GitHub authorization.
Validate IDE login, command-line harness auth, GitHub MCP auth and Scion's
projected credentials separately. Use fresh DinD agents for new tasks and
read-only personal provider env mounts; tracked examples contain placeholders
and real `.local` files remain ignored. Preserve old sessions/checkpoints
during explicit handoffs. Do not require another developer's credentials.

Automatic assignee-to-controller routing is owned by
[Animatrix #191](https://github.com/teyfix/animatrix/issues/191) and remains
pending until its two-controller acceptance passes. Do not register a second
runner using the shared name/labels and `--replace` defaults. Initial
execution belongs to one registered assignee; unassigned issues stay in
triage and multiple assignees require an explicit execution owner. Issue
creators/commenters must not choose credential accounts. Running work keeps
its recorded controller until explicit handoff. Configuration verification
does not authorize a task launch.

For AGY-only setup use `SCION_ENABLED_PROVIDERS=antigravity` and the
[Animatrix personal-auth guide](https://github.com/teyfix/animatrix/blob/main/docs/ONBOARDING.md).
`controller:prepare` starts the selected harness without auth imports or an
Actions runner; no Codex account/file is required. Check that the target
checkout/image implements this contract. `auth:antigravity` imports an existing
personal export; IDE auth may instead live in a keyring. Without an export,
follow the guide's native Scion interactive login, project-scoped capture and
fresh-agent verification. Do not invent dummy files or borrow credentials.
Distinguish controller startup evidence from the peer's unverified login.

Read the canonical
[MCP matrix](https://github.com/teyfix/animatrix/blob/main/docs/ONBOARDING.md#3-mcp-connections-and-evidence)
for selected connections. This repository has no workspace MCP config.
Discover the actual installed client's config and version through its MCP
manager; inspect inherited personal/global settings and effective tool access.
Use personal auth and real calls to verify GitHub repositories and Project
permissions independently. Verify endpoint DNS/CA only when that endpoint
is used. Shared knowledge/diagnostic names keep their actual suffixes.
Optional Postgres/Grafana tools must target the intended daemon and service
with their read-only restrictions. Scion lifecycle is dashboard/API/Task,
not an assumed MCP connection.

Report checks from the developer's WSL/IDE separately from fresh-agent
checks, and label unavailable-machine evidence unverified. For write probes
use an agreed non-dispatched item; do not add `agent:ready` or issue a lifecycle
command as a connectivity test. Follow the linked guide for assign, deliberate
launch, acknowledgement, preview and PR review.

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
