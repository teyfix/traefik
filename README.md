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

### 2. Configure Tailscale

First complete the [onboarding questionnaire](compose/tailscale/ONBOARDING.md)
with the current Tailnet administrator. Existing DNS zones, route owners, and
the target machine's subnets determine the setup. Do not copy these values to
another host until that conflict check is complete.

Copy the example environment and replace its placeholders with the approved
non-secret network values and first-registration auth key for this installation:

```bash
cp .example.env .env
$EDITOR .env
```

Complete the one-time tailnet policy, route-approval, DNS, and auth-key setup in
[`compose/tailscale/README.md`](compose/tailscale/README.md). Put `TS_AUTHKEY`
only in the documented gitignored local environment file; never commit it.

### Existing checkout migration

This repository used to track root `.env`. The migration that introduces
`.example.env` removes `.env` from Git, so an existing checkout can lose an
unmodified local `.env` when pulling the change. Preserve it before updating:

```bash
cp .env .env.before-example-env-migration
```

After updating, restore the file if Git removed it:

```bash
test -f .env || cp .env.before-example-env-migration .env
docker compose config --quiet
```

Keep the restored `.env` local and ignored. If `TS_AUTHKEY` was stored in the
legacy `env/.env.tailscale.local` file, either leave that file in place for
compatibility or move the `TS_AUTHKEY` line into root `.env`. The persistent
Tailscale state volume normally means the key is needed only for first
registration or after deliberately deleting connector state.

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

For the normal HTTPS path, attach a service to `traefik_proxy` and keep its
project-owned Traefik labels. A host such as
`api.project.dev.example.test` resolves to Traefik, which then selects the
project router.

Direct container access is opt-in and uses an exact alias such as
`hello.project.dkr.dev.example.test` on the external `tailscale_services`
network. It
bypasses Traefik security and TLS. See the
[`tailscale-direct` recipe](recipes/tailscale-direct/README.md) before using
that path.

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

This stack exposes application services through two distinct paths:

- Ordinary names such as `api.project.dev.example.test` resolve through
  CoreDNS at the configured `TS_DNS_SERVER` to Traefik's Docker address. The
  project service only needs the `traefik_proxy` network and its own labels.
- Direct names such as `hello.project.dkr.dev.example.test` resolve through
  Docker embedded DNS to the exact alias of a container explicitly joined to
  `tailscale_services`.

Tailscale routes the returned IP, not the hostname. CoreDNS selects the
destination address class. The subnet router advertises the configured service
subnet for CoreDNS/direct containers and the approved Docker/Traefik route.

Traefik publishes ports `80`, `443`, `8080`, and `4040` only on
`127.0.0.1`. Host-local clients can still use those published ports, while
ordinary LAN clients cannot reach them through a host interface. Tailnet
clients instead reach Traefik's Docker address through the approved
approved subnet route. This boundary depends on restrictive Tailscale grants:
private DNS names are service discovery, not authorization.

Certificate validation additionally uses this configuration:

- **Step CA** runs in `network_mode: host` to use the host's tailnet split DNS
  and advertised routes during ACME challenges
- **Traefik** connects to Step CA via `host.docker.internal:9000` for
  certificate requests
- **Services** run on the `traefik_proxy` bridge network for proper service
  discovery

> [!IMPORTANT]  
> Step CA must use host networking so ACME validation follows the same tailnet
> DNS and routed Docker path as clients.

The complete tailnet policy, split-DNS, route, ownership, direct-container, and
migration contract is documented in
[`compose/tailscale/README.md`](compose/tailscale/README.md).

---

## 🛡 Security Notes

- This setup is for local/dev use only
- Certificates are **not publicly trusted**
- Browsers may still show a warning unless root CA is manually trusted
- Host-published Traefik ports are loopback-only; tailnet access uses the
  routed Docker address and must be restricted with Tailscale grants
- Private DNS records do not authorize access or replace application
  authentication for sensitive services
- Direct exposure bypasses Traefik TLS, middleware, and auth
- Broad Docker routing can overlap client LAN, VPN, or Docker networks
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
