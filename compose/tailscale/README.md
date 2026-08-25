# Shared Tailscale ingress and DNS

This Compose component makes development services reachable from authorized
tailnet devices under the private `tail.gg` DNS suffix. It owns the persistent
Tailscale subnet-router identity, CoreDNS, and the shared
`tailscale_services` Docker network. Application projects continue to own their
containers and routes.

## Request and DNS flow

Every tailnet client sends queries for `tail.gg` to CoreDNS at
`10.10.10.10`. CoreDNS then selects one of two exposure paths:

```text
ordinary name, for example api.ukiyo.tail.gg
  -> CoreDNS returns Traefik's 172.16.0.0/12 address
  -> tailnet subnet router
  -> Traefik TLS/router/middleware
  -> project service on traefik_proxy

direct name, for example hello.ukiyo.dkr.tail.gg
  -> CoreDNS asks Docker's embedded DNS for the exact network alias
  -> CoreDNS returns that container's 10.10.10.0/24 address
  -> tailnet subnet router
  -> container's native port and protocol
```

## How hostname discovery works

There is no per-service DNS record synchronization with Tailscale. The DNS and
service-discovery layers are independent and meet at the requested hostname:

1. The Tailscale admin console delegates the `tail.gg` suffix to the restricted
   nameserver at `10.10.10.10`. It does not contain records for application
   services.
2. A tailnet client's local Tailscale resolver sends every `tail.gg` query to
   that CoreDNS address through the advertised `10.10.10.0/24` subnet route.
3. For an ordinary name, CoreDNS synthesizes an A record containing Traefik's
   Docker IP. The wildcard covers the apex and every subdomain, so adding
   `api.project.tail.gg` does not require a CoreDNS edit or a record in the
   Tailscale admin console.
4. Independently, Traefik watches the Docker socket. When a running container
   on `traefik_proxy` has enabled labels, Traefik creates the declared router
   and maps its `Host(...)` or `HostSNI(...)` rule to that container and port.
5. The client connects to the synthesized IP through the advertised
   `172.16.0.0/12` route. Traefik selects the router by the original HTTP Host
   header or TLS SNI name and requests a matching certificate from Step CA.

CoreDNS therefore does not discover containers, inspect Traefik labels, or
store a list of ordinary services. It deliberately answers all ordinary
`*.tail.gg` names with the same Traefik IP. A name can resolve successfully
even when no matching router exists; in that case Traefik returns its unmatched
route response and may present its default certificate. DNS resolution proves
only that the shared ingress is discoverable, not that an application exists.

Adding a normal HTTPS service requires only:

- a unique `*.tail.gg` hostname in its Traefik router label;
- membership in the external `traefik_proxy` network;
- the correct Traefik service port and TLS labels; and
- tailnet grants that permit the client to reach the ingress ports.

Starting, stopping, or renaming an ordinary application container needs no DNS
restart because the wildcard answer is unchanged. Traefik notices the Docker
event and adds or removes the router dynamically. Direct `*.dkr.tail.gg` names
are different: they exist only when a container explicitly owns the complete
name as a `tailscale_services` network alias, and Docker's embedded DNS supplies
that exact record dynamically.

Ordinary synthesized A answers have a 60-second TTL. Direct answers pass
through CoreDNS's 30-second cache. Clients may therefore retain a recently
changed answer until its TTL expires even after the container or router changes.

At CoreDNS startup, its entrypoint resolves the `traefik.docker.local` network
alias and renders that IP into the wildcard response. The rendered answer is
fixed for that CoreDNS process. If Traefik is recreated and receives a different
Docker IP, restart or recreate CoreDNS afterward. If certificate issuance was
attempted while the old IP was still served, restart Traefik in place after
CoreDNS is healthy so ACME retries the challenge. `task up:full` handles the
normal full-stack recreation order; prefer it over plain `task up` while the
Tailscale profile is active.

Tailscale routes packets to IP ranges; it does not route hostnames. CoreDNS is
what decides whether a name maps to the Traefik address class or directly to a
container address. The connector must therefore advertise both ranges:

