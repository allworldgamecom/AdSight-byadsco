import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { logger } from "../utils/logger.js";

const HIGH_CARDINALITY_BREAKDOWNS = new Set([
  "product_id",
  "action_target_id",
  "body_asset",
  "call_to_action_asset",
  "description_asset",
  "image_asset",
  "link_url_asset",
  "title_asset",
  "video_asset",
]);

const WIDE_DATE_PRESETS = new Set(["maximum", "last_year", "this_year"]);

const DATE_PRESET_FOR_SPAN = new Map<number, string>([
  [3, "last_3d"],
  [7, "last_7d"],
  [14, "last_14d"],
  [28, "last_28d"],
  [30, "last_30d"],
  [90, "last_90d"],
]);

export interface InsightsGuardInput {
  level?: string;
  breakdowns?: string[];
  date_preset?: string;
  time_range?: { since: string; until: string };
  is_async?: boolean;
}

/**
 * Fast-fail unsafe parameter combinations BEFORE hitting Meta. Each of these
 * is documented as producing either a `data_per_call_limit` error or a
 * degraded user experience that eats into our quota.
 */
export function enforceInsightsGuardrails(input: InsightsGuardInput): void {
  const breakdowns = input.breakdowns ?? [];
  const hasHighCardinality = breakdowns.some((b) =>
    HIGH_CARDINALITY_BREAKDOWNS.has(b),
  );

  // 1. Account-level + high-cardinality breakdowns → reject.
  if (input.level === "account" && hasHighCardinality) {
    throw new McpError(
      ErrorCode.InvalidParams,
      "Account-level queries cannot combine with high-cardinality breakdowns (product_id, action_target_id, asset-level). Use a narrower level (ad/adset) or create an async report with tighter scope.",
    );
  }

  const daysSpan = spanInDays(input);

  // 2. Lifetime/very wide + breakdowns + sync → force async path.
  if (!input.is_async && breakdowns.length > 0) {
    const tooWide =
      (input.date_preset && WIDE_DATE_PRESETS.has(input.date_preset)) ||
      (daysSpan !== null && daysSpan > 90);
    if (tooWide) {
      throw new McpError(
        ErrorCode.InvalidParams,
        "Wide date ranges (maximum, >90 days) combined with breakdowns will time out or trip data-per-call limits in a sync request. Use ads_create_async_report (or ads_run_report_and_wait) instead.",
      );
    }
  }

  // 3. Anything beyond 37 months → hard reject (Meta returns error 100).
  if (daysSpan !== null && daysSpan > 37 * 30) {
    throw new McpError(
      ErrorCode.InvalidParams,
      "Date range exceeds Meta's 37-month data retention limit. Trim `time_range`.",
    );
  }

  // 4. Custom date range that matches a preset → suggest preset.
  if (input.time_range && !input.date_preset && daysSpan !== null) {
    const suggestion = DATE_PRESET_FOR_SPAN.get(daysSpan);
    if (suggestion && endsToday(input.time_range.until)) {
      logger.info(
        {
          event: "meta_insights_preset_suggestion",
          time_range: input.time_range,
          suggested: suggestion,
        },
        "Custom time_range matches a date_preset — using date_preset is more efficient",
      );
    }
  }
}

/**
 * Default attribution flag: v25+ Meta recommends `use_unified_attribution_setting=true`
 * to keep API responses aligned with Ads Manager (cambio 10-jun-2025).
 */
export function applyAttributionDefault(
  params: Record<string, string | number | boolean>,
  useUnified: boolean | undefined,
): void {
  const value = useUnified ?? true;
  params.use_unified_attribution_setting = value;
}

function spanInDays(input: InsightsGuardInput): number | null {
  if (!input.time_range) return null;
  const since = Date.parse(input.time_range.since);
  const until = Date.parse(input.time_range.until);
  if (Number.isNaN(since) || Number.isNaN(until) || until < since) return null;
  return Math.round((until - since) / (24 * 60 * 60 * 1000));
}

function endsToday(until: string): boolean {
  const untilDate = new Date(until);
  const today = new Date();
  return (
    untilDate.getUTCFullYear() === today.getUTCFullYear() &&
    untilDate.getUTCMonth() === today.getUTCMonth() &&
    untilDate.getUTCDate() === today.getUTCDate()
  );
}
