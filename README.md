# Meta Ads MCP Server

> **Self-hosted Model Context Protocol (MCP) server that gives Claude, ChatGPT and other AI agents secure, multi-tenant access to the Meta Marketing API for Facebook Ads and Instagram Ads.** Built for advertising agencies managing many client ad accounts from a single AI assistant — with OAuth login, encrypted-at-rest tokens, rate-limit compliance and circuit breakers baked in.

[![License: MIT](https://img.shields.io/github/license/byadsco/meta-ads-mcp)](LICENSE)
[![CI](https://img.shields.io/github/actions/workflow/status/byadsco/meta-ads-mcp/ci.yml?branch=main&label=CI)](https://github.com/byadsco/meta-ads-mcp/actions/workflows/ci.yml)
[![Node](https://img.shields.io/badge/node-%3E%3D20-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![MCP](https://img.shields.io/badge/MCP-1.29-7c3aed)](https://modelcontextprotocol.io)
[![Cloud Run ready](https://img.shields.io/badge/Cloud_Run-ready-4285F4?logo=googlecloud&logoColor=white)](https://cloud.google.com/run)

## Table of contents

- [What is Meta Ads MCP?](#what-is-meta-ads-mcp)
- [Who is this for?](#who-is-this-for)
- [Features](#features)
- [Tools (80 total)](#tools-80-total)
- [Quick start](#quick-start)
- [Authentication — three modes](#authentication--three-modes)
- [Setting up Sign in with Meta](#setting-up-sign-in-with-meta)
- [Registering System User tokens (no expiry)](#registering-system-user-tokens-no-expiry)
- [Connecting AI clients](#connecting-ai-clients)
- [Architecture overview](#architecture-overview)
- [Meta API compliance](#meta-api-compliance)
- [Deployment](#deployment)
- [Local development](#local-development)
- [Security](#security)
- [FAQ / troubleshooting](#faq--troubleshooting)
- [Contributing](#contributing)
- [Resources](#resources)
- [License](#license)

## What is Meta Ads MCP?

**Meta Ads MCP Server** is an open-source [Model Context Protocol](https://modelcontextprotocol.io) server that exposes the [Meta Marketing API](https://developers.facebook.com/docs/marketing-apis) — the API behind Facebook Ads and Instagram Ads — as a set of well-typed tools that any MCP-compatible AI agent can call. Drop it in front of Claude, ChatGPT, Cline, Continue or any other MCP client and your assistant can manage campaigns, ad sets, creatives, audiences, insights, leads, comments and pixels across an unlimited number of ad accounts.

It is **multi-tenant by design**. Each user signs in with **Facebook Login** on a consent page, their long-lived (60-day) Meta token is encrypted with AES-256-GCM and stored in Firestore, and every MCP request automatically picks up the right token. There is no shared PIN, no token pasting, no plaintext at rest.

It is **compliance-first**. Every Meta throttling header (`X-App-Usage`, `X-Business-Use-Case-Usage`, `x-fb-ads-insights-throttle`, `x-ad-account-usage`, reach throttle) is parsed and respected per `(token, account, use-case)` bucket. A circuit breaker stops all calls for an account on abuse signal `1996` or repeated throttles. Insights guardrails reject dangerous parameter combinations *before* they hit Graph API.

It is **deploy-ready**. Stateless Streamable HTTP transport, Docker image, GitHub Actions workflow that ships to Google Cloud Run with Workload Identity Federation, gitleaks-scanned on every push, masked health checks. Or run it via `stdio` for single-tenant local use with Claude Desktop.

## Who is this for?

- **Marketing agencies** that manage many client ad accounts and want one AI assistant that can act across all of them.
- **In-house marketing teams** with multiple users who need their own Meta token but a shared MCP endpoint.
- **Developers** building AI-powered tools, copilots or autonomous agents on top of Meta Ads.
- **Solo operators** who want to drive their own Meta account from Claude Desktop with zero infrastructure (`stdio` mode).

## Features

- **80 tools** covering campaign management, creatives, targeting, audiences, reporting, comments, billing, tokens, Instagram workflows, and rate-limit observability.
- **Sign in with Meta (Facebook Login)** — replaces shared PINs. Each user lands their own long-lived (60-day) Meta token.
- **System User token registry** — for tokens that don't expire, register them per user from the consent UI.
- **Encrypted persistence** — Meta tokens stored AES-256-GCM in Firestore; survive restarts so connections never drop.
- **Email / domain / FB-id allowlist** — public repo, private deployment: only listed identities can sign in.
- **Multi-account support** — each request carries its own Meta access token via `AsyncLocalStorage` request context.
- **Cloud-ready** — Streamable HTTP transport, stateless, Docker-ready, Google Cloud Run reference deploy.
- **Stdio support** — for local development with MCP clients like Claude Desktop.
- **Compliance-first rate limiting** — per-`(token, ad-account, use-case)` bucketing of every throttle signal Meta publishes; reacts to `estimated_time_to_regain_access` instead of blind backoff.
- **Circuit breaker** — abuse-signal (subcode 1996), temporary-block and repeated-throttle events stop all calls for the affected account, following Meta's explicit *"stop making API calls"* rule.
- **Preventive write pacing** — Ads Management `POST`/`DELETE` are paced against the hourly BUC quota so bursts from agents never blow the limit.
- **Insights guardrails** — dangerous parameter combinations (account-level + high-cardinality breakdowns, lifetime + breakdowns in sync, `time_range` > 37 months) are rejected *before* hitting Meta.
- **Async reports with safe polling** — `meta_ads_run_report_and_wait` one-shot with 5 s-min / 60 s-max backoff, proper `Job Failed` / `Job Skipped` handling.
- **Retry logic** — exponential backoff on truly transient errors only (never on throttled requests).

## Tools (80 total)

| Category | Tools | Description |
|---|---|---|
| Accounts | 3 | List accounts, get info, get pages |
| Campaigns | 5 | CRUD + status management |
| Ad Sets | 6 | CRUD with full targeting spec |
| Ads | 5 | CRUD with creative assignment |
| Creatives | 9 | List creatives, creative details, create/update creatives, image/video library and uploads |
| Insights | 2 | Performance metrics with breakdowns |
| Targeting | 7 | Interest / behavior / geo search, audience estimation |
| Budget | 1 | Budget schedule management |
| Leads | 4 | Lead forms and lead retrieval |
| Audiences | 5 | Custom audiences and lookalikes |
| Previews | 2 | Ad previews before launch |
| Pixels | 5 | Pixel details, events, and conversions |
| Comments | 4 | Ad comment moderation |
| Rules | 5 | Automated rules and rule details |
| A/B Testing | 3 | Ad study creation and inspection |
| Reports | 4 | Async report creation, status, retrieval, and one-shot run+wait |
| Billing | 3 | Billing info and spend limits |
| Instagram | 2 | IG account and media lookup |
| Tokens | 4 | List / set-active / register / delete |
| Rate Status | 1 | Live view of quota usage, open circuits and write-pacer state |

Tool definitions live under [src/tools/](src/tools/), wired together in [src/tools/index.ts](src/tools/index.ts).

## Quick start

### Prerequisites

- **Node.js 20+** (Node 22 used in the Docker image).
- A **Meta access token** with `ads_management` and `ads_read` permissions, *or* a Meta App configured for Facebook Login (see below).

### Install & run

```bash
git clone https://github.com/byadsco/meta-ads-mcp.git
cd meta-ads-mcp
npm install
npm run build
npm start
```

The server starts on `http://localhost:3000` with the `/mcp` endpoint and a health check at `/health`.

### Environment variables

See [.env.example](.env.example) for the full list. The minimum to run an HTTP deployment with Meta OAuth login:

```bash
SERVER_URL=https://your-host.com   # required for OAuth redirect URIs
META_APP_ID=...                    # your Meta app
META_APP_SECRET=...
AUTH_ALLOWED_EMAILS=you@x.com      # at least one allowlist source required
TOKEN_ENCRYPTION_KEY=$(openssl rand -hex 32)
SESSION_COOKIE_SECRET=$(openssl rand -base64 32)
OAUTH_SECRET=$(openssl rand -hex 32)
FIRESTORE_PROJECT_ID=my-gcp-project
```

For local development with `stdio` (no OAuth, no Firestore needed):

```bash
META_ACCESS_TOKEN=EAA...           # the only required value in stdio mode
```

## Authentication — three modes

| Mode | Activated by | Used for |
|---|---|---|
| **Sign in with Meta** (recommended) | `META_APP_ID` + `META_APP_SECRET` + `TOKEN_ENCRYPTION_KEY` + allowlist | Each user signs in with Facebook Login on `/authorize`. Their long-lived (60-day) token is encrypted in Firestore and auto-refreshed. |
| **API key (service-to-service)** | `MCP_API_KEY=...` | Server-to-server clients pass `X-API-Key` and `X-Meta-Token` headers; bypasses the human OAuth flow. |
| **Stdio / single-tenant** | `META_ACCESS_TOKEN=...` | Local development, single user; no HTTP server required. |

The repo is public but the deployment is private: nothing sensitive lives in the code. All secrets, allowlists, and tokens are runtime-only and never checked in. See [SECURITY.md](SECURITY.md) for the full security policy.

## Setting up Sign in with Meta

1. **Create a Meta App** at <https://developers.facebook.com>:
   - Add the *Facebook Login* product.
   - In *Facebook Login → Settings*, set the Valid OAuth Redirect URI to `<SERVER_URL>/auth/meta/callback`.
   - In *App Review → Permissions and Features*, request `ads_management`, `ads_read`, `pages_show_list`, `pages_read_engagement`, `business_management`, `email`. While the app is in *Development* mode, only people listed under *Roles* can sign in.

2. **Provision Firestore** in your GCP project:
   - In the Cloud Console: Firestore → Create database → Native mode → pick a region.
   - Grant the Cloud Run runtime service account `roles/datastore.user`.

3. **Generate the encryption key and secrets**:

   ```bash
   echo "TOKEN_ENCRYPTION_KEY=$(openssl rand -hex 32)"
   echo "SESSION_COOKIE_SECRET=$(openssl rand -base64 32)"
   echo "OAUTH_SECRET=$(openssl rand -hex 32)"
   ```

   Store them as Cloud Run env vars (or in Secret Manager).

4. **Configure the allowlist**: at least one of `AUTH_ALLOWED_EMAILS`, `AUTH_ALLOWED_DOMAINS`, `AUTH_ALLOWED_FB_USER_IDS` must be set when Meta OAuth is enabled — otherwise startup fails.

5. **Connect Claude**: point Claude (Desktop or Web) to `https://<SERVER_URL>/mcp`. On the first tool call Claude will open the `/authorize` page in your browser, kick off Facebook Login, and you'll land on a consent screen with your token already provisioned. Approve once and Claude is connected.

## Registering System User tokens (no expiry)

Long-lived user tokens last 60 days and are auto-refreshed. If you prefer a token that does not expire (typical for agency System Users), open the `/authorize` consent page and use **"Registrar System User token"** — paste the System User access token, it is validated against Graph API `/me`, encrypted, and saved alongside your personal token. Switch the active token from the same UI.

## Connecting AI clients

### Claude Desktop (stdio)

Add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "meta-ads": {
      "command": "node",
      "args": ["/path/to/meta-ads-mcp/dist/index.js", "--transport", "stdio"],
      "env": {
        "META_ACCESS_TOKEN": "your_token"
      }
    }
  }
}
```

### Claude Web / Claude API (remote HTTP)

Deploy the server and configure the MCP endpoint URL:

```text
URL: https://your-server.com/mcp
```

When connecting from Claude, the OAuth flow opens a browser tab pointed at `/authorize` → Facebook Login → consent. After approval, Claude receives an MCP token and can call all the tools without you ever pasting a Meta token.

### Service-to-service (no browser)

Use the API-key path: set `MCP_API_KEY` on the server, then send:

```http
POST /mcp HTTP/1.1
X-API-Key: <key>
X-Meta-Token: <meta_token>
Content-Type: application/json
```

### Other MCP clients

Any client that speaks the [Model Context Protocol](https://modelcontextprotocol.io) over Streamable HTTP works — Cline, Continue, Cursor, custom Anthropic SDK or OpenAI SDK integrations, etc. Point them at `https://<SERVER_URL>/mcp`.

## Architecture overview

- **Transport** — Express 5 with the official MCP SDK's `StreamableHTTPServerTransport`. Stateless: each request gets its own transport + server pair. See [src/transport/http.ts](src/transport/http.ts).
- **OAuth provider** — implements the MCP OAuth 2.1 spec (authorization code + PKCE) bridged to Facebook Login. Authorization codes and registered clients persist in Firestore. See [src/auth/oauth-provider.ts](src/auth/oauth-provider.ts).
- **Token store** — `AsyncLocalStorage`-based request context resolves the right Meta token per request: header (`X-Meta-Token`), per-user encrypted store, env-var fallback. See [src/auth/token-store.ts](src/auth/token-store.ts) and [src/store/](src/store/).
- **Encryption layer** — AES-256-GCM at the application boundary, before anything reaches Firestore. See [src/auth/crypto.ts](src/auth/crypto.ts).
- **Meta client** — Graph API wrapper with circuit breaker, write pacer, and full throttling-header parsing. See [src/meta/](src/meta/).

## Meta API compliance

This server is designed to keep your app and your clients' ad accounts clear of throttling, suspensions or bans. It implements the full set of guardrails from Meta's documented policies:

- [Graph API rate limiting](https://developers.facebook.com/docs/graph-api/overview/rate-limiting)
- [Marketing API insights best practices](https://developers.facebook.com/docs/marketing-api/insights/best-practices)

### Headers parsed on every response

| Header | What we do with it |
| --- | --- |
| `X-App-Usage` | Platform (token) usage — self-throttle when `>75 %` |
| `X-Business-Use-Case-Usage` | Per-`(business_id, type)` usage; honours `estimated_time_to_regain_access` |
| `x-fb-ads-insights-throttle` | App + account insights load; captures `ads_api_access_tier` |
| `x-ad-account-usage` | Account-level quota + `reset_time_duration` |
| `x-Fb-Ads-Insights-Reach-Throttle` | Reach + breakdowns >13-month cap (10 req/day) |

### Error codes handled explicitly

| Code / subcode | Action |
| --- | --- |
| `4`, `17`, `32`, `613` | Throw, no retry, circuit after 3 events / 5 min |
| `80000-80014` | Same — includes Ads Insights, Ads Management, CA, etc. |
| `613` + subcode `1996` | **Critical abuse signal** — 60 min circuit for that `(token, account)`, `FATAL` log |
| `4` + subcode `1504022` | Global Insights rate limit — 2 min circuit |
| `100` + subcode `1487534` | Data-per-call limit — surfaced as `InvalidParams`, no retry |
| `368`, `1487742` | Temporary user / business block — 30 min circuit |
| `1`, `2` | Transient — retried with exponential backoff |

### Insights guardrails (pre-flight, before hitting Meta)

- Account-level + high-cardinality breakdowns (`product_id`, `action_target_id`, asset-level) → rejected.
- Wide date ranges (`maximum`, `>90 days`) + breakdowns on a sync call → rejected, pointing at `meta_ads_run_report_and_wait`.
- `time_range` > 37 months → rejected.
- `use_unified_attribution_setting=true` by default so responses match Ads Manager (Meta change, 2025-06-10).
- `filtering` parameter exposed and recommended (e.g. `ad.impressions > 0`) to skip empty objects.

### Observability

Call `meta_ads_rate_status` at any time to see:

- Current `call_count`, `total_cputime`, `total_time` per bucket.
- `estimated_time_to_regain_access` remaining.
- `ads_api_access_tier` (`development_access` / `standard_access`).
- Any open circuits — key, reason, seconds remaining.
- Write-pacer state per ad account.

Structured logs fire on every Meta error (`event=meta_error`), abuse signal (`event=META_ABUSE_SIGNAL`, `level=FATAL`), circuit change (`event=meta_circuit_open`) and periodic usage snapshot (`event=meta_rate_usage`).

## Deployment

### Docker

```bash
docker compose up
```

The provided [Dockerfile](Dockerfile) is a multi-stage Node 22 Alpine build that runs as a non-root `node` user, exposes port 3000 and ships with a `/health` health check.

### Google Cloud Run (reference deploy)

[.github/workflows/deploy.yml](.github/workflows/deploy.yml) ships the service automatically on every push to `main`:

1. **Preflight** — runs `lint`, `typecheck`, `test`, `build`, `gitleaks` (same checks as CI).
2. **Validate secrets** — fails the deploy if `OAUTH_SECRET`, `TOKEN_ENCRYPTION_KEY`, `SESSION_COOKIE_SECRET`, `META_APP_ID`, `META_APP_SECRET` or any allowlist source is missing.
3. **Auth to GCP** — Workload Identity Federation; **no service-account JSON keys** are committed or stored as GitHub secrets.
4. **Build & push** to Artifact Registry, tagged with the commit SHA + `latest`.
5. **Deploy** to Cloud Run (512 Mi / 1 CPU / concurrency 80 / min 0 / max 10 / port 3000) with all env vars wired from GitHub secrets.
6. **Smoke test** the deployed `/health` and `/.well-known/oauth-authorization-server` endpoints (URL stays masked in logs).

To bootstrap a fresh GCP project, see [scripts/setup-gcloud.sh](scripts/setup-gcloud.sh).

### Local + Firestore emulator

```bash
# 1. Start the emulator
gcloud beta emulators firestore start --host-port=localhost:8085 &
export FIRESTORE_EMULATOR_HOST=localhost:8085

# 2. Configure .env (copy from .env.example) — set
#    SERVER_URL=http://localhost:3000
#    META_APP_ID + META_APP_SECRET (test app)
#    AUTH_ALLOWED_EMAILS=<your email>
#    TOKEN_ENCRYPTION_KEY, SESSION_COOKIE_SECRET, OAUTH_SECRET

# 3. Run
npm run dev

# 4. Open the consent page to test the flow
open "http://localhost:3000/authorize?client_id=test&redirect_uri=http://localhost/cb&response_type=code&code_challenge=x&code_challenge_method=S256"
```

## Local development

```bash
npm run dev          # HTTP mode with hot reload (tsx watch)
npm run dev:stdio    # Stdio mode with hot reload
npm run typecheck    # tsc --noEmit
npm run lint         # eslint src/
npm test             # vitest run
npm run test:watch   # vitest in watch mode
npm run build        # production build → dist/
```

Tests live under [tests/](tests/) and mirror the `src/` layout (auth, meta, tools, transport, utils).

## Security

This is a **public repository** that handles sensitive credentials at runtime. Read the full [SECURITY.md](SECURITY.md) for the vulnerability disclosure policy, threat model, and hardening recommendations.

Quick summary of the runtime defences:

- AES-256-GCM token encryption at the application layer, before Firestore.
- Email / domain / FB-id allowlist enforced on every Meta OAuth callback.
- HttpOnly, Secure, SameSite=Lax session cookies signed with `jose` JWT.
- HSTS, `X-Content-Type-Options`, `X-Frame-Options=DENY`, `Referrer-Policy=no-referrer` on every response; CSP on the consent page.
- HTTPS-only redirect in production.
- In-process rate limiting on `/register` and `/token`.
- Tokens never logged in plaintext (`maskToken()` everywhere).
- [gitleaks](https://github.com/gitleaks/gitleaks) preflight in CI with a [custom config](.gitleaks.toml) covering Meta tokens (`EAA…`), GCP keys, and our own named secrets — blocks pushes that would leak a credential.
- Workload Identity Federation for Cloud Run deploys: no service-account keys to leak.

### Public repo, private deployment

| Lives in the public repo | Lives only in your deployment |
|---|---|
| Source code | `META_APP_SECRET`, `TOKEN_ENCRYPTION_KEY`, `SESSION_COOKIE_SECRET`, `OAUTH_SECRET` |
| `.env.example` (with empty values) | The actual `AUTH_ALLOWED_*` lists |
| README and docs | Encrypted Meta tokens (Firestore) |

## FAQ / troubleshooting

**The server crashes on startup with `TOKEN_ENCRYPTION_KEY is required in production`.**
Generate one with `openssl rand -hex 32` and set it as an env var. It must be exactly 64 hex characters (32 bytes). In non-production a key is auto-generated, but tokens encrypted with that key won't decrypt after a restart.

**OAuth callback returns 403 with `not on allowlist`.**
Check `AUTH_ALLOWED_EMAILS`, `AUTH_ALLOWED_DOMAINS` and `AUTH_ALLOWED_FB_USER_IDS`. At least one must be set in production, and the email or FB user id from your Facebook profile must match. The check is case-insensitive on emails and domains.

**Tokens disappear after every restart.**
You're running without Firestore. Set `FIRESTORE_PROJECT_ID` (or run on GCP with `GOOGLE_CLOUD_PROJECT`), or point `FIRESTORE_EMULATOR_HOST` at the emulator. The server falls back to in-memory stores when Firestore isn't configured — fine for development, fatal for production.

**A Meta token expires — what happens?**
Long-lived user tokens auto-refresh as long as the user signs in within their 60-day window. If the token has fully expired, the next MCP call returns a 401 with a "re-authenticate via /authorize" hint. System User tokens never expire.

**How do I rotate `TOKEN_ENCRYPTION_KEY`?**
Decrypt all tokens with the current key, set the new key, re-encrypt, deploy. The procedure is short but **don't deploy a new key without re-encrypting first** — every existing token will become unreadable. Plan a maintenance window.

**Can I run without Firestore?**
For local dev / single-user, yes — set `META_ACCESS_TOKEN` and use `npm run dev:stdio`. For multi-tenant HTTP you really want Firestore (or any persistent store you wire in); the in-memory fallback exists only so dev environments don't die.

**API key vs Meta OAuth — when do I use which?**
OAuth is for human users with a browser (Claude Desktop, Claude Web, Cursor users). API key + `X-Meta-Token` header is for server-to-server agents that can't open a browser tab. They can coexist on the same deployment.

**How do I add a new tool?**
Create a `register*Tools(server)` module in [src/tools/](src/tools/), import it into [src/tools/index.ts](src/tools/index.ts), add a Zod schema for params, and write a vitest under [tests/tools/](tests/tools/). The MCP SDK handles the wire protocol.

## Contributing

Contributions are welcome — issues, PRs, security reports.

- Run `npm install && npm run build` once after cloning.
- Before opening a PR, make sure `npm run lint`, `npm run typecheck`, `npm test` and `npm run build` all pass. CI ([.github/workflows/ci.yml](.github/workflows/ci.yml)) runs the same checks plus a [gitleaks](https://github.com/gitleaks/gitleaks) secret scan.
- Auth surface (`src/auth/`, `src/transport/security-config.ts`) changes deserve extra review even when small.
- See [CONTRIBUTING.md](CONTRIBUTING.md) for the full guide and [SECURITY.md](SECURITY.md) before reporting a vulnerability.

## Resources

- [Model Context Protocol — official spec](https://modelcontextprotocol.io)
- [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk)
- [Meta Marketing API documentation](https://developers.facebook.com/docs/marketing-apis)
- [Graph API rate limiting](https://developers.facebook.com/docs/graph-api/overview/rate-limiting)
- [Marketing API insights best practices](https://developers.facebook.com/docs/marketing-api/insights/best-practices)
- [Claude Desktop](https://claude.ai/download)
- [Google Cloud Run](https://cloud.google.com/run)
- [Firestore in Native mode](https://cloud.google.com/firestore/docs/quickstart-native)

## Author

Built and maintained by **[ByAds](https://byads.co)** — author **Santiago Bastidas**. General contact: [dev@byads.co](mailto:dev@byads.co).

Issues, PRs and security reports are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md) and [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE) © 2025 ByAds — Santiago Bastidas
