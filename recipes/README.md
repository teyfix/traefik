# 🍱 Recipes

This directory contains **self-contained service examples** (“recipes”) that
demonstrate how to run common infrastructure components **behind Traefik with
real TLS**, using the local Step CA setup from the root of this repository.

Think of recipes as **reference implementations**, not frameworks:

- Minimal but realistic
- Safe defaults for local development
- Easy to copy, rename, and mutate for your own stacks

Each recipe is designed to be:

- **Composable**: runs alongside others via the shared Traefik network
- **Explicit**: no hidden magic, labels show exactly how routing works
- **TLS-first**: services are exposed the same way production would be

---

## 📁 Structure

Each recipe lives in its own folder:

```txt
recipes/
├── postgres/
│   ├── docker-compose.yaml
│   ├── .example.env
│   ├── README.md
│   └── svc/
│       └── ...
```

Common conventions:

- Each recipe has its **own README**
- Environment variables are documented via `.example.env`
- Services join the **external `traefik` network**
- Traefik configuration is done _only_ via labels

No recipe modifies the core Traefik or Step CA setup.

---

## 🧠 Assumptions

Recipes assume that you have already:

1. Started the main stack:

   ```bash
   task up
   ```

2. Trusted the local root CA on your machine

If Traefik and Step CA are not running, recipes will start but **TLS will
fail**.

> [!WARNING]  
> **TLS trust behavior depends on the runtime.**  
> Some environments (for example **Node.js** and **Go**) do **not**
> automatically trust custom system CAs inside containers. You must explicitly
> provide the Root CA via runtime-specific environment variables (see
> [`NODE_EXTRA_CA_CERTS`](https://nodejs.org/api/cli.html#node_extra_ca_certsfile)
> for Node.js).

---

## 🌐 Domains & TLS

All recipes use the same domain pattern:

```txt
<service>.<prefix>.127-0-0-1.sslip.io
```

For example:

- `pg.teyfix.127-0-0-1.sslip.io`
- `pgadmin.teyfix.127-0-0-1.sslip.io`

Certificates are:

- Issued automatically by **Step CA**
- Requested by **Traefik via ACME**
- Trusted locally once the root CA is installed

No DNS configuration is required.

---

## 🔧 Optional Naming Variables (For Reuse)

Examples in the root README intentionally use **hardcoded Traefik names and
domains** to stay focused and easy to read.

Recipes, however, are meant to be **copied, run multiple times, or used across
different projects**. In those scenarios, hardcoded Traefik object names will
collide.

To avoid this, recipes support a small set of optional environment variables
that act as a namespacing and configuration layer.

### `TRAEFIK_SERVICE_PREFIX`

A namespace prefix applied to all Traefik routers and services created by the
recipe.

**Why it exists:** Traefik treats router and service names as global
identifiers. Running the same recipe multiple times without a prefix will cause
silent overwrites.

**Example:**

```env
TRAEFIK_SERVICE_PREFIX=projectA
```

Resulting Traefik objects:

```txt
projectA_pg
projectA_pgadmin
```

---

### `TRAEFIK_BASE_DOMAIN`

The base domain used to construct public hostnames.

**Why it exists:** Recipes dynamically build hostnames like `pg.<base-domain>`
and `pgadmin.<base-domain>` to keep domains consistent and predictable.

**Example:**

```env
TRAEFIK_BASE_DOMAIN=teyfix.127-0-0-1.sslip.io
```

---

### `TRAEFIK_ACME_RESOLVER`

The Traefik ACME certificate resolver to use for TLS.

**Why it exists:** Traefik may be configured with multiple resolvers. Recipes
should not assume a specific one.

**Example:**

```env
TRAEFIK_ACME_RESOLVER=stepca
```

---

### `TRAEFIK_TCP_ENTRYPOINT`

The Traefik entrypoint used for **raw TCP services** such as databases.

**Why it exists:** TCP services require a dedicated entrypoint and are commonly
shared across multiple services.

**Example:**

```env
TRAEFIK_TCP_ENTRYPOINT=shared
```

---

### `TRAEFIK_HTTPS_ENTRYPOINT`

The Traefik entrypoint used for HTTPS services.

**Why it exists:** The default is often `websecure`, but this is a convention,
not a requirement.

**Example:**

```env
TRAEFIK_HTTPS_ENTRYPOINT=websecure
```

---

## 🧪 Available Recipes

### 🐘 PostgreSQL + pgAdmin

A full PostgreSQL setup exposed **securely over TCP with TLS**, plus pgAdmin
over HTTPS.

Demonstrates:

- Traefik **TCP routers** with `HostSNI`
- TLS termination for non-HTTP services
- pgAdmin exposed via standard HTTPS routing
- Healthchecks and persistent volumes
- A realistic database image with extension support

➡️ See: [`postgres/README.md`](./postgres/README.md)

---

## 🧩 Design Principles

Recipes deliberately avoid:

- Custom Traefik static config
- Sidecar proxies
- One-off hacks per service

Instead, they show:

- How Traefik is meant to be used
- How labels map cleanly to routers and services
- How TCP and HTTP coexist under the same proxy
- How local dev can mirror production topology

If something looks “verbose”, that’s intentional — it’s cheaper than implicit
behavior.

---

## 🔧 Using Recipes in Your Own Projects

You are encouraged to:

- Copy recipes into your own repos
- Rename prefixes and domains
- Split services across multiple compose files
- Replace images with your own builds

The only hard dependency is:

- Joining the external `traefik` network
- Using the same entrypoints and cert resolver

Everything else is negotiable.

---

## 🚧 Future Recipes (Planned)

Likely additions:

- Redis (TLS-terminated TCP)
- MySQL / MariaDB
- Kafka / Redpanda
- Keycloak
- Generic “bring your own app” template

Each new recipe should answer one question clearly:

> “How do I put _this_ behind Traefik with real TLS?”

---

## 🧭 Philosophy (Why This Exists)

Local development is where bad assumptions breed.

These recipes exist to:

- Remove the gap between “it works locally” and “it works securely”
- Make TLS boring, even for databases
- Treat infrastructure as something you _practice_, not postpone

Once TLS is normal everywhere, you stop designing systems that quietly depend on
insecurity.
