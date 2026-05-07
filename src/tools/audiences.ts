import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { metaApiClient } from "../meta/client.js";
import { normalizeAccountId, validateMetaId } from "../utils/format.js";
import { buildFieldsParam } from "../utils/validation.js";
import { AUDIENCE_DEFAULT_FIELDS } from "../meta/types/audience.js";
import type { CustomAudience, MetaApiResponse } from "../meta/types/index.js";
import { READ, CREATE, DELETE, WRITE_WARNING } from "./_register.js";

export function registerAudienceTools(server: McpServer): void {
  // ─── Get Custom Audiences ─────────────────────────────────────
  server.registerTool(
    "ads_get_custom_audiences",
    {
      description:
        "List custom audiences for an ad account. Includes lookalikes, website audiences, customer lists, engagement audiences and offline-conversion audiences. Use the returned audience id with ads_update_ad_set (targeting.custom_audiences=[{id}]) to apply the audience to an ad set.",
      inputSchema: {
        account_id: z.string().describe("Ad account ID"),
        limit: z.number().min(1).max(100).default(25),
        fields: z.array(z.string()).optional(),
      },
      annotations: { ...READ },
    },
    async ({ account_id, limit, fields }) => {
      const id = normalizeAccountId(account_id);
      const fieldsParam = buildFieldsParam(fields, [...AUDIENCE_DEFAULT_FIELDS]);

      const response = await metaApiClient.get<MetaApiResponse<CustomAudience>>(
        `/${id}/customaudiences`,
        { fields: fieldsParam, limit },
      );
      const audiences = response.data ?? [];

      const text =
        audiences.length === 0
          ? "No custom audiences found."
          : audiences
              .map(
                (a) =>
                  `• ${a.name} (${a.id}) — Type: ${a.subtype} — Size: ${a.approximate_count_lower_bound ?? "?"}-${a.approximate_count_upper_bound ?? "?"}`,
              )
              .join("\n");

      return {
        content: [
          { type: "text", text: `Found ${audiences.length} audience(s):\n\n${text}` },
          { type: "text", text: JSON.stringify(audiences, null, 2) },
        ],
      };
    },
  );

  // ─── Get Audience Details ─────────────────────────────────────
  server.registerTool(
    "ads_get_audience_details",
    {
      description:
        "Get detailed information about a specific custom audience, including subtype, retention period, approximate size bounds and lookalike spec. Useful before applying it to an ad set via ads_update_ad_set.",
      inputSchema: {
        audience_id: z.string().describe("Custom audience ID"),
        fields: z.array(z.string()).optional(),
      },
      annotations: { ...READ },
    },
    async ({ audience_id, fields }) => {
      const id = validateMetaId(audience_id, "audience");
      const fieldsParam = buildFieldsParam(fields, [...AUDIENCE_DEFAULT_FIELDS]);

      const audience = await metaApiClient.get<CustomAudience>(
        `/${id}`,
        { fields: fieldsParam },
      );

      return {
        content: [
          {
            type: "text",
            text: `Audience: ${audience.name} (${audience.id})\nType: ${audience.subtype}\nSize: ${audience.approximate_count_lower_bound ?? "?"}-${audience.approximate_count_upper_bound ?? "?"}`,
          },
          { type: "text", text: JSON.stringify(audience, null, 2) },
        ],
      };
    },
  );

  // ─── Create Custom Audience ───────────────────────────────────
  server.registerTool(
    "ads_create_custom_audience",
    {
      description: `${WRITE_WARNING}Create a new custom audience on an ad account (CUSTOM customer-list, WEBSITE pixel-based, APP, OFFLINE_CONVERSION or ENGAGEMENT). For CUSTOM/customer-list audiences, PII (email, phone) must be SHA-256 hashed before upload. After creation: (1) optionally feed users via the customer-list endpoint, (2) build a lookalike with ads_create_lookalike_audience, and (3) apply the audience id to an ad set with ads_update_ad_set (targeting.custom_audiences=[{id}]).`,
      inputSchema: {
        account_id: z.string().describe("Ad account ID"),
        name: z.string().min(1).describe("Audience name"),
        description: z.string().optional().describe("Audience description"),
        subtype: z
          .enum(["CUSTOM", "WEBSITE", "APP", "OFFLINE_CONVERSION", "ENGAGEMENT"])
          .default("CUSTOM")
          .describe("Audience subtype"),
        customer_file_source: z
          .enum([
            "USER_PROVIDED_ONLY",
            "PARTNER_PROVIDED_ONLY",
            "BOTH_USER_AND_PARTNER_PROVIDED",
          ])
          .optional()
          .describe("Source of customer data (required for CUSTOM subtype)"),
        retention_days: z.number().optional().describe("Retention period in days"),
        rule: z.string().optional().describe("Rule definition for WEBSITE audiences (JSON string)"),
        prefill: z.boolean().optional().describe("Whether to prefill with existing data (for WEBSITE)"),
      },
      annotations: { ...CREATE },
    },
    async ({ account_id, name, description, subtype, customer_file_source, retention_days, rule, prefill }) => {
      const id = normalizeAccountId(account_id);

      const body: Record<string, string | number | boolean> = {
        name,
        subtype,
      };

      if (description) body.description = description;
      if (customer_file_source) body.customer_file_source = customer_file_source;
      if (retention_days !== undefined) body.retention_days = retention_days;
      if (rule) body.rule = rule;
      if (prefill !== undefined) body.prefill = prefill;

      const result = await metaApiClient.postForm<{ id: string }>(
        `/${id}/customaudiences`,
        body,
      );

      return {
        content: [
          {
            type: "text",
            text: `Custom audience created!\nID: ${result.id}\nName: ${name}\nType: ${subtype}`,
          },
        ],
      };
    },
  );

  // ─── Create Lookalike Audience ────────────────────────────────
  server.registerTool(
    "ads_create_lookalike_audience",
    {
      description: `${WRITE_WARNING}Create a lookalike audience seeded by an existing custom audience. Source must have ~100+ matched users or Meta rejects the request. Ratio controls similarity vs. reach (0.01 = closest 1%, 0.20 = top 20% — bigger reach, lower similarity). After creation, apply the lookalike id to an ad set with ads_update_ad_set (targeting.custom_audiences=[{id}]). Lookalikes typically need ~24 h to compute users — id is returned immediately but reach starts at zero.`,
      inputSchema: {
        account_id: z.string().describe("Ad account ID"),
        name: z.string().min(1).describe("Lookalike audience name"),
        origin_audience_id: z.string().describe("Source custom audience ID"),
        ratio: z.number().min(0.01).max(0.20).describe("Lookalike ratio (0.01 = 1%, 0.20 = 20%)"),
        country: z.string().describe("Target country ISO code (e.g., CO, US, MX)"),
        description: z.string().optional(),
      },
      annotations: { ...CREATE },
    },
    async ({ account_id, name, origin_audience_id, ratio, country, description }) => {
      const accountPath = normalizeAccountId(account_id);
      const originAudienceIdValidated = validateMetaId(origin_audience_id, "audience");

      const body: Record<string, string | number | boolean> = {
        name,
        subtype: "LOOKALIKE",
        origin_audience_id: originAudienceIdValidated,
        lookalike_spec: JSON.stringify({
          ratio,
          country,
          type: "similarity",
        }),
      };

      if (description) body.description = description;

      const result = await metaApiClient.postForm<{ id: string }>(
        `/${accountPath}/customaudiences`,
        body,
      );

      return {
        content: [
          {
            type: "text",
            text: `Lookalike audience created!\nID: ${result.id}\nName: ${name}\nSource: ${originAudienceIdValidated}\nRatio: ${(ratio * 100).toFixed(0)}%\nCountry: ${country}`,
          },
        ],
      };
    },
  );

  // ─── Delete Custom Audience ───────────────────────────────────
  server.registerTool(
    "ads_delete_custom_audience",
    {
      description: `${WRITE_WARNING}Permanently delete a custom audience from the ad account. Cannot be undone. To remove an audience from a single ad set without destroying it everywhere, prefer ads_update_ad_set with targeting.custom_audiences set to a different array (or omitted from a fresh targeting spec).`,
      inputSchema: {
        audience_id: z.string().describe("Custom audience ID to delete"),
      },
      annotations: { ...DELETE },
    },
    async ({ audience_id }) => {
      const id = validateMetaId(audience_id, "audience");
      await metaApiClient.delete<{ success: boolean }>(`/${id}`);

      return {
        content: [
          { type: "text", text: `Audience ${id} deleted successfully.` },
        ],
      };
    },
  );
}
