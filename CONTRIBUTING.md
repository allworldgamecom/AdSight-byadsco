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

Two automated paths run independently:

- **Deploy to Cloud Run** — every push to `main` triggers [.github/workflows/deploy.yml](.github/workflows/deploy.yml). Production updates immediately; there is no manual step.
- **Publish to GitHub Packages** — every published GitHub Release triggers [.github/workflows/publish.yml](.github/workflows/publish.yml). Pushes the npm package to `npm.pkg.github.com` (`@byadsco/meta-ads-mcp`) and the container image to `ghcr.io/byadsco/meta-ads-mcp` tagged with the release semver.

### Cutting a new release

1. **Open a PR that bumps `version` in [package.json](package.json) only.** Use semver — `2.0.2` for fix-only, `2.1.0` for new features, `3.0.0` for breaking changes. Edit the `version` field by hand. **Do not run `npm version` locally** — it creates the git tag at the same time, which collides with the tag `gh release create` will make on the squash-merge commit and leaves the repo half-bumped.
2. **Merge the PR.** Branch protection requires a CODEOWNERS review; since you can't review your own PR, admin bypass is fine for a version-only change.
3. **Create the release on the merged commit:**

    ```bash
    git checkout main && git pull
    gh release create vX.Y.Z --target main --generate-notes
    ```

    `--target main` tells `gh release create` to make the tag at the latest commit on `main` (the squash merge from step 2). `--generate-notes` populates the release body from the merged PRs since the previous tag. If a release for that tag already exists `gh` errors out with HTTP 422, which is the collision check we want — do **not** add `--verify-tag`, that flag does the opposite (aborts when the tag does *not* exist remotely).

4. **Watch `publish.yml`:**

    ```bash
    gh run list --workflow="Publish to GitHub Packages" --limit 1
    ```

    When it goes green, verify the artifacts:

    ```bash
    docker pull ghcr.io/byadsco/meta-ads-mcp:X.Y.Z
    npm view @byadsco/meta-ads-mcp@X.Y.Z --registry=https://npm.pkg.github.com
    ```

For a **prerelease** (`v3.0.0-rc.1`, `v3.0.0-beta.2`), pass `--prerelease` to `gh release create`. `publish.yml` detects the flag and (a) publishes the npm package under the `next` dist-tag instead of `latest`, and (b) skips emitting the `:latest` Docker tag — the semver-shaped tags still ship.

## Questions

Open a discussion or an issue. We try to respond within a few business days.
