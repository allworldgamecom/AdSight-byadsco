# Contributing to Meta Ads MCP

Thanks for considering a contribution. This guide covers how to set up the project, the checks your change must pass, and the conventions we follow. If anything here is unclear, open an issue and we'll fix the docs.

## Code of conduct

Be kind, assume good intent, focus on the technical issue. Disrespectful behavior, harassment, or sustained derailing will get you disinvited.

## Project setup

```bash
git clone https://github.com/byadsco/meta-ads-mcp.git
cd meta-ads-mcp
npm install
cp .env.example .env   # fill in only what you need for the mode you'll test
```

You need **Node.js 20+**. The Docker image runs on Node 22; both work for development.

For multi-tenant HTTP testing locally:

```bash
gcloud beta emulators firestore start --host-port=localhost:8085 &
export FIRESTORE_EMULATOR_HOST=localhost:8085
npm run dev
```

For single-tenant stdio testing (no Firestore, no Meta App):

```bash
META_ACCESS_TOKEN=EAA... npm run dev:stdio
```

## Required checks before opening a PR

CI ([.github/workflows/ci.yml](.github/workflows/ci.yml)) runs all of these. Run them locally first — it's faster than waiting for CI:

```bash
npm run lint        # eslint src/
npm run typecheck   # tsc --noEmit
npm test            # vitest run
npm run build       # tsc, must produce a clean dist/
```

A separate CI job runs [gitleaks](https://github.com/gitleaks/gitleaks) against the diff using [.gitleaks.toml](.gitleaks.toml). If it flags your change, the credential pattern is real — do not whitelist; rotate and remove.

## Repository conventions

- **No code comments unless the *why* is non-obvious.** Names should explain the *what*. Don't add doc-block boilerplate.
- **No `--no-verify` on git commits.** If a hook fails, fix the cause.
- **Don't commit `.env*`** (except `.env.example`). They are gitignored; never `git add -f` them.
- **Tests live under [tests/](tests/)** mirroring the `src/` paths.
- **TypeScript strict mode.** No `any` unless you can justify it in review.
- **Zod schemas** for every tool input. The MCP SDK relies on them for both validation and the JSON Schema served to clients.
- **Pino structured logs.** Use `event=...` keys for anything an operator might grep for; never log a Meta token in plaintext (`maskToken()` exists for this).

## Auth surface — extra scrutiny

Changes under [src/auth/](src/auth/) and [src/transport/security-config.ts](src/transport/security-config.ts) carry higher risk. Even small changes here:

- Need a passing test that exercises the affected flow.
- Should explain in the PR description what the threat model assumption is and why your change preserves it.
- Will get reviewed by a maintainer before merge — please be patient if it takes a couple of days.

If your change touches the encryption layer, the OAuth provider, the session cookie shape, or the Firestore document layout, **mention it explicitly in the PR title** (e.g. `auth: rotate session cookie format`).

## Commit messages

Follow conventional-commits-ish prefixes:

- `feat:` new functionality
- `fix:` bug fix
- `chore:` deps, tooling, non-product changes
- `refactor:` no behavior change
- `docs:` README / SECURITY.md / inline docs
- `test:` test-only changes
- `ci:` GitHub Actions changes

Keep the subject under 70 characters and let the body explain *why*. The recent log on `main` is a good reference for tone.

## Pull requests

- **One topic per PR.** If you find adjacent issues, file separate PRs or issues.
- **Describe the change** — what, why, how to verify.
- **Reference the issue number** if any.
- **Self-review the diff** before requesting a review. Things you should catch yourself: leftover `console.log`, debug branches, hardcoded test values, commented-out code.
- **Update docs in the same PR** when you change behavior. README and SECURITY.md count.

## Reporting bugs

For regular bugs: open a GitHub Issue with a clear repro and the version (`git rev-parse HEAD`).

For **security** bugs: do **not** open a public issue. Follow [SECURITY.md](SECURITY.md).

## Releasing

The project deploys automatically to Cloud Run on every push to `main` via [.github/workflows/deploy.yml](.github/workflows/deploy.yml). There are no tagged releases yet. If we adopt them, this section will document the process.

## Questions

Open a discussion or an issue. We try to respond within a few business days.
