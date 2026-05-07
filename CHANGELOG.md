# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and
this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [3.0.0] — 2026-05-06

### Why this release

On 2026-04-29 Meta launched its own remote MCP server at
`mcp.facebook.com/ads` with a curated naming convention (`ads_create_campaign`,
`ads_update_entity`, `ads_insights_*`) and supports ChatGPT, Claude, and
Perplexity natively.

This project's **agency multi-tenant** angle is unchanged — Meta's official MCP
is per-user OAuth and cannot operate across N client accounts on behalf of an
agency. v3.0.0 aligns the **vocabulary** so an agent that learned the official
MCP transfers seamlessly to ours, and adds the diagnostic / help / cross-account
tools the official server doesn't cover.

### Breaking changes

- **All tool names changed**: `meta_ads_*` → `ads_*`. Drop the `meta_` prefix.
- `adset` → `ad_set` (with underscore) in tool names *and* parameter names —
  matches Meta's official `ads_create_ad_set`, `ads_update_ad_set`, etc.
- `ads_get_pages` → `ads_get_pages_for_business` (matches official MCP).
- `meta_ads_get_account_insights` **removed** — replaced by
  `ads_insights_advertiser_context` (richer first-message account snapshot).
- All write tools now declare `ToolAnnotations`
  (`destructiveHint` / `idempotentHint`) and prefix descriptions with
  `⚠️ Modifies live ads/account data.`. MCP clients (Claude, ChatGPT) display
  these as confirmation hints.
- Internal tool registration migrated from the deprecated
  `server.tool(...)` API to `server.registerTool(name, config, handler)`.
  No user-facing change; downstream code that imported `register*Tools` is
  unaffected.

### Added