```env
TAIL_DOMAIN=tail.gg
DIRECT_DOMAIN=dkr.tail.gg
TS_SERVICE_SUBNET=10.10.10.0/24
TS_ROUTES=10.10.10.0/24,172.16.0.0/12
TS_DNS_SERVER=10.10.10.10
TS_HOSTNAME=docker-subnet-router
```

- `10.10.10.0/24` contains CoreDNS and containers explicitly attached for
  direct access.
- `172.16.0.0/12` covers Docker/Traefik addresses used by normal routed names.

Traefik's host-published ports bind only to `127.0.0.1`, so they are available
to host-local clients but not through ordinary host LAN interfaces. Tailnet
clients use the advertised `172.16.0.0/12` route to reach Traefik's Docker
address directly; they do not depend on those host port publications.

`TS_SERVICE_SUBNET` configures the dedicated `tailscale_services` bridge. It is
not Docker's general address range and does not replace the `172.16.0.0/12`
route. CoreDNS gives the more-specific `dkr.tail.gg` zone precedence over the
ordinary `tail.gg` wildcard.

> [!WARNING]
> `172.16.0.0/12` can overlap a tailnet client's LAN, VPN, or local Docker
> networks. An overlapping client may select the wrong route. If that happens,
> coordinate a narrower, non-overlapping Docker address pool before changing
> the advertised route.

## Ownership boundary

This repository owns:

- Traefik and Step CA
- the persistent Tailscale connector and its state
- CoreDNS and split-DNS behavior for `tail.gg`
- the shared `traefik_proxy` and `tailscale_services` networks

Each application project owns:

- its Traefik labels, router names, host rules, middleware, and service ports
- its OAuth clients and exact callback paths
- the decision to opt an individual container into direct access
- workload-specific Tailscale sidecars, such as a dedicated egress connector

After this shared stack is verified, a project should remove only its old
central Tailscale/CoreDNS Compose include and files. It should keep its
Traefik labels and any workload-specific sidecars.

## Tailnet administration

