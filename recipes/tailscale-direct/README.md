# Direct container over Tailscale

This disposable recipe demonstrates the explicit opt-in path that bypasses
Traefik. It is not included by the repository's central Compose model and does
not publish any host ports.

## Prerequisites

- The shared stack is running and has created the external
  `tailscale_services` network.
- The Tailscale connector advertises `10.10.10.0/24`.
- CoreDNS is the restricted nameserver for `tail.gg` at `10.10.10.10`.
- Your tailnet policy grants the test client access to the service's native TCP
  port `80`.

## Run

From this directory:

```bash
docker compose up -d
```

The `hello` container joins `tailscale_services` with the exact network alias
`hello.smoke.dkr.tail.gg`. From a tailnet client:

```bash
curl http://hello.smoke.dkr.tail.gg
```

CoreDNS asks Docker's embedded DNS for that exact alias and returns its
`10.10.10.0/24` address. Tailscale then routes the request directly to port 80
inside the container. There is no Traefik TLS termination, middleware, or
authentication on this path.

Remove the disposable container when finished:

```bash
docker compose down
```

To adapt the recipe, use an alias in the form
`<service>.<project>.dkr.tail.gg`, connect on the application's native port and
protocol, and grant only the necessary tailnet destinations and ports. A Docker
network alias—not `hostname:`—is the required discovery contract.