**Generic entity helpers** (mirror Meta's official vocabulary):
- `ads_get_ad_entities` — generic getter, dispatches by `entity_type`
  (campaign / ad_set / ad).
- `ads_update_entity` — generic updater.
- `ads_activate_entity` — toggle status (ACTIVE / PAUSED / ARCHIVED).

**Insight views** (semantic, agent-friendly):
- `ads_insights_performance_trend` — daily/weekly/monthly KPI series.
- `ads_insights_anomaly_signal` — auto-compare last N days vs prior.
- `ads_insights_auction_ranking_benchmarks` — quality / engagement / conversion
  rankings (ad-level only).
- `ads_insights_industry_benchmark` — observed CTR/CPC/CPM vs curated industry
  medians.
- `ads_insights_advertiser_context` — first-message account snapshot
  (replaces `ads_get_account_insights`).

**Diagnostic tools** (parity with Meta's official MCP):
- `ads_get_opportunity_score` — Meta's 0-100 health/improvement signal.
- `ads_get_dataset_quality` — synthetic pixel/dataset health overview
  (last fired, match rate, AAM status, health score 0-100).
- `ads_get_errors` — current account errors / disapproved ads / restrictions.

**Help center search**:
- `ads_get_help_article` — full-text search across a curated set of
  Meta Business Help Center articles (rejection reasons, pixel setup,
  audience requirements, billing, learning phase, ad rankings, AEM, etc.).

**Agency macros** (cross-account — not in the official MCP):
- `ads_diagnose_underperformance` — bundles anomaly detection,
  ranking lookup, pixel quality, account issues, returns a unified report.
- `ads_portfolio_summary` — parallel aggregation across N ad accounts.

### Tool-name migration table

#### Renamed (drop `meta_` prefix)

| v2 | v3 |
| --- | --- |
| `meta_ads_get_ad_accounts` | `ads_get_ad_accounts` |
| `meta_ads_get_account_info` | `ads_get_account_info` |
| `meta_ads_get_pages` | `ads_get_pages_for_business` |
| `meta_ads_get_campaigns` | `ads_get_campaigns` |
| `meta_ads_get_campaign_details` | `ads_get_campaign_details` |
| `meta_ads_create_campaign` | `ads_create_campaign` |
| `meta_ads_update_campaign` | `ads_update_campaign` |
| `meta_ads_delete_campaign` | `ads_delete_campaign` |
| `meta_ads_get_adsets` | `ads_get_ad_sets` |
| `meta_ads_get_adset_details` | `ads_get_ad_set_details` |
| `meta_ads_clone_adset_bundle` | `ads_clone_ad_set_bundle` |
| `meta_ads_create_adset` | `ads_create_ad_set` |
| `meta_ads_update_adset` | `ads_update_ad_set` |
| `meta_ads_delete_adset` | `ads_delete_ad_set` |
| `meta_ads_get_ads` | `ads_get_ads` |
| `meta_ads_get_ad_details` | `ads_get_ad_details` |
| `meta_ads_create_ad` | `ads_create_ad` |
| `meta_ads_update_ad` | `ads_update_ad` |
| `meta_ads_delete_ad` | `ads_delete_ad` |
| `meta_ads_get_ad_creatives` | `ads_get_ad_creatives` |
| `meta_ads_get_creative_details` | `ads_get_creative_details` |
| `meta_ads_create_ad_creative` | `ads_create_ad_creative` |
| `meta_ads_update_ad_creative` | `ads_update_ad_creative` |
| `meta_ads_upload_ad_image` | `ads_upload_ad_image` |
| `meta_ads_get_ad_images` | `ads_get_ad_images` |
| `meta_ads_get_ad_videos` | `ads_get_ad_videos` |
| `meta_ads_get_video_details` | `ads_get_video_details` |
| `meta_ads_upload_ad_video` | `ads_upload_ad_video` |
| `meta_ads_get_insights` | `ads_get_insights` |
| `meta_ads_search_interests` | `ads_search_interests` |
| `meta_ads_get_interest_suggestions` | `ads_get_interest_suggestions` |
| `meta_ads_search_behaviors` | `ads_search_behaviors` |
| `meta_ads_search_demographics` | `ads_search_demographics` |
| `meta_ads_search_geo_locations` | `ads_search_geo_locations` |
| `meta_ads_estimate_audience_size` | `ads_estimate_audience_size` |
| `meta_ads_get_targeting_description` | `ads_get_targeting_description` |
| `meta_ads_create_budget_schedule` | `ads_create_budget_schedule` |
| `meta_ads_get_lead_forms` | `ads_get_lead_forms` |
| `meta_ads_get_leads` | `ads_get_leads` |
| `meta_ads_get_ad_leads` | `ads_get_ad_leads` |
| `meta_ads_create_lead_form` | `ads_create_lead_form` |
| `meta_ads_get_custom_audiences` | `ads_get_custom_audiences` |
| `meta_ads_get_audience_details` | `ads_get_audience_details` |
| `meta_ads_create_custom_audience` | `ads_create_custom_audience` |
| `meta_ads_create_lookalike_audience` | `ads_create_lookalike_audience` |
| `meta_ads_delete_custom_audience` | `ads_delete_custom_audience` |
| `meta_ads_generate_preview` | `ads_generate_preview` |
| `meta_ads_get_ad_preview` | `ads_get_ad_preview` |
| `meta_ads_get_pixels` | `ads_get_pixels` |
| `meta_ads_get_pixel_details` | `ads_get_pixel_details` |
| `meta_ads_get_pixel_events` | `ads_get_pixel_events` |
| `meta_ads_get_custom_conversions` | `ads_get_custom_conversions` |
| `meta_ads_create_custom_conversion` | `ads_create_custom_conversion` |
| `meta_ads_get_ad_comments` | `ads_get_ad_comments` |
| `meta_ads_hide_comment` | `ads_hide_comment` |
| `meta_ads_reply_comment` | `ads_reply_comment` |
| `meta_ads_delete_comment` | `ads_delete_comment` |
| `meta_ads_get_ad_rules` | `ads_get_ad_rules` |
| `meta_ads_get_rule_details` | `ads_get_rule_details` |
| `meta_ads_create_ad_rule` | `ads_create_ad_rule` |
| `meta_ads_update_ad_rule` | `ads_update_ad_rule` |
| `meta_ads_delete_ad_rule` | `ads_delete_ad_rule` |
| `meta_ads_get_ad_studies` | `ads_get_ad_studies` |
| `meta_ads_get_study_details` | `ads_get_study_details` |
| `meta_ads_create_ad_study` | `ads_create_ad_study` |
| `meta_ads_create_async_report` | `ads_create_async_report` |
| `meta_ads_get_report_status` | `ads_get_report_status` |
| `meta_ads_get_report_results` | `ads_get_report_results` |
| `meta_ads_run_report_and_wait` | `ads_run_report_and_wait` |
| `meta_ads_get_billing_info` | `ads_get_billing_info` |
| `meta_ads_get_spend_limit` | `ads_get_spend_limit` |
| `meta_ads_update_spend_cap` | `ads_update_spend_cap` |
| `meta_ads_rate_status` | `ads_rate_status` |
| `meta_ads_get_instagram_account` | `ads_get_instagram_account` |
| `meta_ads_get_instagram_media` | `ads_get_instagram_media` |
| `meta_ads_list_tokens` | `ads_list_tokens` |
| `meta_ads_set_active_token` | `ads_set_active_token` |
| `meta_ads_register_token` | `ads_register_token` |
| `meta_ads_delete_token` | `ads_delete_token` |

#### Removed

| v2 | Replacement |
| --- | --- |
| `meta_ads_get_account_insights` | `ads_insights_advertiser_context` |

#### Added in v3

| Tool | Category |
| --- | --- |
| `ads_get_ad_entities` | Generic helper |
| `ads_update_entity` | Generic helper |
| `ads_activate_entity` | Generic helper |
| `ads_insights_performance_trend` | Insight view |
| `ads_insights_anomaly_signal` | Insight view |
| `ads_insights_auction_ranking_benchmarks` | Insight view |
| `ads_insights_industry_benchmark` | Insight view |
| `ads_insights_advertiser_context` | Insight view |
| `ads_get_opportunity_score` | Diagnostic |
| `ads_get_dataset_quality` | Diagnostic |
| `ads_get_errors` | Diagnostic |
| `ads_get_help_article` | Help search |
| `ads_diagnose_underperformance` | Agency macro |
| `ads_portfolio_summary` | Agency macro |

### Migration

For client-side updates, see [docs/migration-v3.md](docs/migration-v3.md).

The internal API of `register*Tools(server)` exporters is unchanged, so anyone
embedding this server programmatically only needs to update tool names that
their callers reference.

### Compatibility

- Node 20+ (unchanged)
- `@modelcontextprotocol/sdk` ^1.29
- Same auth model: per-user Meta OAuth + System User token registry, server-to-server
  with API key, encrypted-at-rest token storage in Firestore.
- Same transports: HTTP and stdio.

---

## [2.0.2] — Prior to 2026-05-06

See git history. v2.x ships 80 tools under the `meta_ads_*` prefix.
