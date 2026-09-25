# Shared Tailscale ingress and DNS

Before onboarding a machine or choosing a suffix, complete the
[dynamic setup questionnaire](ONBOARDING.md). The addresses and suffixes below
are examples; they are not an allocation for a new router.

This Compose component makes development services reachable from authorized
tailnet devices under the configured private DNS suffix. It owns the persistent
Tailscale subnet-router identity, CoreDNS, and the routed
`traefik_ingress` Docker network. Application projects continue to own their
containers and routes on the private, unadvertised `traefik_proxy` network.

## Request and DNS flow

Every tailnet client sends queries for the configured private suffix to
CoreDNS at `TS_DNS_SERVER`. CoreDNS synthesizes an A record containing Traefik's
static ingress IP (`TRAEFIK_IP`):

```text
ordinary name, for example api.project.dev.example.test
  -> CoreDNS returns Traefik's static ingress IP (TRAEFIK_IP on traefik_ingress)
  -> tailnet subnet router forwards traffic across the advertised ingress /24
  -> Traefik TLS termination / router / middleware
  -> project service on private, unadvertised traefik_proxy
```

## How hostname discovery works

There is no per-service DNS record synchronization with Tailscale. The DNS and
service-discovery layers are independent and meet at the requested hostname:

1. The Tailscale admin console delegates the configured private suffix to the
   restricted nameserver at `TS_DNS_SERVER`. It does not contain records for
   application services.
2. A tailnet client's local Tailscale resolver sends every private-suffix query
   to that CoreDNS address through the advertised ingress subnet route.
3. For an ordinary name, CoreDNS synthesizes an A record containing Traefik's
   static ingress IP (`TRAEFIK_IP`). The wildcard covers the apex and every subdomain, so adding
   `api.project.dev.example.test` does not require a CoreDNS edit or a record in the
   Tailscale admin console.
4. Independently, Traefik watches the Docker socket. When a running container
   on `traefik_proxy` has enabled labels, Traefik creates the declared router
   and maps its `Host(...)` or `HostSNI(...)` rule to that container and port.
5. The client connects to the synthesized IP through the advertised
   ingress route. Traefik selects the router by the original HTTP Host
   header or TLS SNI name and requests a matching certificate from Step CA.

CoreDNS therefore does not discover containers, inspect Traefik labels, or
store a list of ordinary services. It deliberately answers all names under the
split-DNS zone with Traefik's static IP on `traefik_ingress`. A name can resolve
successfully even when no matching router exists; in that case Traefik returns its
unmatched route response and may present its default certificate. Trusting the Step CA root
cannot validate that unrelated default leaf for the requested hostname. DNS resolution proves
only that the shared ingress is discoverable, not that an application exists.

Adding a normal HTTPS service requires only:

- a unique hostname under the configured private suffix in its Traefik router label;
- membership in the external `traefik_proxy` network;
- the correct Traefik service port and TLS labels; and
- tailnet grants that permit the client to reach the ingress ports.

Starting, stopping, or renaming an ordinary application container needs no DNS
restart because the wildcard answer is unchanged. Traefik notices the Docker
event and adds or removes the router dynamically.

Ordinary synthesized A answers have a 60-second TTL. Clients may retain a recently
changed answer until its TTL expires even after the container or router changes.

At CoreDNS startup, its entrypoint receives the static `TRAEFIK_IP` (or resolves the
`traefik` network alias on `traefik_ingress`) and renders that IP into the wildcard response.
`docker compose up -d` starts the complete stack and respects the declared dependency order.

Tailscale routes packets to IP ranges; it does not route hostnames. The connector
advertises solely the dedicated ingress /24 subnet:

```env
TAIL_DOMAIN=dev.example.test
TS_INGRESS_SUBNET=10.10.10.0/24
TS_ROUTES=10.10.10.0/24
TRAEFIK_IP=10.10.10.2
TS_DNS_SERVER=10.10.10.10
TS_HOSTNAME=docker-subnet-router
TS_FORWARD_MSS=1160
```

