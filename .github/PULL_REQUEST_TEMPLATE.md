<!--
Thanks for contributing to meta-ads-mcp.

Please complete the sections below. PRs that skip the security checklist or
the verification steps are likely to be sent back. See CONTRIBUTING.md for the
full contribution guide.
-->

## Summary

<!-- One or two sentences: what changes and why. -->

## Why

<!-- The motivation. Link an issue if there is one (Fixes #123). -->

## How to verify

<!-- Reproducible steps. Commands, URLs, logs, screenshots — whatever makes
the reviewer's life easier. -->

```bash
# example
npm test
```

## Tests

<!-- Which tests cover this change? If none, explain why. -->

- [ ] New tests added under `tests/` mirroring the source path
- [ ] Existing tests still pass (`npm test`)
- [ ] Manual verification against a real dev environment (describe below)

## Checklist

- [ ] `npm run lint`, `npm run typecheck`, `npm test`, `npm run build` all pass locally
- [ ] No secrets in the diff (env vars, tokens, keys). If unsure, run `gitleaks git --staged --config .gitleaks.toml`
- [ ] Updated relevant docs (`README.md`, `SECURITY.md`, `CONTRIBUTING.md`) if behavior changed
- [ ] Conventional commit prefix in title (`feat:`, `fix:`, `chore:`, `docs:`, `refactor:`, `test:`, `ci:`)

## Auth / security surface

Tick **all** that apply. If any box is ticked, expect extra review scrutiny and
explain the threat-model impact in the description.

- [ ] Touches `src/auth/`, `src/store/`, or `src/transport/security-config.ts`
- [ ] Modifies the OAuth flow, session cookie shape, or Firestore document layout
- [ ] Adds, removes, or rotates an environment variable referenced as a secret
- [ ] Changes a GitHub Actions workflow under `.github/workflows/`
- [ ] Adds a new third-party dependency (production or dev)
- [ ] Loosens an existing access check or allowlist

If none of the above apply, write *None* below and the bot will not block on
the security reviewer.

> _Threat-model notes:_
