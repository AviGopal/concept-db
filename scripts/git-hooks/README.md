# concept-db git hooks

Versioned git hooks for the `concept-db` vessel. Installed by running:

```bash
scripts/git-hooks/install.sh
```

This sets `core.hooksPath` to `scripts/git-hooks/` so updates to the hooks land via `git pull`, not by re-copying files into `.git/hooks/`. Same pattern as the `metabob-devbob` super-repo and the deployment repo.

## What concept-db is

A TypeScript/Bun vessel that resolves concept-graph shapes — `concept`, `conceptGraph`, `relatedConcepts`, `conceptUsageStats`, `conceptSequence`. Registers with discovery-vessel, observes activity-api WebSocket events for cross-vessel passive learning, and exposes resolution via `POST /v2/impulses/resolve`.

## Philosophy

The vessel tree coordinates:

- `src/` — TypeScript source
- `test/` / `tests/` — vessel tests
- `sql/` — schema migrations
- `docs/` — stateless reference documentation
- `scripts/` — operational scripts
- `examples/` — example payloads, fixtures
- a small allowlist of project metadata at root (`CLAUDE.md`, `README.md`, `package.json`, `tsconfig.json`, `Dockerfile`, `bun.lock`, `.gitignore`)

Anything else accumulates as cruft. The pre-commit hook rejects new cruft at commit time. Existing files are grandfathered — the hook only checks newly-added or renamed-into entries.

## Where things go

| You have | Put it in |
|---|---|
| Stateless reference doc | `docs/<topic>.md` |
| One-off operational script | `scripts/<verb>-<noun>.sh` |
| New SQL migration | `sql/migrations/` |
| Example payload / fixture | `examples/` or `fixtures/` |
| Vessel test | `test/` or `tests/` |
| Status snapshot, fix-complete, investigation | nowhere — write a commit message instead |

## What the pre-commit hook does

The hook runs two layers, in order:

1. **Placement check** — rejects newly-added or renamed-into entries that violate the placement rules. Pre-existing files are grandfathered.
2. **Secrets scan (`gitleaks protect --staged`)** — if gitleaks isn't installed, the scan is skipped with a one-line install hint.

Bypass with `git commit --no-verify` (use sparingly).

## What the pre-commit hook blocks

A commit is rejected when it adds (or renames into) a file that violates any of these rules:

1. **Files at the vessel root** are limited to a small allowlist of project metadata. Everything else needs a home under one of the allowed top-level dirs.
2. **No new top-level markdown** outside `docs/`. Use commit messages for one-off writeups.
3. **No new ad-hoc scripts at root** (`*.sh`, `*.ts`, `*.js`, `*.py`). Scripts go in `scripts/`; source goes in `src/`.
4. **No new test files at root**. Tests live in `test/` or `tests/`.
5. **No new image / video / archive files** outside `docs/assets/`.
6. **No new top-level directories** outside the allowed set.

## Bypass

```bash
git commit --no-verify
```

Use sparingly. The rules exist to keep `git blame` readable.

## Extending the rules

Edit `scripts/git-hooks/pre-commit`:

- `ROOT_ALLOWLIST` — exact-name files allowed at the vessel root.
- `ALLOWED_TOPLEVEL_DIRS` — directories allowed at the vessel root.
- `ARTEFACT_EXTENSIONS` — pipe-separated extensions treated as binary artefacts.

Add a comment explaining the change so future readers understand the carve-out.
