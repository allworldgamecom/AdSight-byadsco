# Meta Ads MCP Server

MCP (Model Context Protocol) server for managing Meta Ads (Facebook/Instagram) campaigns. Built for agencies managing multiple ad accounts.

## Features

- **79 tools** covering campaign management, creatives, targeting, audiences, reporting, comments, billing, tokens, Instagram workflows, and rate-limit observability
- **Multi-account support** — each request carries its own Meta access token
- **Cloud-ready** — Streamable HTTP transport, stateless, Docker-ready
- **Stdio support** — for local development with MCP clients
- **Compliance-first rate limiting** — per-(token, ad-account, use-case) bucketing of every throttle signal Meta publishes; reacts to `estimated_time_to_regain_access` instead of blind backoff
- **Circuit breaker** — abuse-signal (subcode 1996), temporary-block and repeated-throttle events stop all calls for the affected account, following Meta's explicit *"stop making API calls"* rule
- **Preventive write pacing** — Ads Management POST/DELETE are paced against the hourly BUC quota so bursts from agents never blow the limit
- **Insights guardrails** — dangerous parameter combinations (account-level + high-cardinality breakdowns, lifetime + breakdowns in sync, >37 months) are rejected *before* hitting Meta
- **Async reports with safe polling** — `meta_ads_run_report_and_wait` one-shot with 5s-min / 60s-max backoff, proper `Job Failed` / `Job Skipped` handling
- **Retry logic** — exponential backoff on truly transient errors only (never on throttled requests)

## Tools

| Category | Tools | Description |
|---|---|---|
| Accounts | 3 | List accounts, get info, get pages |
| Campaigns | 5 | CRUD + status management |
| Ad Sets | 5 | CRUD with full targeting spec |
| Ads | 5 | CRUD with creative assignment |
| Creatives | 9 | List creatives, creative details, create/update creatives, image/video library and uploads |
| Insights | 2 | Performance metrics with breakdowns |
| Targeting | 7 | Interest/behavior/geo search, audience estimation |
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
| Tokens | 3 | Multi-token management |
| Rate Status | 1 | Live view of quota usage, open circuits and write-pacer state |

## Quick Start

### Prerequisites

- Node.js 20+
- A Meta access token with `ads_management` and `ads_read` permissions

### Install & Run

```bash
npm install
npm run build
npm start
```

The server starts on `http://localhost:3000` with the `/mcp` endpoint.

### Environment Variables

```bash
META_ACCESS_TOKEN=your_token    # Fallback token (optional if using Bearer auth)
OAUTH_SECRET=your_random_secret # Required in production for OAuth JWT signing
OAUTH_APPROVAL_PIN=your_pin     # Required in production for public HTTP deploys
META_API_VERSION=v25.0          # Graph API version
PORT=3000                       # Server port
LOG_LEVEL=info                  # debug | info | warn | error
```

### Authentication

**Multi-tenant (recommended for agencies):** Each request includes the Meta token in the Authorization header:

```
Authorization: Bearer <META_ACCESS_TOKEN>
```

**Single-tenant:** Set `META_ACCESS_TOKEN` environment variable.

For public HTTP deployments, production startup is fail-closed: both
`OAUTH_SECRET` and `OAUTH_APPROVAL_PIN` must be configured or the server will
refuse to start.

### Local Development (stdio)

```bash
npm run dev:stdio
```

### Docker

```bash
docker compose up
```

## Connecting to Claude

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

### Claude (remote HTTP)

Deploy the server and configure the MCP endpoint URL with Bearer token authentication:

```
URL: https://your-server.com/mcp
Headers: Authorization: Bearer <your_meta_token>
```

If you deploy this publicly, make sure `OAUTH_SECRET` and
`OAUTH_APPROVAL_PIN` are set in the runtime environment before rollout.

## Meta API Permissions

Your Meta access token needs these permissions:

- `ads_management` — Create and manage campaigns
- `ads_read` — Read campaign data and insights
- `pages_show_list` — List associated pages
- `pages_read_engagement` — Read page data

For agency use, create a System User in Business Manager with access to all client ad accounts.

## Meta API compliance

This server is designed to keep your app and your clients' ad accounts clear of
throttling, suspensions or bans. It implements the full set of guardrails from
Meta's documented policies:

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
| `368`, `1487742` | Temporary user/business block — 30 min circuit |
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

Structured logs fire on every meta error (`event=meta_error`), abuse signal
(`event=META_ABUSE_SIGNAL`, `level=FATAL`), circuit change
(`event=meta_circuit_open`) and periodic usage snapshot (`event=meta_rate_usage`).

## Development

```bash
npm run dev          # HTTP mode with hot reload
npm run dev:stdio    # Stdio mode with hot reload
npm run typecheck    # Type checking
npm run build        # Production build
```

## License

MIT
