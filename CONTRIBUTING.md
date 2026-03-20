# Contributing

This repository is a personal public fork (`trevorWieland/nanoclaw`) of upstream [qwibitai/nanoclaw](https://github.com/qwibitai/nanoclaw).

## Where Contributions Should Go

**Contribute upstream (`qwibitai/nanoclaw`) for:**

- New features or capabilities
- Substantive bug fixes
- Broad refactors or architecture changes
- Compatibility/platform expansions

**Contribute to this fork for:**

- Fork-specific documentation (`README`, `docs/START_HERE.md`, `docs/FORK_*.md`)
- Clarifications that help friends/family remix this fork
- Small personal adjustments that do not change core project direction

## Source Code Changes in This Fork

Changes here should stay narrow and easy to sync with upstream.

- Preferred: simplifications, doc-linked comments, minor maintenance
- Avoid: large behavioral divergence from upstream unless explicitly intentional and documented

If your change could benefit most NanoClaw users, open it upstream first.

## Skills Contributions

A [skill](https://code.claude.com/docs/en/skills) is a markdown file in `.claude/skills/` that teaches Claude Code how to transform a NanoClaw installation.

Submit broadly useful skills to upstream `qwibitai/nanoclaw`; keep fork-specific skills here.

A PR that contributes a skill should not modify source files.

Your skill should contain the **instructions** Claude follows to add the feature, not pre-built code. See `/add-telegram` for a good example.

## Testing Expectations

- Test your skill or doc workflow on a fresh clone before submitting.
- For fork-specific docs changes, verify links and cross-doc consistency.

## Error Handling

Catch blocks in this codebase fall into four categories:

1. **Handled** — the error triggers recovery logic (retry, fallback, circuit-breaker trip)
2. **Re-thrown with context** — caught, wrapped with additional context, then re-thrown
3. **Logged with sufficient detail** — caught and logged with enough structured context to diagnose from logs alone
4. **Swallowed** — caught with no logging or incomplete context (**avoid this**)

### Guidelines

- **Re-throw vs log-and-continue:** Re-throw when the caller needs to know the operation failed. Log-and-continue when the operation is best-effort and the system can proceed without it.
- **Custom error classes:** Only create them when callers need `instanceof` branching (see `PartialSendError` in `src/types.ts` and `TanrenAPIError` in `src/tanren/errors.ts`).
- **Required context in error logs:** Include the operation being attempted, group name/JID if applicable, and relevant IDs or input values that help reproduce the issue.
- **Pino structured logging:** Object first, message second: `logger.warn({ err, groupJid }, "Failed to write IPC message")`. Always pass errors under the `err` key (e.g. `{ err }`, not `{ error: err }`); never stringify errors — Pino serializes errors on the `err` key automatically.
- **Intentional suppression:** If a catch block must be empty, add a comment: `// Intentionally suppressed: <reason>`.

## Documentation Source of Truth

Keep docs aligned to this split:

- `README.md`: concise overview and navigation
- `docs/SPEC.md`: implementation behavior and interfaces
- `docs/SECURITY.md`: trust boundaries and security controls
- `docs/ARCHITECTURE.md`: operating model and orchestration patterns
- `docs/INSTALLATION_MODEL.md`: code/config separation and group setup patterns
- `ROADMAP.md`: planned or exploratory future work

If you touch behavior and docs in the same PR, update the canonical doc first, then any summary docs.

## Documentation Change Checklist

For behavior changes or major doc refactors:

1. Update canonical docs listed above.
2. Update `README.md` links/summaries to match.
3. Confirm wording in `docs/FORK_OVERVIEW.md` and `docs/FORK_SYNC.md` is still accurate.
4. If migrating or retiring docs, update `docs/HLD_MIGRATION_MAP.md` (or equivalent mapping) before deletion.
5. Run formatting/check commands and validate markdown links.

## Docs Terminology Consistency

- Use `friends/family` (plural) when describing this fork's remix audience.
- Keep `Fork-specific note` capitalization/punctuation consistent when adding callouts in docs.
