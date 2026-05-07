import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { metaApiClient } from "../meta/client.js";
import { truncateResponse, validateMetaId } from "../utils/format.js";
import { buildFieldsParam } from "../utils/validation.js";
import { INSIGHTS_DEFAULT_FIELDS } from "../meta/types/insights.js";
import type { InsightsResult, MetaApiResponse } from "../meta/types/index.js";
import {
  enforceInsightsGuardrails,
  applyAttributionDefault,
} from "./insights-guardrails.js";
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { logger } from "../utils/logger.js";
import { READ, CREATE, WRITE_WARNING } from "./_register.js";

const datePresetEnum = z.enum([
  "today", "yesterday", "this_month", "last_month", "this_quarter",
  "maximum", "last_3d", "last_7d", "last_14d", "last_28d", "last_30d",
  "last_90d", "last_week_mon_sun", "last_week_sun_sat", "last_quarter",
  "last_year", "this_week_mon_today", "this_week_sun_today", "this_year",
]);

const breakdownEnum = z.enum([
  "age", "gender", "country", "region", "dma",
  "impression_device", "device_platform", "platform_position",
  "publisher_platform", "product_id", "frequency_value",
  "hourly_stats_aggregated_by_advertiser_time_zone",
  "hourly_stats_aggregated_by_audience_time_zone",
]);

const levelEnum = z.enum(["ad", "adset", "campaign", "account"]);

const MIN_POLL_INTERVAL_MS = 5_000;
const DEFAULT_POLL_INTERVAL_SECONDS = 10;
const DEFAULT_MAX_WAIT_SECONDS = 600;
const MAX_MAX_WAIT_SECONDS = 3600;

interface AsyncReportRun {
  id: string;
  report_run_id?: string;
}

interface ReportRunStatus {
  id: string;
  async_status: string;
  async_percent_completion: number;
  date_start?: string;
  date_stop?: string;
  error_code?: number;
  error_subcode?: number;
  error_message?: string;
  error_user_title?: string;
  error_user_msg?: string;
}

const lastPollAt = new Map<string, number>();

