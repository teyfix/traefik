---
title: Traefik Agent Rule Map
summary: Preserve the public standalone ingress distribution and route assigned infrastructure or onboarding work.
description: Entry point for agents configuring shared ingress or onboarding a developer.
---

# Agent instructions

The explicit user request and its owning GitHub issue define the authorized
target and scope. Preserve existing edits and state. Commit only when authorized.

The complete MIT-licensed ingress stack is a public, standalone distribution.
Compose definitions, onboarding, configuration templates and documentation MUST
remain publicly usable without `teyfix/upstream`. An operator's configured
instance may live elsewhere. Any consolidation into Containers must preserve
this public contract, including a supported standalone reference stack; a
private catalog cannot become a required dependency. Apply the shared
[distribution boundary](/../memory/rules/architecture.md#repository-and-distribution-boundaries).

When the user explicitly asks to start or resume onboarding, read
`.agents/rules/onboarding.md` and the
[default onboarding](README.md#set-up-a-host). Do not load them
or check an onboarding file during ordinary sessions. Missing onboarding
inputs never block unrelated work.

For assigned infrastructure work, read [README.md](README.md) and the
[legacy Tailscale operator guide](compose/tailscale/README.md) only when working on an existing split-container installation. The default is the bundled single-container stack in `docker-compose.yaml`; users do not select an image or supply a Containers checkout.

Keep `AGENTS.md` and every Markdown file under `.agents/rules/` at most 12,000
Unicode code points, including frontmatter. Move procedural detail to linked
docs and route any new rule shards here. After editing rules or their checker,
run `task check:agent-rules` (install check dependencies with
`bun install --frozen-lockfile` first). This validates repository changes;
it is not an onboarding prerequisite for ordinary sessions.
