# Adding a new MCP tool

This is the canonical guide for extending meta-ads-mcp with a Meta Marketing API endpoint that isn't already covered by the 80 built-in tools. Follow it end-to-end and your tool will inherit every security, rate-limit, circuit-breaker, error-handling, and multi-tenant guarantee the rest of the server provides.

If you're contributing for the first time, also read [CONTRIBUTING.md](../CONTRIBUTING.md) for setup, CI checks, commit conventions, and the auth-surface review policy.

## TL;DR — the 8-step recipe

1. Pick a category file in [src/tools/](../src/tools/) (`campaigns.ts`, `audiences.ts`, …) or create a new one (`mything.ts`).
2. Add a `register*Tools(server)` function (or extend the existing one) that calls `server.tool(name, description, zodSchema, handler)`.
3. In the handler, call **`metaApiClient.get / post / postForm / postMultipart / delete / getPaginated`** — never `fetch` directly.
4. Validate IDs with `normalizeAccountId` / `validateMetaId` from [src/utils/format.ts](../src/utils/format.ts).
5. Reuse type definitions from [src/meta/types/](../src/meta/types/) (or add new ones there if the resource is new).
6. Register the new module in [src/tools/index.ts](../src/tools/index.ts) and bump the tool count assertion in [tests/tools/registration.test.ts](../tests/tools/registration.test.ts).
7. Mirror the source path under `tests/tools/` with a vitest that uses `createMockMcpServer`, `setupTestToken`, and `mockFetchResponse` from [tests/setup.ts](../tests/setup.ts).
8. Run `npm run lint && npm run typecheck && npm test && npm run build` and open a PR using [.github/PULL_REQUEST_TEMPLATE.md](../.github/PULL_REQUEST_TEMPLATE.md).

## Architecture in 30 seconds

```
MCP client request
   │
   ▼
server.tool(name, desc, zodSchema, handler)   ◄── you implement this
   │
   ▼
metaApiClient.{get|post|postForm|delete|...}  ◄── shared singleton
   │
   ├── circuit-breaker  (assertClosed before any call)
   ├── write-pacer      (acquire token for POST/DELETE on account paths)
   ├── rate-limiter     (waitIfNeeded based on last X-App-Usage / X-BUC-Usage)
   ├── fetch (Graph API v25.0)
   ├── header parser    (updateFromHeaders → updates rate-limiter + pacer tier)
   ├── error classifier (classifyMetaError → McpError + retry/throttle policy)
   └── retry w/ exp. backoff + jitter (only on transient + 5xx)
```

The whole shared pipeline lives in [src/meta/client.ts](../src/meta/client.ts). The compliance contract is documented at [src/meta/client.ts:30-44](../src/meta/client.ts) and the per-attempt logic at [src/meta/client.ts:158-282](../src/meta/client.ts). You don't need to understand the internals to write a tool — you just have to **route every call through the client**.

## Canonical example, line by line

The smallest tool in the codebase is [src/tools/budget.ts](../src/tools/budget.ts). It's a complete, production tool in 42 lines:

```ts
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { metaApiClient } from "../meta/client.js";

export function registerBudgetTools(server: McpServer): void {
  server.tool(
    "meta_ads_create_budget_schedule",
    "Schedule a temporary budget increase for a campaign during high-demand periods (e.g., Black Friday, product launches).",
    {
      campaign_id: z.string().describe("Campaign ID"),
      budget_value: z.string().describe("Budget amount in cents (for ABSOLUTE) or multiplier value (for MULTIPLIER)"),
      budget_value_type: z.enum(["ABSOLUTE", "MULTIPLIER"]).describe("ABSOLUTE = set exact budget in cents, MULTIPLIER = multiply current budget"),
      time_start: z.string().describe("ISO 8601 start time for the budget increase"),
      time_end: z.string().describe("ISO 8601 end time for the budget increase"),
    },
    async ({ campaign_id, budget_value, budget_value_type, time_start, time_end }) => {
      const result = await metaApiClient.postForm<{ id: string }>(
        `/${campaign_id}/budget_schedules`,
        { budget_value, budget_value_type, time_start, time_end },
      );
      return {
        content: [{
          type: "text",
          text: `Budget schedule created!\nID: ${result.id}\nCampaign: ${campaign_id}\nValue: ${budget_value} (${budget_value_type})\nPeriod: ${time_start} → ${time_end}`,
        }],
      };
    },
  );
}
```

What each part does:

