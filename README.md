# Shared local ingress, TLS, and tailnet DNS

This repository provides reusable development ingress for multiple projects:

- [Traefik](https://traefik.io/) reverse proxying on the shared
  `traefik_proxy` Docker network
- [Smallstep Step CA](https://smallstep.com/docs/step-ca/) certificates issued
  to Traefik through ACME
- a persistent Tailscale subnet router and CoreDNS split DNS for an
  administrator-approved private suffix
- private service names routed through the shared Traefik ingress
- optional, self-contained service recipes

Projects keep ownership of their application containers and Traefik labels.
This stack owns the cross-project edge, certificate authority, DNS server, and
Tailscale connector.

![Traefik HTTP Routers](images/00-https-routers.png)

## 🔧 Project Structure

- `docker-compose.yaml`: master Compose model and stable shared networks
- `compose/edge/`: Step CA and Traefik
- `compose/tailscale/`: Tailscale connector, CoreDNS, and its operator guide
- `compose/observability/`: shared operational tooling such as Dozzle
- `traefik/traefik-static.yaml`: Static Traefik configuration with ACME resolver
- `taskfile.yaml`: CLI automation with [`task`](https://taskfile.dev)
- `certs/`: Extracted TLS certificates, including the root CA
- `recipes/`: optional examples that are not included in the central stack

> [!NOTE]  
> Step CA uses `network_mode: host` so ACME challenges follow the host's
> Tailscale split DNS and advertised Docker routes. Traefik connects to the CA
> via `host.docker.internal` for certificate requests.

---

## 🚀 Quick Start

New contributor? Explicitly ask your agent:

```text
I want to start onboarding. Read AGENTS.md, .agents/rules/onboarding.md,
and compose/tailscale/ONBOARDING.md. Start with my administrator-issued
network allocation and existing configuration; preserve shared services.
```

The [questionnaire and shareable prompt](compose/tailscale/ONBOARDING.md)
load only when onboarding is requested. No readiness file is required for
ordinary work. Application contributors should also use the
setup instructions in their own application repository.
Access to an existing installation does not require starting this stack locally.

The [onboarding roles](compose/tailscale/ONBOARDING.md#contributor-roles)
distinguish access to existing services from operating independent ingress.
Keep shared DNS, CA and service endpoints under their existing owners. Use
your own credentials and verify
[optional client tool connections](compose/tailscale/ONBOARDING.md#optional-client-tools-and-mcp)
from the environment that will use them; this repository does not supply
workspace MCP settings.
The stack setup below applies when you are operating an authorized ingress
installation.

### 1. Clone the Repository

First, clone this repository to a local directory where you'll be running your
development environment:

```sh
git clone https://github.com/teyfix/traefik
cd traefik
```

Make sure you're inside the cloned folder before running any of the next steps.

### 2. Run the Onboarding CLI

Run the idempotent onboarding CLI to automatically inspect your host and tailnet, discover a unique non-conflicting 10.* /24 Docker ingress subnet, configure Tailscale policy, register split DNS, provision the router auth key, and verify Step CA certificates:

```bash
# Interactive mode
TS_API_TOKEN="tskey-api-..." bun scripts/onboarding.ts

# Non-interactive automatic mode
TS_API_TOKEN="tskey-api-..." bun scripts/onboarding.ts --ingress-subnet auto --ts-dns-zone auto --yes

# Dry run (plan mutations without applying changes)
TS_API_TOKEN="tskey-api-..." bun scripts/onboarding.ts --dry-run
```

`TS_API_TOKEN` is onboarding-only, transient, and never written. The CLI creates
a preauthorized, tagged, reusable, ephemeral `TS_AUTHKEY` with the maximum
90-day expiry and stores it atomically in gitignored
`env/.env.tailscale.local` with mode `0600`. Compose reads that file directly;
root `.env` and a root `.env.tailscale.local` used for operator testing are not
production key storage. The persistent `traefik_tailscale` volume is preserved
across ordinary restarts. Renew the key before expiry with
`TS_API_TOKEN="..." bun scripts/onboarding.ts --rotate-authkey`; keys cannot be
extended beyond 90 days, so this creates a replacement rather than making the
installation indefinitely unattended.

The connector forces authentication on each start. Ordinary restarts retain
the same device through the persistent volume; after the normal 30–60 minute
offline ephemeral eviction window, the stored reusable key creates a new device
under the stable `TS_HOSTNAME`. The device ID and Tailscale IP may change.
Verify recovery by the Tailnet API device and enabled-route result, not local
`Running` status.

### 3. Manual Configuration (Alternative)

If preferred, you can complete the [onboarding questionnaire](compose/tailscale/ONBOARDING.md)
with the current Tailnet administrator and configure `.env` manually:

```bash
cp .example.env .env
$EDITOR .env
```

Complete the tailnet policy, route-approval, DNS, and reusable ephemeral key
setup in [`compose/tailscale/README.md`](compose/tailscale/README.md). Store the
key only in `env/.env.tailscale.local` with mode `0600`, never in `.env`.

### Existing checkout migration

When upgrading an existing checkout to the ingress-only architecture:

1. **Clean up legacy networks and containers**: If upgrading a host with active containers on the legacy `tailscale_services` network, remove task-owned containers directly by exact name, tolerating containers that are already absent, and then remove the legacy network:
   ```bash
   docker rm -f traefik_tailscale traefik_coredns 2>/dev/null || true
   docker network rm tailscale_services
   ```
   If recreating an existing `traefik_ingress` network:
   ```bash
   docker rm -f traefik traefik_tailscale traefik_coredns 2>/dev/null || true
   docker network rm traefik_ingress
   ```
   Direct `docker rm -f` of exact container names avoids `docker compose` parsing failures when legacy `.env` files lack `TRAEFIK_IP`. These commands remove only the named legacy or conflicting network; they preserve named volumes and unrelated networks such as `traefik_proxy`.

2. **Migrate network ownership labels safely**: The CLI detects matching
   `traefik_ingress` or `traefik_proxy` networks created by older direct Docker
   commands. It removes only inactive unlabeled networks so Compose can recreate
   them with ownership labels. If either has attachments, it stops with targeted
   inspection/migration instructions; it does not delete backend containers,
   volumes, or an active proxy network.

3. **Migrate credentials**: The CLI removes legacy `TS_AUTHKEY` and
   `TS_API_TOKEN` values from root `.env`, then atomically creates or sanitizes
   `env/.env.tailscale.local`. It never stores the API token.

   Existing non-ephemeral `teyfix-router` state remains non-ephemeral after
   this source upgrade. The CLI now requires the Tailnet API to explicitly
   report `isEphemeral: true` before accepting the router or publishing split
   DNS; false or missing status stops a normal run while preserving existing
   split DNS, and is reported as a nonfatal prerequisite by `--dry-run`. Do not
   reset router state during an ordinary migration. The
   [operator guide](compose/tailscale/README.md#existing-teyfix-router-identity)
   gives the later backup, retirement, verification, and rollback plan.

4. **Preserve local `.env`**: If migrating from very old checkouts that tracked root `.env`:
   ```bash
   mkdir -p .local
   cp --backup=numbered .env .local/.env.before-example-env-migration
   ```
   After updating, restore if Git removed it:
   ```bash
   test -f .env || cp .local/.env.before-example-env-migration .env
   docker compose config --quiet
   ```

### 3. Render and start the environment

```bash
docker compose config --quiet
docker compose up -d
```

This will:

- Start Step CA, Traefik, Tailscale, CoreDNS, and observability services
- Wait until Step CA is healthy
- Allow Traefik to request certificates using ACME
- Create stable external networks for application projects

The equivalent Task command is `task up`. Complete the tailnet administration
and local auth-key setup before the first start so Tailscale can register.

### 4. Trust the root CA (Linux)

```bash
task certs:install
```

This will:

- Copy `root_ca.crt` from the Step CA container
- Install it to your system trust store via `update-ca-certificates`

✅ Works for WSL, Debian, Ubuntu, etc.

> [!TIP]  
> You can use `/usr/local/share/ca-certificates/traefik-stepca-root-ca.crt` as
> the root certificate for apps that do not use the system trust store.

### 5. Trust the Root CA (Windows)

To make Windows trust the locally issued TLS certificates:

```sh
task certs
explorer.exe certs
```

Then follow these steps to install the certificate:

1. In the opened folder, double-click the file named `root_ca.crt`.
2. A security warning will appear — click **"Open"**.
3. The certificate viewer will open. Click **"Install Certificate..."**.
4. Choose **"Local Machine"** (this requires administrator privileges), then
   click **Next**.
5. Select **"Place all certificates in the following store"**, then click
   **Browse**.
6. Choose **"Trusted Root Certification Authorities"**, then click **OK**.
7. Click **Next**, then **Finish**.
8. A final prompt will confirm the installation — click **Yes**.

> 🛡️ You should now be able to visit services like
> your configured Traefik hostname in your browser without any certificate
> warnings.

### 6. Attach an application project

Attach application services exclusively to `traefik_proxy` and declare standard
project-owned Traefik labels. A host such as
`api.project.dev.example.test` resolves to Traefik's static IP (`TRAEFIK_IP`) on
the routed `traefik_ingress` network, and Traefik forwards traffic to the backend
on `traefik_proxy`.

Under the ingress-only architecture, application backends remain isolated on the
private, unadvertised `traefik_proxy` network. Direct container exposure, direct
DNS zones, and direct routes (such as `tailscale_services` or `DIRECT_DOMAIN`)
are eliminated; all traffic enters through Traefik for centralized TLS termination,
routing, and access control.

## 🧪 Example: Secure PostgreSQL behind Traefik

You can run services like PostgreSQL behind Traefik using TCP with TLS
termination:

```yaml
networks:
  traefik_proxy:
    name: traefik_proxy
    external: true

services:
  postgres:
    image: teyfix/timescaledb-pgrx:latest
    labels:
      - "traefik.enable=true"
      - "traefik.tcp.routers.project_pg.rule=HostSNI(`pg.project.dev.example.test`)"
      - "traefik.tcp.routers.project_pg.entrypoints=shared"
      - "traefik.tcp.routers.project_pg.service=project_pg"
      - "traefik.tcp.routers.project_pg.tls=true"
      - "traefik.tcp.routers.project_pg.tls.certresolver=stepca"
      - "traefik.tcp.services.project_pg.loadbalancer.server.port=5432"
    networks:
      - traefik_proxy
```

You can now securely connect to PostgreSQL at
`pg.project.dev.example.test:4040` with TLS.

> [!NOTE]  
> Port `4040` corresponds to the `shared` TCP entrypoint defined in Traefik's
> configuration, which is designed for non-HTTP services like databases.

## 🌐 Example: HTTP Service (MinIO) Behind Traefik

You can also expose standard HTTP services like **MinIO** behind Traefik with
HTTPS:

```yaml
networks:
  traefik_proxy:
    name: traefik_proxy
    external: true

services:
  minio:
    image: minio/minio:latest
    environment:
      # Prevents redirecting to the console when accessing the API directly
      - MINIO_BROWSER_REDIRECT=false
    expose:
      - 9000 # API
      - 9001 # Console
    networks:
      - traefik_proxy
    labels:
      - "traefik.enable=true"

      # MinIO API
      - "traefik.http.routers.project_minio_api.rule=Host(`minio-api.project.dev.example.test`)"
      - "traefik.http.routers.project_minio_api.tls=true"
      - "traefik.http.routers.project_minio_api.entrypoints=websecure"
      - "traefik.http.routers.project_minio_api.tls.certresolver=stepca"
      - "traefik.http.routers.project_minio_api.service=project_minio_api"
      - "traefik.http.services.project_minio_api.loadbalancer.server.port=9000"

      # MinIO Console
      - "traefik.http.routers.project_minio_console.rule=Host(`minio-console.project.dev.example.test`)"
      - "traefik.http.routers.project_minio_console.tls=true"
      - "traefik.http.routers.project_minio_console.entrypoints=websecure"
      - "traefik.http.routers.project_minio_console.tls.certresolver=stepca"
      - "traefik.http.routers.project_minio_console.service=project_minio_console"
      - "traefik.http.services.project_minio_console.loadbalancer.server.port=9001"
```

✅ Once running, you can securely access:

- `https://minio-api.project.dev.example.test` for the API
- `https://minio-console.project.dev.example.test` for the web console

---

## 🛠 Available Tasks

|Task|Description|
|-|-|
|`task up`|Start or recreate all services|
|`task down`|Stop all services while preserving persistent state|
|`task recreate`|Recreate all services|
|`task logs`|Follow logs of all containers|
|`task certs`|Export certificates from Step CA|
|`task certs:install`|Install the root CA into your Linux trust store|
|`task purge`|Stop all services and remove CA, ACME, and Tailscale state|
|`task check:agent-rules`|Typecheck and test the agent-rule character-limit check, then validate this checkout|

Repository rule checks need Bun 1.4.0 and `bun install --frozen-lockfile` once
per checkout. `task check:agent-rules` runs the same checks as pull-request CI;
without Task, run `bun run typecheck`, `bun test`, and
`bun run check:agent-rules`. Each `AGENTS.md` and Markdown rule under
`.agents/rules/` is limited to 12,000 Unicode code points, including
frontmatter; nested rule directories are included. Procedural documentation
can live in linked guides. These checks do not start services or require an
another project checkout.

---

## 🌐 Traefik Dashboard

Once up, you can access the Traefik dashboard via either:

- **HTTPS (recommended)**: your configured Traefik hostname
- **HTTP (insecure)**: `http://localhost:8080`

> [!TIP]  
> The HTTPS version uses certificates issued by your local Step CA, while the
> HTTP version runs in insecure mode for development convenience.

---

## 🔐 Step CA Access

If you need direct access to Step CA for advanced certificate management:

```sh
https://localhost:9000
```

> [!NOTE]  
> Direct Step CA access is typically not needed for normal development
> workflows, as Traefik handles certificate requests automatically via ACME.

---

## 📄 TLS Certificate Details

- Root CA is generated by Step CA and used by Traefik's ACME resolver
- Certificates are stored under `/home/step/certs/` in the `stepca` container
- Traefik mounts these and uses them via `certResolver: stepca`

---

## 🌐 Network Architecture

This stack exposes application services through a single ingress-only path:

- Hostnames such as `api.project.dev.example.test` resolve through CoreDNS
  at the configured `TS_DNS_SERVER` to Traefik's static ingress address
  (`TRAEFIK_IP`) on `traefik_ingress`.
- The Tailscale subnet router advertises solely the dedicated, explicit
  ingress /24 subnet (`TS_INGRESS_SUBNET`) containing Tailscale, CoreDNS, and
  Traefik.
- Backend services attach exclusively to the private, unadvertised
  `traefik_proxy` network. Traefik bridges incoming traffic from `traefik_ingress`
  to backends on `traefik_proxy`. Direct container routes and direct-container DNS
  (`DIRECT_DOMAIN`) are eliminated.

Traefik publishes ports `80`, `443`, `8080`, and `4040` only on
`127.0.0.1`. Host-local clients can still use those published ports, while
ordinary LAN clients cannot reach them through a host interface. Tailnet
clients instead reach Traefik's static IP through the approved
ingress route. This boundary depends on restrictive Tailscale grants:
private DNS names are service discovery, not authorization.

Certificate validation uses this configuration:

- **Step CA** runs in `network_mode: host` to use the host's tailnet split DNS
  and advertised routes during ACME challenges
- **Traefik** connects to Step CA via `host.docker.internal:9000` for
  certificate requests
- **Services** run on the private `traefik_proxy` bridge network for proper
  service discovery

> [!IMPORTANT]  
> Step CA must use host networking so ACME validation follows the same tailnet
> DNS and routed Docker path as clients.

The complete tailnet policy, split-DNS, route, ownership, and migration contract
is documented in [`compose/tailscale/README.md`](compose/tailscale/README.md).

---

## 🛡 Security Notes

- This setup is for local/dev use only
- Certificates are **not publicly trusted**
- Browsers may still show a warning unless root CA is manually trusted
- Host-published Traefik ports are loopback-only; tailnet access uses the
  routed Docker address and must be restricted with Tailscale grants
- Private DNS records do not authorize access or replace application
  authentication for sensitive services
- All ingress traffic passes through Traefik; direct container bypass routes
  and direct DNS zones are eliminated
- Using a single dedicated ingress /24 avoids broad Docker subnet routing and
  prevents CIDR collisions with client LAN, VPN, or Docker networks
- Tailnet split DNS shadows public records under the same suffix

Using an owned suffix provides stable OAuth callback names, but providers such
as Google still require the configured domain, HTTPS rules, and redirect URI to
match exactly. Some providers require public reachability or a publicly trusted
certificate; trusting the private Step CA locally does not satisfy those checks.

---

## 🧼 Cleanup

```bash
task down
```

This stops the stack and removes orphan containers while preserving persistent
Step CA, ACME, and Tailscale state. To deliberately delete that state, use
`task purge` and confirm the destructive prompt.

---

## 📦 Requirements

- [Docker](https://www.docker.com/)
- Docker Compose with support for top-level `include`
- [Task](https://taskfile.dev)
- Linux or WSL (for root CA trust automation)

## Screenshots

### Traefik

#### Dashboard

![Traefik Dashboard](images/05-traefik-dashboard.png)

#### HTTP Routers

![Traefik HTTP Routers](images/00-https-routers.png)

#### TCP Routers

> [!WARNING]  
> This image is outdated and will be updated in the future.

![Traefik TCP Routers](images/01-tcp-routers.png)

### Services

#### KeyCloak Dashboard

![KeyCloak Dashboard](images/02-keycloak.png)

#### RedPanda Console

![RedPanda Console](images/03-redpanda-console.png)

#### Dozzle

![Dozzle](images/04-dozzle.png)