export function registerReportTools(server: McpServer): void {
  // ─── Create Async Report ──────────────────────────────────────
  server.registerTool(
    "ads_create_async_report",
    {
      description: `${WRITE_WARNING}Create an asynchronous report for large data exports. Use this when you need to pull extensive insights data that would time out with a synchronous request. NOTE: report_run_id expires 30 days after creation. Consider ads_run_report_and_wait for small/medium reports that finish in <10 min.`,
      inputSchema: {
        object_id: z
          .string()
          .describe("Campaign, Ad Set, Ad, or Account ID (use act_XXX for accounts)"),
        level: levelEnum.optional().describe("Aggregation level"),
        time_range: z
          .object({
            since: z.string().describe("Start date YYYY-MM-DD"),
            until: z.string().describe("End date YYYY-MM-DD"),
          })
          .optional(),
        date_preset: datePresetEnum.optional(),
        breakdowns: z.array(breakdownEnum).optional(),
        fields: z.array(z.string()).optional().describe("Metrics to include"),
        use_unified_attribution_setting: z.boolean().default(true),
        time_increment: z
          .union([
            z.number().min(1).max(90),
            z.enum(["monthly", "all_days"]),
          ])
          .optional()
          .describe("Time increment for series data"),
      },
      annotations: { ...CREATE },
    },
    async ({
      object_id, level, time_range, date_preset, breakdowns, fields,
      use_unified_attribution_setting, time_increment,
    }) => {
      const objectId = validateMetaId(object_id, "object");
      enforceInsightsGuardrails({
        level,
        breakdowns,
        date_preset,
        time_range,
        is_async: true,
      });

      const fieldsParam = buildFieldsParam(fields, [...INSIGHTS_DEFAULT_FIELDS]);
      const params: Record<string, string | number | boolean> = { fields: fieldsParam };
      applyAttributionDefault(params, use_unified_attribution_setting);

      if (level) params.level = level;
      if (time_range) params.time_range = JSON.stringify(time_range);
      if (date_preset) params.date_preset = date_preset;
      if (breakdowns && breakdowns.length > 0) params.breakdowns = breakdowns.join(",");
      if (time_increment !== undefined) params.time_increment = String(time_increment);

      const result = await metaApiClient.postForm<AsyncReportRun>(
        `/${objectId}/insights`,
        params,
      );

      const reportId = result.report_run_id ?? result.id;

      return {
        content: [
          {
            type: "text",
            text: `Async report created!\nReport Run ID: ${reportId}\n(Expires in 30 days.)\n\nUse ads_get_report_status to check progress (poll every ≥5s), then ads_get_report_results to download. Or use ads_run_report_and_wait for a one-shot wait.`,
          },
        ],
      };
    },
  );

  // ─── Get Report Status ────────────────────────────────────────
  server.registerTool(
    "ads_get_report_status",
    {
      description:
        "Check the status of an asynchronous report. Enforces a 5-second minimum between polls for the same report to avoid burning quota. Returns clear guidance on Job Failed / Job Skipped states.",
      inputSchema: {
        report_run_id: z.string().describe("Report run ID from ads_create_async_report"),
      },
      annotations: { ...READ },
    },
    async ({ report_run_id }) => {
      const id = validateMetaId(report_run_id, "report_run");
      enforceMinPollInterval(id);

      const status = await metaApiClient.get<ReportRunStatus>(
        `/${id}`,
        {
          fields:
            "id,async_status,async_percent_completion,date_start,date_stop,error_code,error_subcode,error_message,error_user_title,error_user_msg",
        },
      );

      return { content: [{ type: "text", text: formatStatus(id, status) }] };
    },
  );

  // ─── Get Report Results ───────────────────────────────────────
  server.registerTool(
    "ads_get_report_results",
    {
      description: "Download the results of a completed async report.",
      inputSchema: {
        report_run_id: z.string().describe("Report run ID"),
        limit: z.number().min(1).max(1000).default(500),
      },
      annotations: { ...READ },
    },
    async ({ report_run_id, limit }) => {
      const id = validateMetaId(report_run_id, "report_run");
      const response = await metaApiClient.get<MetaApiResponse<InsightsResult>>(
        `/${id}/insights`,
        { limit },
      );
      const results = response.data ?? [];

      if (results.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: "No results available. Ensure the report has completed (check with ads_get_report_status).",
            },
          ],
        };
      }

      const jsonStr = truncateResponse(JSON.stringify(results, null, 2));

      return {
        content: [
          { type: "text", text: `Report results: ${results.length} row(s) of data.` },
          { type: "text", text: jsonStr },
        ],
      };
    },
  );

  // ─── Run Report and Wait ──────────────────────────────────────
  server.registerTool(
    "ads_run_report_and_wait",
    {
      description: `${WRITE_WARNING}Create an async report and wait for completion in one call. Uses safe polling (start 10s, backoff to 60s max) and returns results directly when Job Completed. On timeout, returns the report_run_id so you can continue polling later. Max wait: 3600s.`,
      inputSchema: {
        object_id: z.string(),
        level: levelEnum.optional(),
        time_range: z
          .object({ since: z.string(), until: z.string() })
          .optional(),
        date_preset: datePresetEnum.optional(),
        breakdowns: z.array(breakdownEnum).optional(),
        fields: z.array(z.string()).optional(),
        use_unified_attribution_setting: z.boolean().default(true),
        time_increment: z
          .union([
            z.number().min(1).max(90),
            z.enum(["monthly", "all_days"]),
          ])
          .optional(),
        max_wait_seconds: z
          .number()
          .min(30)
          .max(MAX_MAX_WAIT_SECONDS)
          .default(DEFAULT_MAX_WAIT_SECONDS),
        poll_interval_seconds: z
          .number()
          .min(MIN_POLL_INTERVAL_MS / 1000)
          .max(60)
          .default(DEFAULT_POLL_INTERVAL_SECONDS),
        result_limit: z.number().min(1).max(1000).default(500),
      },
      annotations: { ...CREATE },
    },
    async ({
      object_id, level, time_range, date_preset, breakdowns, fields,
      use_unified_attribution_setting, time_increment,
      max_wait_seconds, poll_interval_seconds, result_limit,
    }) => {
      const objectId = validateMetaId(object_id, "object");
      enforceInsightsGuardrails({
        level,
        breakdowns,
        date_preset,
        time_range,
        is_async: true,
      });

      const fieldsParam = buildFieldsParam(fields, [...INSIGHTS_DEFAULT_FIELDS]);
      const params: Record<string, string | number | boolean> = { fields: fieldsParam };
      applyAttributionDefault(params, use_unified_attribution_setting);
      if (level) params.level = level;
      if (time_range) params.time_range = JSON.stringify(time_range);
      if (date_preset) params.date_preset = date_preset;
      if (breakdowns && breakdowns.length > 0) params.breakdowns = breakdowns.join(",");
      if (time_increment !== undefined) params.time_increment = String(time_increment);

      const created = await metaApiClient.postForm<AsyncReportRun>(
        `/${objectId}/insights`,
        params,
      );
      const reportId = validateMetaId(created.report_run_id ?? created.id, "report_run");

      const deadline = Date.now() + max_wait_seconds * 1000;
      let interval = Math.max(MIN_POLL_INTERVAL_MS, poll_interval_seconds * 1000);

      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, interval));
        interval = Math.min(60_000, Math.round(interval * 1.5));

        const status = await metaApiClient.get<ReportRunStatus>(
          `/${reportId}`,
          {
            fields:
              "id,async_status,async_percent_completion,error_code,error_subcode,error_message,error_user_title,error_user_msg",
          },
        );

        if (status.async_status === "Job Completed") {
          const results = await metaApiClient.get<MetaApiResponse<InsightsResult>>(
            `/${reportId}/insights`,
            { limit: result_limit },
          );
          const rows = results.data ?? [];
          return {
            content: [
              { type: "text", text: `Report ${reportId} completed: ${rows.length} row(s).` },
              { type: "text", text: truncateResponse(JSON.stringify(rows, null, 2)) },
            ],
          };
        }

        if (status.async_status === "Job Failed") {
          throw new McpError(
            ErrorCode.InternalError,
            `Async report ${reportId} failed (code ${status.error_code ?? "?"}, subcode ${status.error_subcode ?? "?"}): ${status.error_message ?? "no message"}${status.error_user_msg ? ` — ${status.error_user_msg}` : ""}. Do not retry without changing parameters.`,
          );
        }
        if (status.async_status === "Job Skipped") {
          throw new McpError(
            ErrorCode.InternalError,
            `Async report ${reportId} was skipped (expired). Resubmit with ads_create_async_report.`,
          );
        }
        logger.debug(
          {
            event: "meta_report_poll",
            reportId,
            status: status.async_status,
            pct: status.async_percent_completion,
          },
          "Polling async report",
        );
      }

      return {
        content: [
          {
            type: "text",
            text: `Timed out after ${max_wait_seconds}s waiting for report ${reportId}. The job is still running on Meta's side — poll ads_get_report_status periodically and fetch with ads_get_report_results when done.\nReport Run ID: ${reportId}`,
          },
        ],
      };
    },
  );
}