- **`server.tool(name, description, schema, handler)`** — the MCP SDK uses the Zod schema both to validate inputs at runtime and to expose a JSON Schema to clients during the MCP `tools/list` handshake. The description is what the AI sees when deciding whether to call this tool — keep it specific and outcome-oriented.
- **`metaApiClient.postForm(...)`** — issues `POST /v25.0/<campaign_id>/budget_schedules` with `application/x-www-form-urlencoded` body. Behind the scenes the client looks up the per-request access token, checks the circuit-breaker, throttles writes, retries transient failures, and converts any Meta error into a typed `McpError`.
- **Return shape** — every handler must return `{ content: [{ type: "text", text: "..." }, ...] }`. Adding a second `text` block with the raw JSON (`JSON.stringify(obj, null, 2)`) is a common pattern for read tools — see [src/tools/campaigns.ts:84-89](../src/tools/campaigns.ts).

## Templates

### GET (read) tool

```ts
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { metaApiClient } from "../meta/client.js";
import { normalizeAccountId } from "../utils/format.js";
import { buildFieldsParam } from "../utils/validation.js";
// import { MY_RESOURCE_DEFAULT_FIELDS } from "../meta/types/myresource.js";
// import type { MyResource, MetaApiResponse } from "../meta/types/index.js";

export function registerMyResourceTools(server: McpServer): void {
  server.tool(
    "meta_ads_get_my_resources",
    "TODO: one sentence describing what the tool does and when to use it.",
    {
      account_id: z.string().describe("Ad account ID (act_... or numeric)"),
      limit: z.number().min(1).max(100).default(25),
      fields: z.array(z.string()).optional(),
    },
    async ({ account_id, limit, fields }) => {
      const id = normalizeAccountId(account_id);
      const fieldsParam = buildFieldsParam(fields, ["id", "name" /* , ...DEFAULTS */]);

      const response = await metaApiClient.get<{ data: Array<{ id: string; name: string }> }>(
        `/${id}/my_resources`,
        { fields: fieldsParam, limit },
      );

      const items = response.data ?? [];
      const text = items.length === 0
        ? "No resources found."
        : items.map((r) => `• ${r.name} (${r.id})`).join("\n");

      return {
        content: [
          { type: "text", text: `Found ${items.length} resource(s):\n\n${text}` },
          { type: "text", text: JSON.stringify(items, null, 2) },
        ],
      };
    },
  );
}
```

### POST / write tool

```ts
server.tool(
  "meta_ads_create_my_resource",
  "TODO: describe the side-effect.",
  {
    account_id: z.string(),
    name: z.string().min(1).max(400),
    status: z.enum(["ACTIVE", "PAUSED"]).default("PAUSED"),
  },
  async ({ account_id, name, status }) => {
    const id = normalizeAccountId(account_id);
    const result = await metaApiClient.postForm<{ id: string }>(
      `/${id}/my_resources`,
      { name, status },
    );
    return {
      content: [{ type: "text", text: `Created ${result.id} (${name}, ${status}).` }],
    };
  },
);
```

## `metaApiClient` reference

| Method | When to use | Defined at |
| --- | --- | --- |
| `get<T>(path, params?)` | Single read request. Auto-appends `access_token`. | [src/meta/client.ts:63-69](../src/meta/client.ts) |
| `getPaginated<T>(path, params?, maxItems?)` | Multi-page reads using Meta's cursor pagination. | [src/meta/client.ts:112-125](../src/meta/client.ts) |
| `post<T>(path, body?)` | JSON `POST` (rare; most Marketing API endpoints are form-encoded). | [src/meta/client.ts:71-80](../src/meta/client.ts) |
| `postForm<T>(path, params)` | Standard create / update — `application/x-www-form-urlencoded`. **Default for writes.** | [src/meta/client.ts:82-95](../src/meta/client.ts) |
| `postMultipart<T>(path, formData)` | Uploads (images, video chunks). | [src/meta/client.ts:97-105](../src/meta/client.ts) |
| `delete<T>(path)` | Hard delete. Most "deletes" in Marketing API are actually `postForm({ status: "DELETED" })`. | [src/meta/client.ts:107-110](../src/meta/client.ts) |

The singleton instance `metaApiClient` is exported at [src/meta/client.ts:418](../src/meta/client.ts). Always import it; never instantiate `new MetaApiClient()`.

## What the framework guarantees — and what's still on you

### Already handled for you (don't reimplement)

