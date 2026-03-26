# NanoClaw

Personal Claude assistant. See [README.md](README.md) for philosophy and setup. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for system architecture.

## Quick Context

Single Node.js process with skill-based channel system. Channels (WhatsApp, Telegram, Slack, Discord, Gmail) are skills that self-register at startup. Messages route to Claude Agent SDK running in containers (Linux VMs). Each group has isolated filesystem and memory.

## Key Files

| File                       | Purpose                                                             |
| -------------------------- | ------------------------------------------------------------------- |
| `src/index.ts`             | Orchestrator: state, message loop, agent invocation                 |
| `src/channels/registry.ts` | Channel registry (self-registration at startup)                     |
| `src/ipc.ts`               | IPC watcher and task processing                                     |
| `src/router.ts`            | Message formatting and outbound routing                             |
| `src/config.ts`            | Trigger pattern, paths, intervals                                   |
| `src/container-runner.ts`  | Spawns agent containers with mounts                                 |
| `src/task-scheduler.ts`    | Runs scheduled tasks                                                |
| `src/db.ts`                | Database operations (delegates to datastore adapters)               |
| `src/tanren/`              | Tanren API client (VM provisioning, dispatch)                       |
| `groups/{name}/CLAUDE.md`  | Per-group memory (isolated)                                         |
| `container/skills/`        | Skills loaded inside agent containers (browser, status, formatting) |

## Secrets / Credentials / Proxy (OneCLI)

API keys, secret keys, OAuth tokens, and auth credentials are managed by the OneCLI gateway — which handles secret injection into containers at request time, so no keys or tokens are ever passed to containers directly. Run `onecli --help`.

## Skills

Four types of skills exist in NanoClaw. See [CONTRIBUTING.md](CONTRIBUTING.md) for the full taxonomy and guidelines.

- **Feature skills** — merge a `skill/*` branch to add capabilities (e.g. `/add-telegram`, `/add-slack`)
- **Utility skills** — ship code files alongside SKILL.md (e.g. `/claw`)
- **Operational skills** — instruction-only workflows, always on `main` (e.g. `/setup`, `/debug`)
- **Container skills** — loaded inside agent containers at runtime (`container/skills/`)

| Skill              | When to Use                                                    |
| ------------------ | -------------------------------------------------------------- |
| `/setup`           | First-time installation, authentication, service configuration |
| `/customize`       | Adding channels, integrations, changing behavior               |
| `/debug`           | Container issues, logs, troubleshooting                        |
| `/update-nanoclaw` | Bring upstream NanoClaw updates into a customized install      |
| `/update-skills`   | Check for and apply updates to installed skill branches        |

## Contributing

Before creating a PR, adding a skill, or preparing any contribution, you MUST read [CONTRIBUTING.md](CONTRIBUTING.md). It covers accepted change types, the four skill types and their guidelines, SKILL.md format rules, PR requirements, and the pre-submission checklist (searching for existing PRs/issues, testing, description format).

## Development

Run commands directly—don't tell the user to run them.

```bash
pnpm run dev           # Run with hot reload
pnpm run build         # Compile TypeScript (tsgo)
pnpm run check         # Run all checks in parallel (format, lint, typecheck, test)
./container/build.sh   # Rebuild agent container
```

### Tooling

| Tool   | Command               | Purpose                                    |
| ------ | --------------------- | ------------------------------------------ |
| oxfmt  | `pnpm run format:fix` | Format all project files                   |
| oxlint | `pnpm run lint`       | Lint for correctness issues                |
| tsgo   | `pnpm run typecheck`  | Type-check without emitting                |
| vitest | `pnpm run test`       | Run 360+ unit tests                        |
| knip   | `pnpm run knip`       | Detect dead code and unused deps           |
| turbo  | `pnpm run check`      | Run format+lint+typecheck+test in parallel |

### Maintenance

```bash
pnpm outdated          # Check for outdated dependencies
pnpm audit             # Check for known CVEs
pnpm run knip          # Find dead code / unused exports
pnpm update            # Update within semver ranges
pnpm update --latest   # Update to latest (review breaking changes first)
```

Service management:

```bash
# macOS (launchd)
launchctl load ~/Library/LaunchAgents/com.nanoclaw.plist
launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist
launchctl kickstart -k gui/$(id -u)/com.nanoclaw  # restart

# Linux (systemd)
systemctl --user start nanoclaw
systemctl --user stop nanoclaw
systemctl --user restart nanoclaw
```

## Troubleshooting

**WhatsApp not connecting after upgrade:** WhatsApp is now a separate channel fork, not bundled in core. Run `/add-whatsapp` (or `git remote add whatsapp https://github.com/qwibitai/nanoclaw-whatsapp.git && git fetch whatsapp main && git merge whatsapp/main && pnpm run build`) to install it. Existing auth credentials and groups are preserved.

## Container Build Cache

The container buildkit caches the build context aggressively. `--no-cache` alone does NOT invalidate COPY steps — the builder's volume retains stale files. To force a truly clean rebuild, prune the builder then re-run `./container/build.sh`.
