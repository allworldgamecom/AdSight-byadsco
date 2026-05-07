import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { metaApiClient } from "../meta/client.js";
import { normalizeAccountId, validateMetaId } from "../utils/format.js";
import { buildFieldsParam } from "../utils/validation.js";
import {
  PIXEL_DEFAULT_FIELDS,
  CUSTOM_CONVERSION_DEFAULT_FIELDS,
} from "../meta/types/pixel.js";
import type {
  AdsPixel,
  CustomConversion,
  MetaApiResponse,
} from "../meta/types/index.js";
import { READ, CREATE, WRITE_WARNING } from "./_register.js";

export function registerPixelTools(server: McpServer): void {
  // ─── Get Pixels ───────────────────────────────────────────────
  server.registerTool(
    "ads_get_pixels",
    {
      description: "List pixels for an ad account. Returns pixel IDs, names, and last fire times.",
      inputSchema: {
        account_id: z.string().describe("Ad account ID"),
        fields: z.array(z.string()).optional(),
      },
      annotations: { ...READ },
    },
    async ({ account_id, fields }) => {
      const id = normalizeAccountId(account_id);
      const fieldsParam = buildFieldsParam(fields, [...PIXEL_DEFAULT_FIELDS]);

      const response = await metaApiClient.get<MetaApiResponse<AdsPixel>>(
        `/${id}/adspixels`,
        { fields: fieldsParam },
      );
      const pixels = response.data ?? [];

      const text =
        pixels.length === 0
          ? "No pixels found."
          : pixels
              .map(
                (p) =>
                  `• ${p.name} (${p.id}) — Last fired: ${p.last_fired_time ?? "Never"}`,
              )
              .join("\n");

      return {
        content: [
          { type: "text", text: `Found ${pixels.length} pixel(s):\n\n${text}` },
          { type: "text", text: JSON.stringify(pixels, null, 2) },
        ],
      };
    },
  );

  // ─── Get Pixel Details ────────────────────────────────────────
  server.registerTool(
    "ads_get_pixel_details",
    {
      description:
        "Get detailed information about a specific pixel including its installation code snippet.",
      inputSchema: {
        pixel_id: z.string().describe("Pixel ID"),
        fields: z.array(z.string()).optional(),
      },
      annotations: { ...READ },
    },
    async ({ pixel_id, fields }) => {
      const id = validateMetaId(pixel_id, "pixel");
      const fieldsParam = buildFieldsParam(fields, [...PIXEL_DEFAULT_FIELDS]);

      const pixel = await metaApiClient.get<AdsPixel>(
        `/${id}`,
        { fields: fieldsParam },
      );

      const lines: string[] = [
        `Pixel: ${pixel.name} (${pixel.id})`,
        `Last fired: ${pixel.last_fired_time ?? "Never"}`,
        `Created: ${pixel.creation_time ?? "N/A"}`,
      ];

      if (pixel.code) {
        lines.push(`\nInstallation code available (included in JSON below).`);
      }

      return {
        content: [
          { type: "text", text: lines.join("\n") },
          { type: "text", text: JSON.stringify(pixel, null, 2) },
        ],
      };
    },
  );

  // ─── Get Pixel Events / Stats ─────────────────────────────────
  server.registerTool(
    "ads_get_pixel_events",
    {
      description:
        "Get event statistics for a pixel. Useful for debugging tracking issues — shows which events are being received and their counts.",
      inputSchema: {
        pixel_id: z.string().describe("Pixel ID"),
        aggregation: z
          .enum(["event", "device", "url", "custom_data_field"])
          .default("event")
          .describe("How to aggregate stats"),
        start_time: z.string().optional().describe("Start time (ISO 8601 or Unix timestamp)"),
        end_time: z.string().optional().describe("End time (ISO 8601 or Unix timestamp)"),
      },
      annotations: { ...READ },
    },
    async ({ pixel_id, aggregation, start_time, end_time }) => {
      const id = validateMetaId(pixel_id, "pixel");
      const params: Record<string, string | number | boolean> = {
        aggregation,
      };
      if (start_time) params.start_time = start_time;
      if (end_time) params.end_time = end_time;

      const response = await metaApiClient.get<{ data: Array<{ event: string; count: number; value?: number }> }>(
        `/${id}/stats`,
        params,
      );
      const stats = response.data ?? [];

      if (stats.length === 0) {
        return {
          content: [{ type: "text", text: `No event data for pixel ${id} in the specified period.` }],
        };
      }

      const text = stats
        .map(
          (s) =>
            `• ${s.event}: ${s.count} events${s.value ? ` (value: ${s.value})` : ""}`,
        )
        .join("\n");

      return {
        content: [
          { type: "text", text: `Pixel Events (${aggregation}):\n\n${text}` },
          { type: "text", text: JSON.stringify(stats, null, 2) },
        ],
      };
    },
  );

  // ─── Get Custom Conversions ───────────────────────────────────
  server.registerTool(
    "ads_get_custom_conversions",
    {
      description: "List custom conversions for an ad account.",
      inputSchema: {
        account_id: z.string().describe("Ad account ID"),
        limit: z.number().min(1).max(100).default(25),
        fields: z.array(z.string()).optional(),
      },
      annotations: { ...READ },
    },
    async ({ account_id, limit, fields }) => {
      const id = normalizeAccountId(account_id);
      const fieldsParam = buildFieldsParam(fields, [...CUSTOM_CONVERSION_DEFAULT_FIELDS]);

      const response = await metaApiClient.get<MetaApiResponse<CustomConversion>>(
        `/${id}/customconversions`,
        { fields: fieldsParam, limit },
      );
      const conversions = response.data ?? [];

      const text =
        conversions.length === 0
          ? "No custom conversions found."
          : conversions
              .map(
                (c) =>
                  `• ${c.name} (${c.id}) — Event: ${c.custom_event_type ?? "N/A"} — Value: ${c.default_conversion_value ?? "N/A"}`,
              )
              .join("\n");

      return {
        content: [
          { type: "text", text: `Found ${conversions.length} custom conversion(s):\n\n${text}` },
          { type: "text", text: JSON.stringify(conversions, null, 2) },
        ],
      };
    },
  );

  // ─── Create Custom Conversion ─────────────────────────────────
  server.registerTool(
    "ads_create_custom_conversion",
    {
      description: `${WRITE_WARNING}Create a custom conversion for an ad account. Define rules based on URL or pixel events.`,
      inputSchema: {
        account_id: z.string().describe("Ad account ID"),
        name: z.string().min(1).describe("Custom conversion name"),
        description: z.string().optional(),
        pixel_id: z.string().describe("Pixel ID to associate with"),
        event_source_type: z
          .enum(["WEB", "APP", "MOBILE"])
          .default("WEB")
          .describe("Event source type"),
        custom_event_type: z
          .enum([
            "ADD_PAYMENT_INFO", "ADD_TO_CART", "ADD_TO_WISHLIST", "COMPLETE_REGISTRATION",
            "CONTENT_VIEW", "INITIATED_CHECKOUT", "LEAD", "PURCHASE", "SEARCH",
            "OTHER",
          ])
          .describe("Standard event type to track"),
        rule: z.string().describe("Conversion rule (JSON string, e.g., URL contains, event parameters)"),
        default_conversion_value: z.number().optional().describe("Default monetary value"),
      },
      annotations: { ...CREATE },
    },
    async ({ account_id, name, description, pixel_id, event_source_type, custom_event_type, rule, default_conversion_value }) => {
      const accountPath = normalizeAccountId(account_id);
      const pixelIdValidated = validateMetaId(pixel_id, "pixel");

      const body: Record<string, string | number | boolean> = {
        name,
        pixel_id: pixelIdValidated,
        event_source_type,
        custom_event_type,
        rule,
      };

      if (description) body.description = description;
      if (default_conversion_value !== undefined) body.default_conversion_value = default_conversion_value;

      const result = await metaApiClient.postForm<{ id: string }>(
        `/${accountPath}/customconversions`,
        body,
      );

      return {
        content: [
          {
            type: "text",
            text: `Custom conversion created!\nID: ${result.id}\nName: ${name}\nEvent: ${custom_event_type}\nPixel: ${pixelIdValidated}`,
          },
        ],
      };
    },
  );
}
