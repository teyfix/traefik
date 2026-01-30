# Redpanda (Kafka-compatible) Recipe

This recipe runs **Redpanda** (a Kafka-compatible event streaming platform)
behind **Traefik**, exposing:

- Kafka (TCP + TLS via Traefik)
- [Redpanda Console](https://www.redpanda.com/data-streaming/redpanda-console-kafka-ui)
- [Kafka UI](https://github.com/kafbat/kafka-ui) _(as an alternative to Redpanda
  Console)_

Compared to the Postgres recipe, this setup is intentionally more complex.
Kafka-style systems are extremely sensitive to **advertised addresses**, and
most local setups fail precisely because this part is misunderstood. This README
exists to make that explicit.

---

## Mental model: internal vs external traffic

Redpanda distinguishes between:

- **Where it listens** (`--*-addr`)
- **What it tells clients to connect to** (`--advertise-*-addr`)

Those two must differ when you put Traefik (or any proxy) in front of Kafka.

### Kafka listeners in this recipe

```text
--kafka-addr
  internal://0.0.0.0:9092
  external://0.0.0.0:19092

--advertise-kafka-addr
  internal://kafka.lokal:9092
  external://kafka.${TRAEFIK_BASE_DOMAIN}:4040
```

This creates **two access paths** to the same broker:

- **Internal (Docker network)**
  - Host: `kafka.lokal`
  - Port: `9092`
  - Protocol: plain TCP

- **External (via Traefik)**
  - Host: `kafka.${TRAEFIK_BASE_DOMAIN}`
  - Port: `4040` (Traefik TCP entrypoint)
  - Protocol: TLS

---

## Which port should clients use?

This is the most important rule in this recipe:

### Clients inside the same Docker network

Use:

```text
kafka.lokal:9092
```

Examples:

- Other services in this compose file
- Local development services attached to the `kafka` network
- [Redpanda Console](./docker-compose.yaml)
- [Kafka UI](./docker-compose.yaml)

They **must not** go through Traefik.

### Clients outside Docker (host, laptop, CI, etc.)

Use:

```text
kafka.${TRAEFIK_BASE_DOMAIN}:4040
```

This traffic:

- Goes through Traefik
- Uses TLS
- Matches the advertised external address

If an external client connects on any other port, Kafka metadata will point it
at unreachable brokers and the client will fail in confusing ways.

---

## Why Traefik TCP is required

Kafka is not HTTP. It is a long-lived, stateful TCP protocol that embeds broker
addresses inside metadata responses.

Because of that:

- Kafka **cannot** be exposed via HTTP routers
- TLS termination must happen at Traefik
- The broker must advertise the same host/port that clients actually use

This recipe wires Traefik as a **TCP router**:

```yaml
traefik.tcp.routers.${TRAEFIK_SERVICE_PREFIX?}_kafka.rule=HostSNI(`kafka.${TRAEFIK_BASE_DOMAIN}`)
```

That `HostSNI` must exactly match the advertised external Kafka address.

---

## Included services

### Redpanda

- Single-node, dev-container mode
- 1 CPU, 2GB RAM (minimum for sanity)
- Persistent data volume
- Health check via Admin API

### Redpanda Console

- Connects **internally** using `kafka.lokal:9092`
- Exposed via HTTPS through Traefik
- Safe to use in parallel with Kafka UI

### Kafka UI

- Dynamic config enabled
- Also connects internally
- Useful for topic inspection and message browsing

---

## Environment variables

This recipe relies on the same Traefik conventions as the other recipes:

- `TRAEFIK_SERVICE_PREFIX`
- `TRAEFIK_BASE_DOMAIN`
- `TRAEFIK_TCP_ENTRYPOINT`
- `TRAEFIK_HTTPS_ENTRYPOINT`
- `TRAEFIK_ACME_RESOLVER`

See `.env.example` for concrete values.

The prefix exists to prevent collisions when running **multiple Kafka clusters**
side-by-side.

---

## Common failure modes (and why this recipe avoids them)

- ❌ Using the external port (`4040`) from inside Docker
- ❌ Advertising `localhost` to Kafka clients
- ❌ Mixing HTTP routers with Kafka traffic
- ❌ Letting Kafka guess its own advertised address

All of these lead to clients that connect successfully and then immediately
fail.

This recipe pins every address explicitly so failures are loud and
understandable.

---

## When to use this recipe

Use this when you want:

- A realistic Kafka-compatible stack locally
- TLS everywhere, even in development
- Predictable networking behavior
- A reference for how Kafka _actually_ works behind a proxy

If you only need a message queue, **this is overkill.**

If you want to understand event streaming infrastructure without lying to
yourself, **this is the right level of complexity.**