Configure policy in the
[Tailscale policy editor](https://login.tailscale.com/admin/acls) before
starting the connector. The following policy fragments
show the intended relationship; merge them into the tailnet's existing policy
instead of replacing it. Substitute the actual group allowed to own the
connector if `autogroup:admin` is too broad.

```json
{
  "tagOwners": {
    "tag:docker": ["autogroup:admin"]
  },
  "autoApprovers": {
    "routes": {
      "10.10.10.0/24": ["tag:docker"],
      "172.16.0.0/12": ["tag:docker"]
    }
  }
}
```

Route approval only allows the tagged connector to publish those routes. It
does **not** give users permission to reach them. Add a separate grant for the
specific users/groups and destination ports your development policy permits.
For example, this broad development grant permits members to reach both routed
ranges on any IP protocol:

```json
{
  "grants": [
    {
      "src": ["autogroup:member"],
      "dst": ["10.10.10.0/24", "172.16.0.0/12"],
      "ip": ["*"]
    }
  ]
}
```

Prefer narrower groups and ports where practical. A narrowed policy must still
permit TCP and UDP port 53 to `10.10.10.10`, plus each intended Traefik or
direct-service destination port.

Private split DNS is not an access-control boundary. Knowing or resolving a
`tail.gg` name does not authorize a client; Tailscale grants must restrict the
routed address and port, and sensitive applications still need appropriate
application-level authentication.

In the [Tailscale DNS administration page](https://login.tailscale.com/admin/dns):

1. Enable MagicDNS.
2. Add `10.10.10.10` as a nameserver.
3. Restrict that nameserver to the `tail.gg` domain.

MagicDNS and the restricted nameserver are separate settings. MagicDNS handles
tailnet device names; the restricted nameserver makes CoreDNS authoritative for
this private development suffix.

> [!CAUTION]
> Split DNS for `tail.gg` shadows public `tail.gg` records on tailnet clients.
> Reserve the suffix for this development fabric, or change CoreDNS to serve
> only explicit private zones and forward unmatched names publicly.

Finally, create a Tailscale auth key from the
[keys administration page](https://login.tailscale.com/admin/settings/keys)
with these properties:

- tagged with `tag:docker`
- non-ephemeral, because this connector has a persistent identity
- reusable disabled (a one-off key)

Store it as `TS_AUTHKEY` in the gitignored local environment file described by
the root example configuration. Do not commit the key. The connector's Docker
volume preserves its identity, so the key is normally needed only for initial
registration or after deliberately deleting that state.

## Start and verify

From the repository root, review the committed `.env`, copy
`env/.env.tailscale.example` to the gitignored
`env/.env.tailscale.local`, and replace its placeholder. Then render and start
the stack with the profile enabled:

```bash
cp env/.env.tailscale.example env/.env.tailscale.local
docker compose --profile tailscale config
task up:full
```

`task up:full` starts the unprofiled edge/observability services and the
profiled Tailscale/CoreDNS services together. Its raw Compose equivalent is
`docker compose --profile tailscale up -d`. Plain `task up` intentionally
starts or recreates only the base services and does not stop an already-running
Tailscale profile. Use `task recreate:full` to stop and recreate both profiles,
or `task down` to stop both while preserving their volumes.

Verify from a different tailnet device, not only from the Docker host:

1. `api.ukiyo.tail.gg` resolves to a `172.16.0.0/12` Traefik address.
2. HTTPS reaches the matching project router after the Step CA root is trusted.
3. A direct recipe name resolves to a `10.10.10.0/24` container address and is
   reachable on the container's native port.
4. The connector advertises both configured routes and the routes are enabled.

Host-side DNS can behave differently when another VPN or the host's own
Tailscale daemon manages routes. A real remote tailnet client is the decisive
end-to-end test.

## Normal Traefik exposure

A project normally joins `traefik_proxy` and keeps its standard labels:

```yaml
networks:
  traefik_proxy:
    name: traefik_proxy
    external: true

services:
  api:
    networks:
      - traefik_proxy
    labels:
      - traefik.enable=true
      - traefik.http.routers.ukiyo_api.rule=Host(`api.ukiyo.tail.gg`)
      - traefik.http.routers.ukiyo_api.entrypoints=websecure
      - traefik.http.routers.ukiyo_api.tls=true
      - traefik.http.routers.ukiyo_api.tls.certresolver=stepca
      - traefik.http.services.ukiyo_api.loadbalancer.server.port=8080
```

The project service does not join `tailscale_services` for this path. Traefik
is the only component that needs Docker-network reachability to it.

## Opt-in direct-container exposure

Direct exposure is an escape hatch for protocols or tests that should not pass
through Traefik. The container must explicitly join the external
`tailscale_services` network with its complete DNS name as an exact alias:

```yaml
networks:
  tailscale_services:
    name: tailscale_services
    external: true

services:
  hello:
    networks:
      tailscale_services:
        aliases:
          - hello.ukiyo.dkr.tail.gg
```

Use the convention `<service>.<project>.dkr.tail.gg`. A `hostname:` value is
optional; the network alias is the discovery contract used by Docker's embedded
DNS. Do not attach a container merely because it already has a Traefik route.

> [!NOTE]
> Direct names must match a network alias exactly. An unknown `*.dkr.tail.gg`
> name never falls back to Traefik; Docker embedded DNS may return no answer or,
> in some WSL environments, let the lookup time out instead of returning
> `NXDOMAIN`.

Direct exposure bypasses Traefik TLS termination, middleware, authentication,
and routing. Clients connect to the service's native port and protocol, and the
tailnet policy must grant that destination/port. Do not publish a host port just
for Tailscale access.

The disposable [direct-container recipe](../../recipes/tailscale-direct/README.md)
demonstrates the complete opt-in contract and is intentionally not included by
the central Compose model.

## OAuth and certificate trust

Using an owned domain such as `tail.gg` provides readable, stable redirect URIs
for providers such as Google. Configure the provider with the owned domain,
HTTPS where required, and a redirect URI that exactly matches scheme, host,
port, path, and trailing-slash behavior.

Step CA certificates are private certificates. Every browser, OS, SDK, or
container that connects must trust this repository's Step CA root. Some OAuth
providers also require public reachability or a publicly trusted certificate;
private split DNS plus Step CA does not satisfy those provider-specific checks.