- **Multi-tenant token resolution.** `getAccessToken()` at [src/auth/token-store.ts:28-47](../src/auth/token-store.ts) reads from `AsyncLocalStorage` (set per HTTP request by the OAuth/API-key middleware), then the `tokenManager` registry, then `META_ACCESS_TOKEN`. You never touch the env var directly.
- **Encryption at rest.** Tokens stored in Firestore are AES-256-GCM encrypted at the application boundary by [src/auth/crypto.ts](../src/auth/crypto.ts). You only see plaintext for the duration of one request.
- **Self-throttling.** [src/meta/rate-limiter.ts](../src/meta/rate-limiter.ts) tracks `X-App-Usage`, `X-Business-Use-Case-Usage`, `x-fb-ads-insights-throttle`, and `x-ad-account-usage` per `(token, account, BUC type)` bucket and pre-emptively waits when usage > 75 %.
- **Circuit breaker.** [src/meta/circuit-breaker.ts](../src/meta/circuit-breaker.ts) trips on abuse signals (subcode 1996), platform/BUC rate-limit codes (4, 17, 32, 613, 80000-80014), or repeat throttling — opens the circuit for 2 / 30 / 60 minutes depending on severity. Calls that hit an open circuit short-circuit before reaching Meta.
- **Write pacing.** [src/meta/write-pacer.ts](../src/meta/write-pacer.ts) sizes a token bucket to the Ads Management hourly quota of the active access tier (`development_access` vs `standard_access`).
- **Error classification.** [src/meta/errors.ts](../src/meta/errors.ts) maps every documented Meta error code/subcode to a typed `McpError` with the right `ErrorCode` (`InvalidParams`, `InvalidRequest`, `InternalError`) and decides retry / throttle / log severity.
- **Retry with exponential backoff + jitter.** [src/meta/client.ts:290-294](../src/meta/client.ts) — only on transient (codes 1, 2) and HTTP 5xx. Throttles are **never** retried in-process per Meta's own guidance.
- **Token redaction in logs.** Use `hashToken(token)` from [src/auth/token-store.ts:65-67](../src/auth/token-store.ts) for log keys; use `maskToken(token)` from [src/auth/token-manager.ts:87-90](../src/auth/token-manager.ts) for human-readable output. Never log a raw token.

### Your responsibility on every new tool

- **Strict Zod schema.** Use the narrowest types possible: `z.enum([...])` over `z.string()`, `z.number().min(1).max(100)` over `z.number()`, `.describe()` on every field — it shows up in the tool's JSON schema.
- **Validate IDs at the boundary.** Pass `account_id` through `normalizeAccountId(...)` and any other resource id through `validateMetaId(id, "campaign")` before interpolating into a path. Both throw on path-traversal / non-numeric input. See [src/utils/format.ts:9-34](../src/utils/format.ts).
- **Reuse shared types.** Pull `Campaign`, `AdSet`, `Insights`, `Targeting`, `Audience`, etc. from [src/meta/types/index.ts](../src/meta/types/index.ts). Add new types in the same directory if the resource is new — don't inline them.
- **Reuse `buildFieldsParam`.** [src/utils/validation.ts:26-31](../src/utils/validation.ts) — keeps the `?fields=` API consistent across tools.
- **Insights guardrails.** If your endpoint hits `/insights` or accepts `breakdowns` / `time_range` / `date_preset`, call `enforceInsightsGuardrails(...)` from [src/tools/insights-guardrails.ts](../src/tools/insights-guardrails.ts) **before** the API call. It rejects parameter combinations Meta would either reject or throttle on.
- **`use_unified_attribution_setting`.** For any insights call, route params through `applyAttributionDefault(...)` so responses match Ads Manager (Meta change, 2025-06-10).
- **Preserve cardinality of caller errors.** Let `McpError` thrown by the client surface — don't `try/catch` and turn it into a generic `Error`. Bad input becomes `InvalidParams`; transient becomes `InternalError`; throttling becomes `InvalidRequest` with the right message.

## Anti-patterns (do not ship a PR with any of these)

- ❌ `await fetch("https://graph.facebook.com/...")` directly — bypasses the rate-limiter, circuit-breaker, write-pacer, and error classifier. The whole point of `metaApiClient` is that you can't ship a non-compliant call by accident.
- ❌ Reading `process.env.META_ACCESS_TOKEN` from a tool handler — breaks multi-tenant. Always go through `getAccessToken()` (or, more commonly, just call `metaApiClient.*` and let the client read it).
- ❌ Manually retrying a `code 4 / 17 / 32 / 613 / 80000-80014` error. Meta's docs are explicit: continued calls during throttling **extend `estimated_time_to_regain_access`**. The client already classifies these as non-retryable.
- ❌ `console.log(token)` or `logger.info({ token })`. Logs ship to Cloud Logging in production. Use `hashToken(token)` for keys, `maskToken(token)` for display.
- ❌ `try { ... } catch { /* swallow */ }` around a Meta call. Errors carry `fbtrace_id` and classification metadata — they need to bubble.
- ❌ Adding code comments that restate what the code does. Repository convention: comments only when the *why* is non-obvious. See [CONTRIBUTING.md](../CONTRIBUTING.md).

