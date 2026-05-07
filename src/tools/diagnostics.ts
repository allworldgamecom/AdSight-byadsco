import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { metaApiClient } from "../meta/client.js";
import { normalizeAccountId, validateMetaId } from "../utils/format.js";
import type { Ad, MetaApiResponse } from "../meta/types/index.js";
import { READ } from "./_register.js";

const severityEnum = z.enum(["critical", "warning", "info", "all"]);

interface OpportunityScore {
  score?: number;
  recommendations?: Array<{
    type?: string;
    description?: string;
    estimated_impact?: string;
  }>;
}

interface PixelDetails {
  id: string;
  name?: string;
  last_fired_time?: string;
  is_unavailable?: boolean;
  match_rate_approx?: number;
  data_use_setting?: string;
  enable_automatic_matching?: boolean;
  automatic_matching_fields?: string[];
}

export function registerDiagnosticTools(server: McpServer): void {
  // ─── Opportunity Score ───────────────────────────────────────
  server.registerTool(
    "ads_get_opportunity_score",
    {
      description:
        "Get Meta's Opportunity Score for an account or campaign — a 0-100 health/improvement signal Meta surfaces in Ads Manager. Includes recommendations when available. Mirrors the official Meta MCP tool.",
      inputSchema: {
        account_id: z.string().describe("Ad account ID"),
        level: z.enum(["account", "campaign"]).default("account"),
        object_id: z
          .string()
          .optional()
          .describe("Required when level='campaign' — the campaign ID to score"),
      },
      annotations: { ...READ },
    },
    async ({ account_id, level, object_id }) => {
      if (level === "campaign" && !object_id) {
        throw new Error("object_id is required when level='campaign'.");
      }
      const id =
        level === "campaign"
          ? validateMetaId(object_id!, "campaign")
          : normalizeAccountId(account_id);

      const result = await metaApiClient.get<OpportunityScore>(`/${id}`, {
        fields: "opportunity_score",
      });

      const score = result.score;
      const recs = result.recommendations ?? [];

      const lines: string[] = [
        `Opportunity Score for ${level} ${id}: ${score ?? "not available yet"}`,
      ];
      if (recs.length > 0) {
        lines.push("\nRecommendations:");
        for (const r of recs) {
          lines.push(`  • [${r.type ?? "?"}] ${r.description ?? ""}${r.estimated_impact ? ` — Impact: ${r.estimated_impact}` : ""}`);
        }
      } else {
        lines.push("\nNo specific recommendations available for this period.");
      }

      return {
        content: [
          { type: "text", text: lines.join("\n") },
          { type: "text", text: JSON.stringify(result, null, 2) },
        ],
      };
    },
  );

  // ─── Dataset Quality (Pixel Health) ──────────────────────────
  server.registerTool(
    "ads_get_dataset_quality",
    {
      description:
        "Synthetic health overview for a pixel/dataset: last fire time, match rate, automatic matching configuration. For raw event stats use ads_get_pixel_events; for installation code use ads_get_pixel_details.",
      inputSchema: {
        pixel_id: z.string().describe("Pixel/Dataset ID"),
      },
      annotations: { ...READ },
    },
    async ({ pixel_id }) => {
      const id = validateMetaId(pixel_id, "pixel");
      const pixel = await metaApiClient.get<PixelDetails>(`/${id}`, {
        fields:
          "id,name,last_fired_time,is_unavailable,match_rate_approx,data_use_setting,enable_automatic_matching,automatic_matching_fields",
      });

      const issues: string[] = [];
      const lastFiredMs = pixel.last_fired_time ? Date.parse(pixel.last_fired_time) : NaN;
      const hoursSinceFire = Number.isFinite(lastFiredMs)
        ? (Date.now() - lastFiredMs) / 3_600_000
        : Infinity;

      let healthScore = 100;
      if (pixel.is_unavailable) {
        issues.push("Pixel marked as unavailable.");
        healthScore -= 50;
      }
      if (!pixel.last_fired_time) {
        issues.push("Pixel has never fired.");
        healthScore -= 40;
      } else if (hoursSinceFire > 24) {
        issues.push(`Last fired ${Math.round(hoursSinceFire)}h ago — events may be stalled.`);
        healthScore -= 25;
      }
      if (pixel.match_rate_approx !== undefined && pixel.match_rate_approx < 0.6) {
        issues.push(`Match rate is low (${(pixel.match_rate_approx * 100).toFixed(0)}%) — consider enabling Automatic Advanced Matching.`);
        healthScore -= 15;
      }
      if (!pixel.enable_automatic_matching) {
        issues.push("Automatic Advanced Matching disabled.");
        healthScore -= 5;
      }
      healthScore = Math.max(0, healthScore);

      const lines: string[] = [
        `Dataset/Pixel Quality: ${pixel.name ?? id}`,
        `Health Score: ${healthScore}/100`,
        `Last fired: ${pixel.last_fired_time ?? "Never"}`,
        `Match rate: ${pixel.match_rate_approx !== undefined ? `${(pixel.match_rate_approx * 100).toFixed(0)}%` : "N/A"}`,
        `Automatic Advanced Matching: ${pixel.enable_automatic_matching ? "ENABLED" : "DISABLED"}`,
      ];
      if (issues.length > 0) {
        lines.push("\nIssues:");
        for (const i of issues) lines.push(`  • ${i}`);
      }

      return {
        content: [
          { type: "text", text: lines.join("\n") },
          { type: "text", text: JSON.stringify({ ...pixel, health_score: healthScore, issues }, null, 2) },
        ],
      };
    },
  );

  // ─── Account-level Errors / Issues ───────────────────────────
  server.registerTool(
    "ads_get_errors",
    {
      description:
        "List current errors and issues at the account level: rejected ads, ads with delivery issues, account restrictions. Combine with ads_get_help_article to look up rejection reasons. Mirrors the official Meta MCP tool.",
      inputSchema: {
        account_id: z.string().describe("Ad account ID"),
        severity: severityEnum.default("all"),
        limit: z.number().min(1).max(200).default(50),
      },
      annotations: { ...READ },
    },
    async ({ account_id, severity, limit }) => {
      const id = normalizeAccountId(account_id);

      const issuesResponse = await metaApiClient.get<MetaApiResponse<Ad>>(
        `/${id}/ads`,
        {
          fields: "id,name,effective_status,issues_info,recommendations",
          filtering: JSON.stringify([
            {
              field: "effective_status",
              operator: "IN",
              value: ["DISAPPROVED", "WITH_ISSUES", "PENDING_REVIEW", "PREAPPROVED"],
            },
          ]),
          limit,
        },
      );

      type AdWithIssues = Ad & {
        issues_info?: Array<{
          level?: string;
          error_code?: number;
          error_summary?: string;
          error_message?: string;
        }>;
      };
      const ads = (issuesResponse.data ?? []) as AdWithIssues[];

      const accountStatus = await metaApiClient
        .get<{ disable_reason?: number; account_status?: number }>(`/${id}`, {
          fields: "disable_reason,account_status",
        })
        .catch(() => ({} as { disable_reason?: number; account_status?: number }));

      const normalized: Array<{
        type: string;
        severity: "critical" | "warning" | "info";
        entity_id: string;
        message: string;
      }> = [];

      if (accountStatus.disable_reason && accountStatus.disable_reason > 0) {
        normalized.push({
          type: "account",
          severity: "critical",
          entity_id: id,
          message: `Account disable_reason=${accountStatus.disable_reason}, status=${accountStatus.account_status}`,
        });
      }

      for (const ad of ads) {
        const status = ad.effective_status;
        const sev: "critical" | "warning" | "info" =
          status === "DISAPPROVED" ? "critical" : status === "WITH_ISSUES" ? "warning" : "info";
        if (severity !== "all" && sev !== severity) continue;
        const summary =
          ad.issues_info?.[0]?.error_summary ??
          ad.issues_info?.[0]?.error_message ??
          status ??
          "Unknown issue";
        normalized.push({
          type: "ad",
          severity: sev,
          entity_id: ad.id,
          message: `${ad.name ?? ad.id}: ${summary}`,
        });
      }

      const text =
        normalized.length === 0
          ? `No issues found for account ${id} at severity=${severity}.`
          : `Found ${normalized.length} issue(s):\n${normalized
              .map((n) => `  • [${n.severity.toUpperCase()}] ${n.type} ${n.entity_id} — ${n.message}`)
              .join("\n")}`;

      return {
        content: [
          { type: "text", text },
          { type: "text", text: JSON.stringify(normalized, null, 2) },
        ],
      };
    },
  );
}
