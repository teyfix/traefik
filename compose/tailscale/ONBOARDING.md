# Tailscale onboarding questionnaire

Invoke this guide with "I want to start onboarding" or "Resume onboarding."
During onboarding, read it before network configuration or infrastructure
startup. Ordinary sessions do not load this guide or check a readiness file.
An agent must ask for the assigned network values and existing configuration
and use the answers to determine the setup. A requested suffix alone is insufficient.
Read [the operator guide](README.md) for the implementation after completing
this intake.

Ask in the rounds below. Reuse current answers and available read-only evidence;
ask only for unresolved inputs. Accept a redacted settings export or a textual
list. Never request tokens, auth keys, private keys, or provider login files
in chat. Record the source and observation date of network facts in the current
conversation or owning issue. Do not commit personal network inventories as
repository defaults. Reconfirm affected facts if the network changes before
execution.

## Administrator handoff

The predictable path is: administrator allocates, contributor supplies inputs,
agent configures the supported setup, and both verify. When the administrator
has already supplied the allocation and configured split DNS, start there and
ask only for missing relevant facts. The full inventory below supports a new
allocation or conflict investigation; it is not a demand to redesign an
existing Tailnet for every contributor.

|Input|Administrator supplies|
|-|-|
|Target|Machine identity and whether this is access to existing services or operation of independent ingress.|
|Names|Requested suffix, existing shared endpoints, and the split-DNS mapping already configured or authorized.|
|Networks|Exact allocated CIDRs and reserved DNS/router/ingress IPs, with enough existing route information to check overlaps.|
|Access|Assigned tag/auth-key delivery location, existing relevant auto-approval/access policy, and CA trust instructions. Never paste the key into chat.|

The configuration must distinguish the following designs:

|Design|What the onboarding agent can assume|
|-|-|
|Current repository|`tailscale_services` has explicit `TS_SERVICE_SUBNET`; `traefik_proxy` is auto-allocated separately. CoreDNS returns the proxy-network Traefik address for ordinary names.|
|Proposed single-subnet ingress|DNS and a private ingress proxy share one allocated host subnet, which is the advertised route. This is a design proposal, not implemented here by changing environment values.|

The intended predictable allocation is one exposed subnet per host where that
design is implemented. An example such as `10.20.20.0/24` with DNS at
`10.20.20.20` is not a reservation. This repository does not currently expose
`TS_PROXY_SERVER` or `TS_ROUTER_IP` configuration inputs. If the selected setup
needs that design, report the infrastructure gap and obtain its own scoped
implementation; do not invent unsupported environment variables or change
CoreDNS templates during onboarding. Application work using existing shared
services can proceed independently.

For the current design, inspect the actual proxy network and required routes.
Do not copy its broad `172.16.0.0/12` advertisement to another host. Docker
allocates default networks locally, so identical default `bridge` subnets on
different hosts do not alone prove a conflict. Compare the subnets actually
advertised and the effective routes on clients. Explicit Compose IPAM controls
a selected network; daemon `default-address-pools` controls future automatic
networks, and `bip` controls the default bridge. None is an instruction to
renumber or recreate existing networks during onboarding.

