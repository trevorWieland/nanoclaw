# Fork Overview

This repository (`trevorWieland/nanoclaw`) is a personal public fork of upstream [qwibitai/nanoclaw](https://github.com/qwibitai/nanoclaw).

## Fork Philosophy

- Keep core NanoClaw concepts easy to learn.
- Make fork-specific choices explicit instead of implicit.
- Optimize docs for friends/family remixing a personal assistant fork.
- Route substantial product improvements upstream so ecosystem behavior stays aligned.

## Upstream vs This Fork

| Area                                  | Upstream NanoClaw                                 | This Fork                                       |
| ------------------------------------- | ------------------------------------------------- | ----------------------------------------------- |
| Core model                            | Single-process orchestrator + container isolation | Same core model                                 |
| Target audience                       | Broad NanoClaw users                              | Friends/family remixing Trevor's setup          |
| Docs framing                          | Canonical project framing                         | Explicit fork overlays and remix guidance       |
| Contribution target for major changes | Upstream repository                               | Upstream repository                             |
| Contribution target for fork context  | Not applicable                                    | This fork (docs and small personal adjustments) |

## What This Fork Adds

- **Postgres backend** — pluggable DataStore interface with SQLite (default) and Postgres adapters
- **Docker-out-of-Docker** — host NanoClaw runs in Docker, spawns agent containers via docker.sock
- **Health monitoring** — extensible health sources, status server endpoint
- **Tanren integration** — VM provisioning via API client and container-side MCP server
- **Auth circuit breaker** — backoff cooldown on 401/403 to prevent retry storms
- **Credential proxy enhancements** — OAuth token auto-refresh, credentials.json fallback
- **Message deduplication** — SHA256 fingerprint prevents duplicate outbound messages
- **Modernized toolchain** — pnpm, tsgo, oxfmt, oxlint, vitest, turbo, knip (replacing npm/prettier/eslint)
- **Extracted modules** — group-processor, message-loop, recovery for testability
- **Remote control** — Claude Code editor integration for session management

## Who Should Use This Fork

Use this fork if you:

- Want the full feature set (Postgres, Docker-out-of-Docker, health monitoring, tanren integration).
- Want a practical remix base with clear docs for personal use.
- Prefer explicit guidance on what to keep local vs what to upstream.

Use upstream if you:

- Want the canonical baseline without fork-specific additions.
- Plan to contribute substantive platform improvements directly.

## Fork vs Other Approaches (High-Level)

- Hosted chat products are convenient but do not provide this fork's self-hosted isolation and repo-level customization model.
- Chat UI frontends are strong for model access but are not opinionated assistant runtimes with group isolation + scheduled task orchestration.
- Agent libraries are app-building toolkits; NanoClaw is a running assistant runtime with channel routing and operational workflows.

## Upstream Relationship

- **Origin** is your personal fork clone.
- **Upstream** remains `qwibitai/nanoclaw`.
- Substantial fixes/features should be proposed upstream first.
- This fork should stay close enough to upstream that sync is routine; see [FORK_SYNC.md](./FORK_SYNC.md).

## Public Fork vs Private Assistant Config

- Keep runtime code and shared docs in this fork.
- Keep personal assistant identity, group memory, schedules, and sensitive conventions in private config.
- See [INSTALLATION_MODEL.md](./INSTALLATION_MODEL.md) for recommended layout.
