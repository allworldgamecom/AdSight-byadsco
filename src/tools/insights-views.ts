import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { metaApiClient } from "../meta/client.js";
import { normalizeAccountId, truncateResponse, validateMetaId } from "../utils/format.js";
import type { InsightsResult, MetaApiResponse } from "../meta/types/index.js";
import { applyAttributionDefault } from "./insights-guardrails.js";
import { buildSingleInsightSummary } from "./insights-helpers.js";
import { READ } from "./_register.js";

const datePresetEnum = z.enum([
  "today", "yesterday", "this_month", "last_month", "this_quarter",
  "maximum", "last_3d", "last_7d", "last_14d", "last_28d", "last_30d",
  "last_90d", "last_week_mon_sun", "last_week_sun_sat", "last_quarter",
  "last_year", "this_week_mon_today", "this_week_sun_today", "this_year",
]);

const levelEnum = z.enum(["account", "campaign", "ad_set", "ad"]);

const TREND_FIELDS = "spend,impressions,reach,clicks,ctr,cpc,cpm,actions,cost_per_action_type";
const RANKING_FIELDS = "quality_ranking,engagement_rate_ranking,conversion_rate_ranking,impressions,spend";
const CONTEXT_FIELDS = "spend,impressions,reach,clicks,ctr,cpc,cpm,actions,frequency";

const VALIDATE_KIND_BY_LEVEL = {
  account: null,
  campaign: "campaign",
  ad_set: "adset",
  ad: "ad",
} as const;

function resolveObjectPath(level: z.infer<typeof levelEnum>, objectId: string): string {
  if (level === "account") return normalizeAccountId(objectId);
  return validateMetaId(objectId, VALIDATE_KIND_BY_LEVEL[level]!);
}

function granularityToTimeIncrement(g: "daily" | "weekly" | "monthly"): number | string {
  if (g === "daily") return 1;
  if (g === "weekly") return 7;
  return "monthly";
}

interface ApiInsight {
  date_start?: string;
  date_stop?: string;
  spend?: string;
  impressions?: string;
  reach?: string;
  clicks?: string;
  ctr?: string;
  cpc?: string;
  cpm?: string;
  frequency?: string;
  quality_ranking?: string;
  engagement_rate_ranking?: string;
  conversion_rate_ranking?: string;
  actions?: Array<{ action_type: string; value: string }>;
}