If the current policy auto-approves routes within `0.0.0.0/0` and `::/0` for
`tag:docker`, a device authenticated with that tag can have its advertised
subnets approved automatically. An existing allow-all ACL also already covers
network access. Confirm supplied policy and tag assignment; do not require
another ACL edit or manual approval when already satisfied. Auto-approval does
not choose subnets, advertise routes, create split DNS, or prevent overlaps.
See [Tailscale subnet routers](https://tailscale.com/docs/features/subnet-routers)
and [Docker network allocation](https://docs.docker.com/engine/network/).

## Round 1: target and ownership

Ask the developer:

- Which machine, OS, Docker runtime, and checkout will run the services?
- Are you accessing existing services or operating independent ingress?
- Will this machine join the existing Tailnet or a separate Tailnet?
- Which suffix do you want, which service names should use it, and on which
  machine should those services run? Should other Tailnet devices reach them?
- Who can confirm and authorize Tailnet DNS, route, ingress, and CA changes?
  Is the whole requested suffix intended for private DNS, or do some names
  need to retain their existing public resolution?

For access-only onboarding, preserve the shared endpoints and skip new-router
configuration. Collect the DNS/route/access evidence needed to prove client
connectivity; do not request unrelated administrator changes.

## Contributor roles

Choose the ingress role from the actual service-access needs. Cloning an
application repository does not itself require another DNS server, CA or
subnet router. Follow that application's own guide for development tooling.

|Role|Setup and ownership|
|-|-|
|Access-only contributor|Own checkout and local tooling; use authorized existing services. No controller or ingress setup is required.|
|Independent ingress operator|Configure a separate ingress/DNS/CA installation only with an allocated network and authorized scope from this questionnaire.|

Keep shared ingress, DNS and any other existing service endpoints under their
existing owners and at their actual names. A personal application suffix
does not rename those services. Use the developer's own credentials and
authorized access. Keep real secrets in the documented ignored files; share
placeholder examples and public CA certificates only. Do not copy another
person's login files or create dummy credentials to pass setup.

## Application contributor path

Start only the application and dependencies required by the assigned issue.
Do not prescribe a full application stack, GPU services, another CA, or a
subnet router for a landing-page task. For the requested application suffix,
establish whether local-only access is sufficient or whether other Tailnet
devices must reach the new host. Then select an authorized exposure path from
the actual network inventory. Do not assume the existing host's Traefik
automatically discovers containers on the new machine.

Treat known host/suffix relationships supplied by the operator as current
inputs. Preserve them in the proposal and ask for the remaining route and
address information; do not ask the operator to choose the topology again or
copy those relationships into universal repository defaults.

## Round 2: existing network, before proposed values

Ask the administrator and developer to fill the applicable rows. Mark missing
facts `unknown`; do not replace them with repository defaults.

|Input|Required detail|
|-|-|
|Tailnet identity|Current Tailnet DNS name and confirmation that the client is joining this network.|
|Split DNS|Every configured suffix and its resolver IPs; owner and location of each resolver.|
|Global DNS|Full nameserver list and whether Override DNS servers is enabled. A UI summary such as “and 3 more” is incomplete.|
|DNS client behavior|Search domains, MagicDNS setting, accept-DNS/accept-routes settings, and any selected exit node or relevant VPN DNS policy.|
|Certificates|Tailnet HTTPS setting, existing ingress CA, and which client/IDE environments trust its public root. Tailnet HTTPS being enabled does not establish trust for custom ingress names.|
|Subnet routes|Exact CIDRs advertised by each router, which are approved, router identity/location, and whether duplicate advertisements intentionally reach the same network.|
|Access policy|Relevant grants/ACLs, tag ownership, route auto-approval, and allowed client-to-DNS/ingress traffic. Approval of a route does not grant access to it.|
|Target machine networks|LAN, WSL/VM, other VPN, Docker network CIDRs/default address pools, and effective routes. Include existing Traefik network addresses and owners.|
|Existing services|Actual ingress and any other shared endpoints, plus representative names that must keep working.|

The DNS page supplies suffix mappings, not route masks, approved routes, router
ownership, or access grants. Never infer a `/24` from a nameserver IP.
MagicDNS's `100.100.100.100` is the Tailscale client resolver address; do not
allocate it to CoreDNS or use it as a new subnet-router destination.

## Round 3: review the proposed mapping

Before any network mutation, produce these two small tables in the current
conversation or owning issue:

|DNS suffix/service|Existing resolver and destination|Proposed resolver and destination|Owner and authorized change|
|-|-|-|-|
|Each existing mapping|Observed value|Preserved value|Existing owner; no change|
|Requested new mapping|Existing value or confirmed absent|Value supported by the routing inventory|Target owner and explicit scope|

|Network CIDR|Router/location and approval|Overlap with proposed or local network|Resolution|
|-|-|-|-|
|Each relevant existing/proposed range|Observed owner and state|Exact overlap or none|Preserve, explicitly approved design, or blocked pending input|

Check exact suffix duplicates and parent/child zone interactions. Check equal,
containing, and contained routes against the existing Tailnet and target
machine networks, including broad Docker routes. Different DNS suffixes do
not isolate overlapping IP networks. Intentional redundant routers for the
same network require confirmation; two unrelated Docker networks with the
same CIDR are not that redundancy.

Do not pick an apparently unused private range without the inventory. Do not
redirect an existing suffix, change global DNS, disable certificate checks,
or widen route/grant policy to make a failed probe pass. Present the exact
environment keys, target files, Tailnet administration changes, and services
to start. Resolve missing inputs and obtain authorization for that concrete
scope before applying it; reuse authorization already given for the same
scope. Continue independent read-only work while blocked.

Use `TAIL_DOMAIN` and `DIRECT_DOMAIN` for an authorized independent
installation's zones. A personal suffix does not require changing
`Corefile.gotpl`. Adding another zone to the shared resolver is a separately
scoped implementation change. Preserve existing shared service endpoint names.

## Verification from the actual client

After the authorized setup, verify each affected boundary:

1. The new suffix resolves through its intended resolver and reaches the
   intended ingress. Existing split-DNS zones and representative services
   still resolve to their original destinations and remain usable.
2. Effective routes select the intended router/network; no unrelated local,
   Docker, VPN, or existing Tailnet service was redirected.
3. HTTPS validates the expected hostname and CA in the developer's browser
   and IDE environment. Never use disabled TLS validation as acceptance.
4. The selected application and any required client tools work from
   that environment. Configuration parsing or a DNS answer alone is not proof.

Report each check as observed, failed, or unverified. A missing configuration
answer or unavailable client remains a stated next action, not a successful
setup.

## Optional client tools and MCP

This repository does not provide workspace MCP settings or require an MCP
server for ingress operation. If the developer uses MCP or another client
integration to access services, verify only the selected connections:

|Boundary|Evidence to collect from the actual client|
|-|-|
|Effective configuration|Installed client version and configuration location from its settings/tool manager; workspace/global precedence, duplicate server names and selected transport. Do not assume another checkout's settings apply.|
|Local command|Executable and working directory exist in that runtime; arguments and environment variable names select the intended checkout, Docker daemon and service.|
|Remote endpoint|Actual hostname resolves to the intended destination and HTTPS validates the hostname and CA in the browser, terminal, IDE or isolated runtime that will connect. A personal suffix does not rename a shared service.|
|Personal authorization|Use the developer's own credentials, inspect tool availability and effective permissions, and perform one bounded read-only call against an authorized resource. Successful connection alone does not establish resource access.|
|Client options|Check transport-specific fields, required environment/header availability, tool allowlists and timeouts without printing secrets. Client-side tool filtering does not replace server-side authorization.|

Record each selected connection's result and the environment where it was
observed. A host-terminal success does not prove IDE or container access.
Report unavailable environments as unverified. Do not disable TLS checks,
borrow another person's credentials, issue a write operation as a connectivity
probe, or start unrelated services to make a configuration indicator green.
Application-specific tooling and orchestration remain in that application's
own documentation.

## Starter prompt for an onboarding agent

```text
I want to start onboarding. Read AGENTS.md, .agents/rules/onboarding.md,
and compose/tailscale/ONBOARDING.md. Determine whether I need access to
existing services or an independent ingress installation. Use my own
credentials and check any selected client tools from the actual environment
that will use them. Application setup belongs to its own repository.
For network setup, start with the administrator's allocation, existing
Tailnet DNS/routes, and this machine's networks. Reuse answers I
already supplied; treat missing route masks/owners and truncated DNS lists as
unknown. My desired suffix is an input, not permission to rewrite CoreDNS.

Present the existing/proposed DNS and routing tables, conflict findings, and
the exact configuration changes for the selected installation. Do not edit
network configuration, start another router/ingress stack, or change Tailnet
settings until the required inputs and authorization for those changes exist.
Preserve existing zones, routes, CA state, and shared service endpoints.
Use the existing environment inputs; do not hardcode my suffix into templates.
After authorized setup, verify both new access and existing service behavior
from my actual client, and report anything that remains unverified.
Save non-secret local inputs only if useful; never add mandatory onboarding
file checks to normal sessions. Proposed network layouts are not implemented
features: report a configuration gap instead of patching shared infrastructure.
```

## Optional saved inputs

During explicit onboarding only, `.local/onboarding.json` may hold the selected
machine/checkout, role, assigned network values, endpoint names, and dated
verification results. `.local/` is ignored. Keep credentials out. If onboarding
is being coordinated from an application checkout, reuse its input file rather
than maintaining duplicate inventories.

This file is optional input for resuming setup, not a session gate or a durable
task-progress ledger. Read it only when onboarding is invoked or setup
inspection is requested. Missing or stale values block only dependent setup
operations. Revalidate affected facts when the target or network changes.
