# MinIO (S3-compatible Object Storage)

This recipe runs **MinIO** behind **Traefik**, exposing both the **S3-compatible
API** and the **MinIO Console** over HTTPS using the existing Traefik + Step CA
setup in this repository.

It is designed for reverse-proxy operation and assumes **all access goes through
Traefik**. Direct host port access is neither required nor supported.

---

## What this provides

- **S3-compatible API** via Traefik → internally `:9000`, externally
  `https://s3.<base-domain>`
- **MinIO Console (Web UI)** via Traefik → internally `:9001`, externally
  `https://minio.<base-domain>`
- Persistent object storage using a Docker volume
- Explicit Traefik router/service naming via environment variables
- Healthchecks suitable for orchestration and dependency management

---

## Exposed endpoints

With the default environment configuration:

```env
TRAEFIK_SERVICE_PREFIX=recipe
TRAEFIK_BASE_DOMAIN=recipe.127-0-0-1.sslip.io
```

The following endpoints are available:

- **S3 API** `https://s3.recipe.127-0-0-1.sslip.io`
- **MinIO Console** `https://minio.recipe.127-0-0-1.sslip.io`

Both endpoints are served over HTTPS with certificates issued by the local Step
CA through Traefik.

---

## Configuration

This recipe relies on environment variables and will fail fast if required
values are missing.

### Required Traefik variables

```env
TRAEFIK_SERVICE_PREFIX=recipe
TRAEFIK_BASE_DOMAIN=recipe.127-0-0-1.sslip.io
TRAEFIK_ACME_RESOLVER=stepca
TRAEFIK_HTTPS_ENTRYPOINT=websecure
```

---

### Required MinIO configuration (reverse-proxy safe)

These settings are **required when MinIO is running behind a reverse proxy**
like Traefik.

Omitting them commonly results in:

- broken or missing JavaScript / CSS in the console
- incorrect redirects to internal container addresses
- mixed-content or CSP violations in the browser

```env
MINIO_ROOT_USER=recipe
MINIO_ROOT_PASSWORD=supersecret

# REQUIRED behind a reverse proxy
MINIO_BROWSER_REDIRECT=false
MINIO_BROWSER_CONTENT_SECURITY_POLICY=default-src 'self'; connect-src 'self' https://unpkg.com https://dl.min.io; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'
```

**Why these matter**

- `MINIO_BROWSER_REDIRECT=false` Prevents the MinIO API from redirecting clients
  to the console URL, which breaks proxied access and confuses SDKs and
  browsers.

- `MINIO_BROWSER_CONTENT_SECURITY_POLICY` Ensures the console can load its
  required JS and CSS assets when served through Traefik under a custom
  hostname. Without this, the UI may partially render or fail silently.

---

## Networking notes

- The service attaches to:
  - a private `minio` network for internal access
  - the shared `traefik_proxy` network for ingress

- The S3 API is reachable internally via the alias `s3.lokal`
- No ports are published directly on the host → **all access flows through
  Traefik**

---

## Healthcheck

The container is considered healthy once MinIO is ready to serve requests:

```sh
mc ready local
```

This allows dependent services to wait reliably instead of racing MinIO at
startup.

---

## Version note (important)

This recipe intentionally pins MinIO to:

```txt
minio/minio:RELEASE.2025-04-22T22-12-26Z
```

Recent MinIO releases have **reduced or removed administrative functionality
from the web console**, pushing more operations toward the `mc` (MinIO Client)
CLI.

Pinning this version preserves the expected console behavior for local
development.

If you upgrade the image tag, review the MinIO release notes carefully and
expect UI-level admin capabilities to change.

---

## Intended use

This setup is for **local development and internal testing**:

- TLS is issued by a local Step CA
- Certificates are not publicly trusted
- Security settings favor correctness behind a reverse proxy over internet-
  facing hardening

Think of it as a pocket S3 universe that behaves _just enough_ like the real
thing to keep your brain honest while your laptop pretends to be a cloud.