export function registerInsightsViewTools(server: McpServer): void {
  // ─── Performance Trend ───────────────────────────────────────
  server.registerTool(
    "ads_insights_performance_trend",
    {
      description:
        "Time-series view of core KPIs (spend, impressions, CTR, CPC, conversions) for an account, campaign, ad set, or ad. Choose granularity to bucket the series by day/week/month. Mirrors the official Meta MCP view.",
      inputSchema: {
        object_id: z.string().describe("Account, campaign, ad set, or ad ID"),
        level: levelEnum.default("account"),
        date_preset: datePresetEnum.default("last_30d"),
        granularity: z.enum(["daily", "weekly", "monthly"]).default("daily"),
      },
      annotations: { ...READ },
    },
    async ({ object_id, level, date_preset, granularity }) => {
      const path = resolveObjectPath(level, object_id);
      const params: Record<string, string | number | boolean> = {
        fields: TREND_FIELDS,
        date_preset,
        time_increment: String(granularityToTimeIncrement(granularity)),
        limit: 500,
      };
      applyAttributionDefault(params, true);

      const response = await metaApiClient.get<MetaApiResponse<InsightsResult>>(
        `/${path}/insights`,
        params,
      );
      const rows = response.data ?? [];
      if (rows.length === 0) {
        return {
          content: [{ type: "text", text: `No trend data for ${level} ${object_id} (${date_preset}).` }],
        };
      }

      const summary = `Performance trend (${granularity}, ${date_preset}): ${rows.length} bucket(s).`;
      return {
        content: [
          { type: "text", text: summary },
          { type: "text", text: truncateResponse(JSON.stringify(rows, null, 2)) },
        ],
      };
    },
  );

  // ─── Anomaly Signal ──────────────────────────────────────────
  server.registerTool(
    "ads_insights_anomaly_signal",
    {
      description:
        "Detect anomalies by comparing the last N days against the previous N days. Returns metrics whose change exceeds threshold_pct. Useful for `why is spend up?` / `did CPL spike?` workflows.",
      inputSchema: {
        object_id: z.string().describe("Account, campaign, ad set, or ad ID"),
        level: levelEnum.default("campaign"),
        window_days: z.number().min(1).max(30).default(7).describe("Days in each comparison window"),
        threshold_pct: z.number().min(1).max(500).default(30).describe("Min %change to flag as anomaly"),
      },
      annotations: { ...READ },
    },
    async ({ object_id, level, window_days, threshold_pct }) => {
      const path = resolveObjectPath(level, object_id);
      const today = new Date();
      const fmt = (d: Date) => d.toISOString().slice(0, 10);

      const recentEnd = new Date(today);
      recentEnd.setUTCDate(recentEnd.getUTCDate() - 1);
      const recentStart = new Date(recentEnd);
      recentStart.setUTCDate(recentStart.getUTCDate() - (window_days - 1));

      const prevEnd = new Date(recentStart);
      prevEnd.setUTCDate(prevEnd.getUTCDate() - 1);
      const prevStart = new Date(prevEnd);
      prevStart.setUTCDate(prevStart.getUTCDate() - (window_days - 1));

      const fetchWindow = async (since: string, until: string): Promise<ApiInsight | undefined> => {
        const params: Record<string, string | number | boolean> = {
          fields: CONTEXT_FIELDS,
          time_range: JSON.stringify({ since, until }),
          limit: 1,
        };
        applyAttributionDefault(params, true);
        const r = await metaApiClient.get<MetaApiResponse<ApiInsight>>(
          `/${path}/insights`,
          params,
        );
        return r.data?.[0];
      };

      const [recent, prev] = await Promise.all([
        fetchWindow(fmt(recentStart), fmt(recentEnd)),
        fetchWindow(fmt(prevStart), fmt(prevEnd)),
      ]);

      if (!recent || !prev) {
        return {
          content: [
            {
              type: "text",
              text: `Not enough data to compute anomalies for ${level} ${object_id}. Need data in both windows.`,
            },
          ],
        };
      }

      const compareKeys = ["spend", "impressions", "clicks", "ctr", "cpc", "cpm"] as const;
      type AnomalyKey = typeof compareKeys[number];
      const anomalies: Array<{
        metric: AnomalyKey;
        current: number;
        previous: number;
        delta_pct: number;
      }> = [];

      for (const key of compareKeys) {
        const cur = Number(recent[key] ?? 0);
        const before = Number(prev[key] ?? 0);
        if (before === 0 && cur === 0) continue;
        const deltaPct = before === 0 ? 100 : ((cur - before) / before) * 100;
        if (Math.abs(deltaPct) >= threshold_pct) {
          anomalies.push({ metric: key, current: cur, previous: before, delta_pct: Number(deltaPct.toFixed(1)) });
        }
      }

      const text =
        anomalies.length === 0
          ? `No anomalies above ${threshold_pct}% threshold (window ${window_days}d).`
          : `Anomalies (>${threshold_pct}% change vs prior ${window_days}d):\n${anomalies
              .map((a) => `• ${a.metric}: ${a.delta_pct >= 0 ? "+" : ""}${a.delta_pct}% (${a.previous} → ${a.current})`)
              .join("\n")}`;

      return {
        content: [
          { type: "text", text },
          {
            type: "text",
            text: JSON.stringify(
              {
                window_days,
                threshold_pct,
                recent_window: { since: fmt(recentStart), until: fmt(recentEnd) },
                previous_window: { since: fmt(prevStart), until: fmt(prevEnd) },
                anomalies,
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  // ─── Auction Ranking Benchmarks ──────────────────────────────
  server.registerTool(
    "ads_insights_auction_ranking_benchmarks",
    {
      description:
        "Quality, engagement, and conversion rate rankings for an ad in Meta's auction. Only available at level=ad with sufficient delivery (~500 impressions). Useful to diagnose 'below average' creatives that compete poorly.",
      inputSchema: {
        ad_id: z.string().describe("Ad ID (rankings are only published at ad level)"),
        date_preset: datePresetEnum.default("last_7d"),
      },
      annotations: { ...READ },
    },
    async ({ ad_id, date_preset }) => {
      const id = validateMetaId(ad_id, "ad");
      const params: Record<string, string | number | boolean> = {
        fields: RANKING_FIELDS,
        date_preset,
        limit: 1,
      };
      applyAttributionDefault(params, true);

      const response = await metaApiClient.get<MetaApiResponse<ApiInsight>>(
        `/${id}/insights`,
        params,
      );
      const row = response.data?.[0];
      if (!row) {
        return {
          content: [
            {
              type: "text",
              text: `No ranking data available for ad ${id} in ${date_preset}. Rankings appear after ~500 impressions.`,
            },
          ],
        };
      }

      const lines = [
        `Auction Ranking (${date_preset}):`,
        `  Quality:           ${row.quality_ranking ?? "N/A"}`,
        `  Engagement Rate:   ${row.engagement_rate_ranking ?? "N/A"}`,
        `  Conversion Rate:   ${row.conversion_rate_ranking ?? "N/A"}`,
        `  Impressions:       ${row.impressions ?? "N/A"}`,
        `  Spend:             ${row.spend ?? "N/A"}`,
      ];

      return {
        content: [
          { type: "text", text: lines.join("\n") },
          { type: "text", text: JSON.stringify(row, null, 2) },
        ],
      };
    },
  );

  // ─── Industry Benchmark ──────────────────────────────────────
  server.registerTool(
    "ads_insights_industry_benchmark",
    {
      description:
        "Compare an object's CTR / CPC / CPM against industry medians (when available). For now uses a curated benchmark table; falls back to portfolio averages if industry not specified. Best-effort signal — Meta does not expose an authoritative benchmark API.",
      inputSchema: {
        object_id: z.string().describe("Account, campaign, ad set, or ad ID"),
        level: levelEnum.default("campaign"),
        industry: z
          .enum(["igaming", "ecommerce", "lead_gen", "saas", "finance", "education", "default"])
          .default("default")
          .describe("Industry vertical for benchmark lookup"),
        date_preset: datePresetEnum.default("last_30d"),
      },
      annotations: { ...READ },
    },
    async ({ object_id, level, industry, date_preset }) => {
      const path = resolveObjectPath(level, object_id);
      const params: Record<string, string | number | boolean> = {
        fields: "ctr,cpc,cpm,spend,impressions",
        date_preset,
        limit: 1,
      };
      applyAttributionDefault(params, true);
      const response = await metaApiClient.get<MetaApiResponse<ApiInsight>>(
        `/${path}/insights`,
        params,
      );
      const row = response.data?.[0];

      if (!row) {
        return {
          content: [{ type: "text", text: `No insights data to benchmark for ${level} ${object_id}.` }],
        };
      }

      const benchmark = INDUSTRY_BENCHMARKS[industry];
      const metrics: Array<{ name: string; observed: number; benchmark: number; delta_pct: number }> = [];
      const ctr = Number(row.ctr ?? 0);
      const cpc = Number(row.cpc ?? 0);
      const cpm = Number(row.cpm ?? 0);

      const compute = (name: string, observed: number, target: number) => {
        if (observed === 0 || target === 0) return;
        metrics.push({
          name,
          observed,
          benchmark: target,
          delta_pct: Number((((observed - target) / target) * 100).toFixed(1)),
        });
      };

      compute("ctr", ctr, benchmark.ctr);
      compute("cpc", cpc, benchmark.cpc);
      compute("cpm", cpm, benchmark.cpm);

      const text = `Benchmark vs ${industry} industry (${date_preset}):\n${metrics
        .map((m) => {
          const direction = m.name === "ctr" ? (m.delta_pct >= 0 ? "✅ above" : "⚠️ below") : (m.delta_pct <= 0 ? "✅ below" : "⚠️ above");
          return `  • ${m.name}: ${m.observed} vs ${m.benchmark} → ${m.delta_pct >= 0 ? "+" : ""}${m.delta_pct}% ${direction}`;
        })
        .join("\n")}`;

      return {
        content: [
          { type: "text", text },
          { type: "text", text: JSON.stringify({ industry, benchmark, observed: row, metrics }, null, 2) },
        ],
      };
    },
  );

  // ─── Advertiser Context ──────────────────────────────────────
  server.registerTool(
    "ads_insights_advertiser_context",
    {
      description:
        "First-message account snapshot for an agent: account-level KPIs, top campaigns by spend, and key totals over a date range. Use this when starting an analysis session before drilling into specific campaigns.",
      inputSchema: {
        account_id: z.string().describe("Ad account ID"),
        date_preset: datePresetEnum.default("last_30d"),
        top_n_campaigns: z.number().min(1).max(20).default(5),
      },
      annotations: { ...READ },
    },
    async ({ account_id, date_preset, top_n_campaigns }) => {
      const id = normalizeAccountId(account_id);

      const accountParams: Record<string, string | number | boolean> = {
        fields: CONTEXT_FIELDS,
        date_preset,
        limit: 1,
      };
      applyAttributionDefault(accountParams, true);

      const campaignParams: Record<string, string | number | boolean> = {
        fields: "campaign_id,campaign_name,spend,impressions,clicks,ctr,cpc",
        date_preset,
        level: "campaign",
        limit: top_n_campaigns,
      };
      applyAttributionDefault(campaignParams, true);

      const [accountInsights, campaignInsights, accountMeta] = await Promise.all([
        metaApiClient.get<MetaApiResponse<ApiInsight>>(`/${id}/insights`, accountParams),
        metaApiClient.get<MetaApiResponse<ApiInsight & { campaign_id?: string; campaign_name?: string }>>(
          `/${id}/insights`,
          campaignParams,
        ),
        metaApiClient
          .get<{ name?: string; currency?: string; account_status?: number; balance?: string; amount_spent?: string }>(
            `/${id}`,
            { fields: "name,currency,account_status,balance,amount_spent" },
          )
          .catch(() => ({} as { name?: string; currency?: string; account_status?: number; balance?: string; amount_spent?: string })),
      ]);

      const total = accountInsights.data?.[0];
      const summary = total
        ? buildSingleInsightSummary(total as InsightsResult)
        : "No account-level insights for this period.";

      const topCampaigns = (campaignInsights.data ?? [])
        .sort((a, b) => Number(b.spend ?? 0) - Number(a.spend ?? 0))
        .slice(0, top_n_campaigns);

      const lines: string[] = [
        `Account: ${accountMeta?.name ?? account_id} (${accountMeta?.currency ?? "?"})`,
        `Period: ${date_preset}`,
        ``,
        summary,
        ``,
        `Top ${topCampaigns.length} campaigns by spend:`,
        ...topCampaigns.map(
          (c) =>
            `  • ${c.campaign_name ?? c.campaign_id}: spend=${c.spend ?? 0}, ctr=${c.ctr ?? "?"}, cpc=${c.cpc ?? "?"}`,
        ),
      ];

      return {
        content: [
          { type: "text", text: lines.join("\n") },
          {
            type: "text",
            text: JSON.stringify(
              {
                account: accountMeta,
                totals: total,
                top_campaigns: topCampaigns,
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );
}

interface IndustryBenchmark {
  ctr: number; // %
  cpc: number; // currency units
  cpm: number; // currency units
}

/**
 * Curated baseline benchmarks for v3.0 — broad public-domain medians, not
 * authoritative. Refine with internal data over time.
 */
const INDUSTRY_BENCHMARKS: Record<string, IndustryBenchmark> = {
  igaming: { ctr: 1.4, cpc: 0.6, cpm: 8.0 },
  ecommerce: { ctr: 1.6, cpc: 0.7, cpm: 11.0 },
  lead_gen: { ctr: 1.0, cpc: 1.2, cpm: 12.0 },
  saas: { ctr: 0.9, cpc: 1.8, cpm: 16.0 },
  finance: { ctr: 0.8, cpc: 2.5, cpm: 18.0 },
  education: { ctr: 1.1, cpc: 0.9, cpm: 9.0 },
  default: { ctr: 1.2, cpc: 1.0, cpm: 11.0 },
};