## Tests

Mirror the source path under [tests/](../tests/). For `src/tools/myresources.ts` write `tests/tools/myresources.test.ts`. The shared mocks in [tests/setup.ts](../tests/setup.ts) cover the common cases:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { registerMyResourceTools } from "../../src/tools/myresources.js";
import { createMockMcpServer, setupTestToken, cleanupTestToken, mockFetchResponse } from "../setup.js";

describe("registerMyResourceTools", () => {
  beforeEach(() => setupTestToken());
  afterEach(() => { cleanupTestToken(); vi.restoreAllMocks(); });

  it("registers the expected tools", () => {
    const server = createMockMcpServer();
    registerMyResourceTools(server as never);
    expect(server.tool).toHaveBeenCalledTimes(1);
    expect(server._registeredTools[0].name).toBe("meta_ads_get_my_resources");
  });

  it("calls the Graph API with normalized account id and field defaults", async () => {
    const server = createMockMcpServer();
    registerMyResourceTools(server as never);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockFetchResponse({ data: [] })));

    const handler = server._registeredTools[0].handler;
    await handler({ account_id: "123", limit: 25, fields: undefined });

    const url = new URL(vi.mocked(fetch).mock.calls[0][0] as string);
    expect(url.pathname).toContain("/act_123/my_resources");
    expect(url.searchParams.get("fields")).toContain("id,name");
  });
});
```

**Important:** [tests/tools/registration.test.ts](../tests/tools/registration.test.ts) hard-codes the total tool count (`expect(server.tool).toHaveBeenCalledTimes(80)`). When you add a tool, bump that number and add a `expect(names).toContain("meta_ads_my_new_tool")` assertion.

## Verification

Before pushing, run the full local check set — the same one CI enforces:

```bash
npm run lint        # eslint src/
npm run typecheck   # tsc --noEmit
npm test            # vitest run
npm run build       # tsc → dist/
```

[gitleaks](https://github.com/gitleaks/gitleaks) scans the diff in CI using [.gitleaks.toml](../.gitleaks.toml). If you accidentally paste an `EAA…` token into a fixture or log, it blocks the merge — fix the cause, never `--no-verify`.

For an end-to-end smoke test, point the dev server at the Firestore emulator and exercise the new tool from an MCP client (Claude Desktop, mcp-inspector):

```bash
gcloud beta emulators firestore start --host-port=localhost:8085 &
export FIRESTORE_EMULATOR_HOST=localhost:8085
npm run dev
```

Then call `tools/list` and `tools/call` against the new tool name. Watch the logs for `event=meta_error`, `event=meta_circuit_open`, or `event=META_ABUSE_SIGNAL` — none should fire on a happy-path test.

## PR checklist

The full checklist lives in [.github/PULL_REQUEST_TEMPLATE.md](../.github/PULL_REQUEST_TEMPLATE.md). The items that matter for a new-tool PR:

- [ ] New file under `src/tools/` plus mirror test under `tests/tools/`.
- [ ] Registered in [src/tools/index.ts](../src/tools/index.ts) with a `registerXxxTools(server)` call **and** total tool count bumped in [tests/tools/registration.test.ts](../tests/tools/registration.test.ts).
- [ ] Zod schema with `.describe()` on every field; narrow enums where possible.
- [ ] All Graph API calls go through `metaApiClient` — no direct `fetch`.
- [ ] IDs validated with `normalizeAccountId` / `validateMetaId`.
- [ ] If the endpoint hits `/insights`, `enforceInsightsGuardrails(...)` is called.
- [ ] No raw token in logs (`hashToken` / `maskToken`).
- [ ] `npm run lint && npm run typecheck && npm test && npm run build` green.
- [ ] `README.md` "Tools" section updated if you want the tool listed publicly.
- [ ] `CONTRIBUTING.md` — only update if the contribution flow itself changed.

If your tool touches `src/auth/`, `src/store/`, or [src/transport/security-config.ts](../src/transport/security-config.ts), expect maintainer review and explain the threat-model impact in the PR description.
