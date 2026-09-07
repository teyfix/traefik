---
title: Traefik Agent Rule Map
description: Entry point for agents configuring shared ingress or onboarding a developer.
---

# Agent instructions

The explicit user request and its owning GitHub issue define the authorized
target and scope. Preserve existing edits and state. Commit only when authorized.

When the user explicitly asks to start or resume onboarding, read
`.agents/rules/onboarding.md` and the
[onboarding questionnaire](compose/tailscale/ONBOARDING.md). Do not load them
or check an onboarding file during ordinary sessions. Missing onboarding
inputs never block unrelated work.

For assigned infrastructure work, read [README.md](README.md) and the
[Tailscale operator guide](compose/tailscale/README.md) for the current design.