- `TS_INGRESS_SUBNET` contains only Tailscale, CoreDNS, and Traefik.
- Application backend containers remain isolated on `traefik_proxy`, which is never advertised to Tailscale.

Traefik's host-published ports bind only to `127.0.0.1`, so they are available
to host-local clients but not through ordinary host LAN interfaces. Tailnet
clients use the advertised ingress route to reach Traefik's static IP
address directly; they do not depend on those host port publications.

## WSL NAT and forwarded TCP MSS

On the default WSL NAT backend, Windows can set WSL's `eth0` MTU to the
smallest connected Windows interface MTU. With Windows Tailscale active, both
that adapter and WSL `eth0` can be `1280`. The container's own `tailscale0`
interface is also `1280`, so a full forwarded IPv4 packet plus its outer
WireGuard, UDP, and IP overhead does not fit through WSL `eth0` without outer
fragmentation.

[Tailscale recommends MSS clamping for subnet routers](https://tailscale.com/docs/features/site-to-site#clamp-the-mss-to-the-mtu),
but its generic `--clamp-mss-to-pmtu` example only sees the `1280` MTU of
`tailscale0`. It therefore permits an MSS of `1240` and cannot account for the
outer Tailscale encapsulation crossing WSL's separate `1280`-byte link. On the
affected Windows/WSL path, DF probes found a maximum inner IPv4 packet size of
`1216` bytes. `TS_FORWARD_MSS=1160` leaves 56 bytes for IPv4/TCP headers and
options and was verified with a 957607-byte HTTPS response.

The Tailscale entrypoint installs two tagged `TCPMSS --set-mss` rules for
forwarded TCP SYN packets: one entering and one leaving `tailscale0`. It only
reduces advertised values above `1160`, stays inside the connector's network
namespace, and does not change WSL or Docker network MTUs. Because the rules
are installed by the entrypoint, a connector recreation or restart restores
them automatically. Inspect matches with:

```bash
docker exec traefik_tailscale \
  iptables -t mangle -nvL FORWARD --line-numbers
```

To roll back, revert the entrypoint, its bind mount, and `TS_FORWARD_MSS`, then
run `docker compose up -d --force-recreate tailscale`. Recreating the connector
also removes the rules from the old container network namespace.

## Ownership boundary

This repository owns:

- Traefik and Step CA
- the persistent Tailscale connector and its state
- CoreDNS and split-DNS behavior for the configured private suffix
- the shared `traefik_proxy` and routed `traefik_ingress` networks

Each application project owns:

- its Traefik labels, router names, host rules, middleware, and service ports
- its OAuth clients and exact callback paths
- workload-specific Tailscale sidecars, such as a dedicated egress connector

After this shared stack is verified, a project should remove only its old
central Tailscale/CoreDNS Compose include and files. It should keep its
Traefik labels and any workload-specific sidecars.

## Tailnet administration

Configure policy in the
[Tailscale policy editor](https://login.tailscale.com/admin/acls) before
starting the connector. The following policy fragment shows the intended
relationship for the example ingress CIDR in `.example.env`; replace it with the
actual approved ingress /24 route and merge the fragment into the tailnet's existing
policy instead of replacing it. Substitute the actual group allowed to own the
connector if `autogroup:admin` is too broad.

```json
{
  "autoApprovers": { "routes": { "10.10.10.0/24": ["tag:docker"] } },
  "tagOwners": { "tag:docker": ["autogroup:admin"] }
}
```

Route approval only allows the tagged connector to publish that route. It
does **not** give users permission to reach it. Add a separate grant for the
specific users/groups and destination ports your development policy permits.
For example, this development grant permits members to reach the routed
ingress range on any IP protocol:

```json
{ "grants": [{ "dst": ["10.10.10.0/24"], "ip": ["*"], "src": ["autogroup:member"] }] }
```

Prefer narrower groups and ports where practical. A narrowed policy must still
permit TCP and UDP port 53 to the configured `TS_DNS_SERVER`, plus the
Traefik destination ports (e.g. 80, 443).

Private split DNS is not an access-control boundary. Knowing or resolving a
private name does not authorize a client; Tailscale grants must restrict the
routed address and port, and sensitive applications still need appropriate
application-level authentication.

In the [Tailscale DNS administration page](https://login.tailscale.com/admin/dns):

1. Enable MagicDNS.
2. Add the configured `TS_DNS_SERVER` address as a nameserver.
3. Restrict that nameserver to the configured `TAIL_DOMAIN`.

MagicDNS and the restricted nameserver are separate settings. MagicDNS handles
tailnet device names; the restricted nameserver makes CoreDNS authoritative for
this private development suffix. Split-DNS configuration is suffix-specific:
adding or updating an installation's suffix preserves all unrelated split-DNS
zones and routes configured on the tailnet.

> [!CAUTION]
> Split DNS shadows public records under the same suffix on tailnet clients.
> Reserve the suffix for this development fabric, or change CoreDNS to serve
> only explicit private zones and forward unmatched names publicly.

Finally, create a Tailscale auth key from the
[keys administration page](https://login.tailscale.com/admin/settings/keys)
(or have the onboarding CLI provision it) with these properties:

- tagged with `tag:docker`
- preauthorized
- ephemeral, so the control-plane device is removed after it remains offline
- reusable, so the same stored key can register the router again after eviction

Never commit auth keys or API tokens. `TS_API_TOKEN` is transient and supplied
only in the onboarding process environment. The CLI atomically stores only the
router `TS_AUTHKEY` and its expiry timestamp in gitignored
`env/.env.tailscale.local` with mode `0600`; Compose loads this file directly.
Root `.env` and a root `.env.tailscale.local` used for operator testing are not
production key storage. Tailscale auth keys expire after at most 90 days and
cannot be extended. Before the recorded expiry, create a replacement with:

```bash
TS_API_TOKEN="tskey-api-..." bun scripts/onboarding.ts --rotate-authkey
```

The old key remains valid until its own expiry unless an administrator revokes
it. This renewal requires an operator and API token; the setup is unattended
only while the stored key remains valid.

The `traefik_tailscale` volume preserves `tailscaled.state` across ordinary
restarts. Tailscale normally removes an inactive ephemeral node 30–60 minutes
after its last activity. Compose sets `TS_AUTH_ONCE=false` intentionally. With
`true`, stale state from an evicted ephemeral node can report local `Running`
without a Tailnet API device. Forced auth on each container start keeps the same
device ID during ordinary restarts, but uses the reusable key to create a new
ephemeral device after eviction. `TS_HOSTNAME` remains stable; the Tailnet
device ID and Tailscale IP can change after re-registration. Do not delete the
state volume as part of an ordinary restart.

## Start and verify

From the repository root, copy `.example.env` to the gitignored `.env` and
replace every placeholder with the approved values for this installation. Then
render and start the stack:

```bash
cp .example.env .env
$EDITOR .env
docker compose config
docker compose up -d
```

This starts the edge, observability, Tailscale, and CoreDNS services together.
The equivalent Task command is `task up`; use `task down` to stop the complete
stack while preserving its volumes.

Do not accept local `BackendState=Running` alone as proof of recovery. Confirm
the hostname/tag in the Tailnet device API, require `isEphemeral: true`, and
confirm that the advertised route is enabled. The onboarding CLI uses all three
API checks before it publishes split DNS. If duplicate devices have the matching
hostname and tag, it prefers the device explicitly reported as ephemeral. A
false or missing `isEphemeral` value fails closed and leaves existing split DNS
unchanged.

Verify from a different tailnet device, not only from the Docker host:

1. The service hostname resolves to Traefik's static ingress address (`TRAEFIK_IP`).
2. HTTPS reaches the matching project router after the Step CA root is trusted.
3. The connector advertises only the configured ingress /24 route and the route is enabled.

Host-side DNS can behave differently when another VPN or the host's own
Tailscale daemon manages routes. A real remote tailnet client is the decisive
end-to-end test.

### Local ingress route preference

Keep the host Tailscale client's `accept-routes` enabled so it can reach other
tailnet subnets. When this host also accepts the `/24` that its own connector
advertises, Tailscale installs that copy in policy table 52; without a more
specific policy rule it can take precedence over Docker's connected route in
the main table and send local CoreDNS/Traefik traffic toward `tailscale0`.

The onboarding CLI installs and enables
`/etc/systemd/system/traefik-ingress-route.service`. Its preference-2500 rule
is scoped only to `TS_INGRESS_SUBNET` and looks up the main table with
`suppress_prefixlength 0`. Thus Docker's connected ingress route wins when it
exists, while the main default route is ignored and lookup can fall through to
Tailscale table 52 when the Docker route is absent. This follows Tailscale's
[Linux overlapping-subnet guidance](https://tailscale.com/docs/reference/troubleshooting/network-configuration/lan-traffic-overlapping-subnets)
and stays outside Tailscale's reserved preference range of 5200–5500. Other
accepted routes and DNS zones are unaffected. The oneshot service survives
reboot and tailscaled restarts, removes only its exact rule on stop, and the
CLI refuses to replace an unrelated rule already using preference 2500.
An exact already-active preference-2500 rule is adopted without a delete/add
gap.

If the earlier temporary preference-5200 rule exists for the same subnet, the
CLI first installs and verifies preference 2500, then removes only the exact
old rule. Unexpected qualifiers on either scoped rule fail closed.

To roll this behavior back after the host no longer owns that ingress subnet:

```bash
sudo systemctl disable --now traefik-ingress-route.service
ingress_subnet=10.128.0.0/24 # replace with this installation's TS_INGRESS_SUBNET
sudo ip -4 rule del pref 2500 to "$ingress_subnet" lookup main 2>/dev/null || true
sudo rm /etc/systemd/system/traefik-ingress-route.service
sudo systemctl daemon-reload
```

Stopping the managed unit normally removes its scoped rule; the exact deletion
also handles an already-inactive unit. These commands do not remove any other
policy rule or disable Tailscale route acceptance. If the unit file does not
match the generated unit documented here, inspect it instead of removing it.

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
      - traefik.http.routers.project_api.rule=Host(`api.project.dev.example.test`)
      - traefik.http.routers.project_api.entrypoints=websecure
      - traefik.http.routers.project_api.tls=true
      - traefik.http.routers.project_api.tls.certresolver=stepca
      - traefik.http.services.project_api.loadbalancer.server.port=8080
```

The project service does not join `traefik_ingress` or publish host ports. Traefik
is the only component that bridges traffic from `traefik_ingress` to backend services
on `traefik_proxy`.

Under this ingress-only architecture, direct container exposure via advertised Docker
subnets and direct DNS queries are eliminated. All ingress traffic traverses Traefik,
providing centralized TLS termination, routing, and access control.

## OAuth and certificate trust

Using an owned domain provides readable, stable redirect URIs
for providers such as Google. Configure the provider with the owned domain,
HTTPS where required, and a redirect URI that exactly matches scheme, host,
port, path, and trailing-slash behavior.

Step CA certificates are private certificates. Every browser, OS, SDK, or
container that connects must trust this repository's Step CA root. Some OAuth
providers also require public reachability or a publicly trusted certificate;
private split DNS plus Step CA does not satisfy those provider-specific checks.

## Migration from legacy setups

When migrating an existing host from legacy two-subnet (`tailscale_services`) or
earlier ingress configurations to the single ingress /24 architecture:

1. **Remove legacy task-owned containers and only the conflicting network**:
   If an existing `tailscale_services` network has active containers:
   ```bash
   docker rm -f traefik_tailscale traefik_coredns 2>/dev/null || true
   docker network rm tailscale_services
   ```
   If recreating an existing `traefik_ingress` network:
   ```bash
   docker rm -f traefik traefik_tailscale traefik_coredns 2>/dev/null || true
   docker network rm traefik_ingress
   ```
   > [!NOTE]
   > Direct `docker rm -f` of exact container names tolerates containers that
   > are already absent and avoids
   > `docker compose` configuration parsing failures when legacy `.env` files
   > lack `TRAEFIK_IP`. The commands remove only the named legacy or conflicting
   > network, preserving named volumes and unrelated networks such as
   > `traefik_proxy`.

   The CLI also checks the Compose ownership labels on existing
   `traefik_ingress` and `traefik_proxy` networks. It safely removes an inactive
   unlabeled network. For an active unlabeled ingress it asks you to inspect
   attachments and remove only this stack's containers first. For an active
   unlabeled proxy it stops and requires the owning application stacks to be
   stopped/disconnected; it never deletes backend containers or volumes.

2. **Separate credentials**: The onboarding CLI scrubs `TS_API_TOKEN` and
   `TS_AUTHKEY` from root `.env`, removes any API token found in the dedicated
   file, and writes the reusable key only to `env/.env.tailscale.local`.

3. **Single routed ingress subnet**:
   Update `.env` to advertise solely `TS_INGRESS_SUBNET` (e.g. `10.10.10.0/24`)
   as `TS_ROUTES`, with static IPs for `TS_DNS_SERVER` and `TRAEFIK_IP`. Application
   backends remain on the private, unadvertised `traefik_proxy` network.

### Existing `teyfix-router` identity

The current `teyfix-router` is confirmed ephemeral; preserve its persistent
volume during ordinary upgrades and restarts. The CLI verifies this state from
the Tailnet API rather than assuming it from the stored reusable ephemeral auth
key. Supplying such a key cannot convert a different, already-registered
non-ephemeral identity, so a future false or missing API value still fails
closed without resetting state or publishing split DNS.

When the API reports `isEphemeral: false`, first record the old device ID,
routes, and approvals and confirm the stored reusable key, tag ownership,
route auto-approval, and key expiry. Then plan a separately authorized outage:

1. Make a fresh backup of the task-owned `traefik_tailscale` state volume for
   configuration recovery and investigation. It cannot revive a device after
   that Tailnet identity is retired.
2. Stop and remove only the `traefik_tailscale` router container.
3. Retire only the old Tailnet device after matching its recorded hostname,
   tag, and device ID in the administration console.
4. Only with separate authorization, reset only the backed-up router state
   volume. Do not reset it during an ordinary restart or source upgrade.
5. Rerun onboarding with the stored reusable key and verify that the API reports
   a new `isEphemeral: true` device with the expected hostname, tag, and enabled
   ingress route before split DNS changes. Then verify DNS and HTTPS from
   another tailnet client.

Those are manual, one-time cutover steps; the CLI does not retire Tailnet
devices or reset the state volume. If the same separately authorized cutover
also retires the legacy `tailscale_services` network, first inspect its
attachments and require them to be exactly the old task-owned router and
CoreDNS containers. Stop/remove only those two containers, remove only that
disconnected legacy network, and rerun onboarding with the explicitly allocated
`--ts-dns-zone` plus `--replace-split-dns` when replacement was authorized. The
API gate must still confirm `isEphemeral: true` and the approved ingress route
before the DNS write. This combined legacy cutover is not an ordinary restart.

If replacement verification fails, stop the router and retire only a failed new
identity that was actually created. Rollback is a new enrollment: confirm or
replace the authorized reusable auth key, reset only the router state as
separately authorized, rerun onboarding, and repeat the API and client checks.
Restoring the backup alone cannot restore the retired identity because Tailnet
deletion revoked its node key. Do not touch Step CA or ACME state,
`traefik_proxy`, application containers, or application volumes during this
migration.