function enforceMinPollInterval(reportId: string): void {
  const now = Date.now();
  const prev = lastPollAt.get(reportId);
  if (prev !== undefined && now - prev < MIN_POLL_INTERVAL_MS) {
    const waitMs = MIN_POLL_INTERVAL_MS - (now - prev);
    throw new McpError(
      ErrorCode.InvalidRequest,
      `Polling too fast for report ${reportId}. Wait ${Math.ceil(waitMs / 1000)}s before the next status check (minimum ${MIN_POLL_INTERVAL_MS / 1000}s between polls to protect your quota).`,
    );
  }
  lastPollAt.set(reportId, now);
}

function formatStatus(reportId: string, status: ReportRunStatus): string {
  const lines = [
    `Report ${reportId}:`,
    `Status: ${status.async_status}`,
    `Progress: ${status.async_percent_completion}%`,
  ];
  if (status.date_start) lines.push(`Period: ${status.date_start} → ${status.date_stop}`);

  if (status.async_status === "Job Completed") {
    lines.push("", "Ready! Use ads_get_report_results to download.");
  } else if (status.async_status === "Job Failed") {
    lines.push("", `FAILED — code ${status.error_code ?? "?"} / subcode ${status.error_subcode ?? "?"}.`);
    if (status.error_message) lines.push(`Error: ${status.error_message}`);
    if (status.error_user_title || status.error_user_msg) {
      lines.push(
        `Meta: [${status.error_user_title ?? ""}] ${status.error_user_msg ?? ""}`.trim(),
      );
    }
    lines.push("Do not retry without changing parameters — retrying the same query will fail the same way.");
  } else if (status.async_status === "Job Skipped") {
    lines.push("", "SKIPPED — report_run_id expired. Resubmit with ads_create_async_report.");
  } else {
    lines.push("", "Still processing... Wait ≥5s before polling again.");
  }

  return lines.join("\n");
}
