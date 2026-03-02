import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { metaApiClient } from "../meta/client.js";
import { normalizeAccountId } from "../utils/format.js";
import { buildFieldsParam } from "../utils/validation.js";
import { ADSET_DEFAULT_FIELDS } from "../meta/types/adset.js";
import type { AdSet, MetaApiResponse } from "../meta/types/index.js";

const statusEnum = z.enum(["ACTIVE", "PAUSED", "DELETED", "ARCHIVED"]);

const destinationTypeEnum = z.enum([
  "WEBSITE", "APP", "MESSENGER", "WHATSAPP", "INSTAGRAM_DIRECT",
  "ON_AD", "ON_PAGE", "ON_EVENT", "ON_VIDEO",
  "SHOP_AUTOMATIC", "FACEBOOK", "FACEBOOK_PAGE", "INSTAGRAM_PROFILE",
  "INSTAGRAM_PROFILE_AND_FACEBOOK_PAGE",
  "MESSAGING_INSTAGRAM_DIRECT_MESSENGER",
  "MESSAGING_INSTAGRAM_DIRECT_MESSENGER_WHATSAPP",
  "MESSAGING_INSTAGRAM_DIRECT_WHATSAPP",
  "MESSAGING_MESSENGER_WHATSAPP",
  "APPLINKS_AUTOMATIC",
]);

const optimizationGoalEnum = z.enum([
  "NONE", "APP_INSTALLS", "AD_RECALL_LIFT", "ENGAGED_USERS",
  "EVENT_RESPONSES", "IMPRESSIONS", "LEAD_GENERATION", "QUALITY_LEAD",
  "LINK_CLICKS", "OFFSITE_CONVERSIONS", "PAGE_LIKES", "POST_ENGAGEMENT",
  "QUALITY_CALL", "REACH", "LANDING_PAGE_VIEWS", "VISIT_INSTAGRAM_PROFILE",
  "VALUE", "THRUPLAY", "DERIVED_EVENTS", "APP_INSTALLS_AND_OFFSITE_CONVERSIONS",
  "CONVERSATIONS", "IN_APP_VALUE", "MESSAGING_PURCHASE_CONVERSION",
  "MESSAGING_APPOINTMENT_CONVERSION", "SUBSCRIBERS", "REMINDERS_SET",
]);

const billingEventEnum = z.enum(["IMPRESSIONS", "LINK_CLICKS", "POST_ENGAGEMENT", "THRUPLAY"]);

const bidStrategyEnum = z.enum([
  "LOWEST_COST_WITHOUT_CAP",
  "LOWEST_COST_WITH_BID_CAP",
  "COST_CAP",
  "LOWEST_COST_WITH_MIN_ROAS",
]);

const geoLocationSchema = z.object({
  countries: z.array(z.string()).optional(),
  regions: z.array(z.object({ key: z.string() })).optional(),
  cities: z
    .array(
      z.object({
        key: z.string(),
        radius: z.number().optional(),
        distance_unit: z.string().optional(),
      }),
    )
    .optional(),
  zips: z.array(z.object({ key: z.string() })).optional(),
  location_types: z.array(z.string()).optional(),
}).passthrough();

const idNameArray = z.array(z.object({ id: z.string(), name: z.string().optional() })).optional();

const targetingSchema = z
  .object({
    // Geographic targeting
    geo_locations: geoLocationSchema.optional(),
    excluded_geo_locations: geoLocationSchema.optional().describe("Locations to exclude from targeting"),

    // Demographics
    age_min: z.number().min(13).max(65).optional(),
    age_max: z.number().min(13).max(65).optional(),
    genders: z.array(z.number().min(0).max(2)).optional().describe("0=all, 1=male, 2=female"),
    locales: z.array(z.number()).optional().describe("Locale IDs for language targeting (e.g., 6=English, 24=Spanish)"),
    relationship_statuses: z.array(z.number()).optional().describe("1=single, 2=in_relationship, 3=married, 4=engaged, 6=unspecified"),

    // Interests & behaviors
    interests: idNameArray,
    behaviors: idNameArray,

    // Education & work
    education_statuses: z.array(z.number()).optional().describe("1=HIGH_SCHOOL, 2=UNDERGRAD, 3=ALUM, 7=IN_GRAD_SCHOOL, 9=MASTER_DEGREE, etc."),
    education_schools: idNameArray,
    education_majors: idNameArray,
    college_years: z.array(z.number()).optional(),
    work_employers: idNameArray,
    work_positions: idNameArray,

    // Life events, income, family, industries
    life_events: idNameArray,
    industries: idNameArray,
    income: idNameArray,
    family_statuses: idNameArray,
    user_adclusters: idNameArray.describe("Broad category targeting clusters"),

    // Custom audiences
    custom_audiences: z.array(z.object({ id: z.string() })).optional(),
    excluded_custom_audiences: z.array(z.object({ id: z.string() })).optional(),

    // Device targeting
    device_platforms: z.array(z.string()).optional().describe("mobile, desktop"),
    user_os: z.array(z.string()).optional().describe("OS targeting: iOS, Android, or versioned like iOS_ver_15.0_and_above"),
    user_device: z.array(z.string()).optional().describe("Target specific devices (e.g., Galaxy S24, iPhone 15)"),
    excluded_user_device: z.array(z.string()).optional(),
    wireless_carrier: z.array(z.string()).optional().describe("Carrier targeting (use 'Wifi' for wifi-only users)"),

    // Publisher platforms & placement positions
    publisher_platforms: z.array(z.string()).optional().describe("facebook, instagram, threads, messenger, audience_network"),
    facebook_positions: z.array(z.string()).optional().describe("feed, right_hand_column, marketplace, video_feeds, story, search, instream_video, facebook_reels, facebook_reels_overlay, profile_feed, notification"),
    instagram_positions: z.array(z.string()).optional().describe("stream, story, explore, explore_home, reels, profile_feed, ig_search, profile_reels"),
    threads_positions: z.array(z.string()).optional().describe("threads_stream (requires instagram stream)"),
    audience_network_positions: z.array(z.string()).optional().describe("classic, rewarded_video"),
    messenger_positions: z.array(z.string()).optional().describe("sponsored_messages, story"),
    whatsapp_positions: z.array(z.string()).optional().describe("status (requires instagram story)"),

    // Brand safety
    brand_safety_content_filter_levels: z.array(z.string()).optional().describe("FACEBOOK_RELAXED/STANDARD/STRICT, AN_RELAXED/STANDARD/STRICT, FEED_RELAXED/STANDARD/STRICT"),
    excluded_publisher_categories: z.array(z.string()).optional().describe("dating, gambling, debated_social_issues, mature_audiences, tragedy_and_conflict"),
    excluded_publisher_list_ids: z.array(z.string()).optional().describe("Block list IDs to exclude specific publishers"),

    // Flexible targeting (AND/OR logic)
    flexible_spec: z.array(z.record(z.unknown())).optional().describe("Array of targeting groups combined with AND; items within each group use OR"),
    exclusions: z.record(z.unknown()).optional(),

    // Advantage+ audience automation
    targeting_automation: z.object({
      advantage_audience: z.number().optional().describe("1 to enable Advantage+ audience"),
    }).passthrough().optional().describe("Advantage+ audience automation settings"),
  })
  .passthrough()
  .describe("Targeting specification for the ad set");

export function registerAdSetTools(server: McpServer): void {
  // ─── Get Ad Sets ─────────────────────────────────────────────
  server.tool(
    "meta_ads_get_adsets",
    "Get ad sets for an ad account. Optionally filter by campaign or status.",
    {
      account_id: z.string().describe("Ad account ID"),
      limit: z.number().min(1).max(100).default(25),
      campaign_id: z.string().optional().describe("Filter by campaign ID"),
      status_filter: z.array(statusEnum).optional(),
    },
    async ({ account_id, limit, campaign_id, status_filter }) => {
      const path = campaign_id
        ? `/${campaign_id}/adsets`
        : `/${normalizeAccountId(account_id)}/adsets`;

      const fieldsParam = buildFieldsParam(undefined, [...ADSET_DEFAULT_FIELDS]);
      const params: Record<string, string | number | boolean> = {
        fields: fieldsParam,
        limit,
      };

      if (status_filter && status_filter.length > 0) {
        params.filtering = JSON.stringify([
          { field: "effective_status", operator: "IN", value: status_filter },
        ]);
      }

      const response = await metaApiClient.get<MetaApiResponse<AdSet>>(path, params);
      const adsets = response.data ?? [];

      const text =
        adsets.length === 0
          ? "No ad sets found."
          : adsets
              .map(
                (a) =>
                  `• ${a.name} (${a.id}) — ${a.status} — Goal: ${a.optimization_goal} — Budget: ${a.daily_budget ? `${a.daily_budget}/day` : a.lifetime_budget ? `${a.lifetime_budget} lifetime` : "N/A"}`,
              )
              .join("\n");

      return {
        content: [
          { type: "text", text: `Found ${adsets.length} ad set(s):\n\n${text}` },
          { type: "text", text: JSON.stringify(adsets, null, 2) },
        ],
      };
    },
  );

  // ─── Get Ad Set Details ──────────────────────────────────────
  server.tool(
    "meta_ads_get_adset_details",
    "Get detailed information about a specific ad set including targeting, budget, and optimization settings.",
    {
      adset_id: z.string().describe("Ad set ID"),
      fields: z.array(z.string()).optional(),
    },
    async ({ adset_id, fields }) => {
      const fieldsParam = buildFieldsParam(fields, [...ADSET_DEFAULT_FIELDS, "frequency_control_specs", "promoted_object", "destination_type"]);
      const adset = await metaApiClient.get<AdSet>(`/${adset_id}`, { fields: fieldsParam });

      return {
        content: [
          {
            type: "text",
            text: `Ad Set: ${adset.name}\nID: ${adset.id}\nCampaign: ${adset.campaign_id}\nStatus: ${adset.status} (effective: ${adset.effective_status})\nOptimization: ${adset.optimization_goal}\nBilling: ${adset.billing_event}\nBid: ${adset.bid_amount ?? "Auto"}\nDaily Budget: ${adset.daily_budget ?? "N/A"}\nLifetime Budget: ${adset.lifetime_budget ?? "N/A"}\nTargeting: ${JSON.stringify(adset.targeting, null, 2)}`,
          },
          { type: "text", text: JSON.stringify(adset, null, 2) },
        ],
      };
    },
  );

  // ─── Create Ad Set ───────────────────────────────────────────
  server.tool(
    "meta_ads_create_adset",
    "Create a new ad set within a campaign. Requires targeting specification, optimization goal, budget, and destination_type (required for ODAX campaigns). Common destination_type values: WEBSITE (traffic/sales to website), APP (app installs), MESSENGER/WHATSAPP/INSTAGRAM_DIRECT (messaging), ON_AD (lead forms, instant experiences). Ad sets are created in PAUSED status by default.",
    {
      account_id: z.string().describe("Ad account ID"),
      campaign_id: z.string().describe("Parent campaign ID"),
      name: z.string().min(1).describe("Ad set name"),
      destination_type: destinationTypeEnum.describe("Where the ad traffic is directed. Required for ODAX campaigns. Common values: WEBSITE (website traffic/conversions), APP (app installs), MESSENGER (Messenger conversations), WHATSAPP (WhatsApp conversations), INSTAGRAM_DIRECT (Instagram DMs), ON_AD (lead forms, instant experiences, post engagement), ON_VIDEO (video views), ON_PAGE (page engagement), SHOP_AUTOMATIC (shop)"),
      status: z.enum(["ACTIVE", "PAUSED"]).default("PAUSED"),
      daily_budget: z.number().optional().describe("Daily budget in cents (e.g., 2000 = $20.00)"),
      lifetime_budget: z.number().optional().describe("Lifetime budget in cents"),
      optimization_goal: optimizationGoalEnum.describe("Optimization goal"),
      billing_event: billingEventEnum.default("IMPRESSIONS"),
      bid_amount: z.number().optional().describe("Bid cap in cents"),
      bid_strategy: bidStrategyEnum.optional(),
      targeting: targetingSchema,
      start_time: z.string().optional().describe("ISO 8601 start time"),
      end_time: z.string().optional().describe("ISO 8601 end time (required for lifetime_budget)"),
      promoted_object: z.record(z.unknown()).optional().describe("Promoted object (e.g., { page_id: '123' } or { pixel_id: '456', custom_event_type: 'PURCHASE' })"),
    },
    async ({
      account_id, campaign_id, name, destination_type, status, daily_budget, lifetime_budget,
      optimization_goal, billing_event, bid_amount, bid_strategy, targeting,
      start_time, end_time, promoted_object,
    }) => {
      const id = normalizeAccountId(account_id);

      const body: Record<string, string | number | boolean> = {
        campaign_id,
        name,
        destination_type,
        status,
        optimization_goal,
        billing_event,
        targeting: JSON.stringify(targeting),
      };

      if (daily_budget !== undefined) body.daily_budget = String(daily_budget);
      if (lifetime_budget !== undefined) body.lifetime_budget = String(lifetime_budget);
      if (bid_amount !== undefined) body.bid_amount = String(bid_amount);
      if (bid_strategy) body.bid_strategy = bid_strategy;
      if (start_time) body.start_time = start_time;
      if (end_time) body.end_time = end_time;
      if (promoted_object) body.promoted_object = JSON.stringify(promoted_object);

      const result = await metaApiClient.postForm<{ id: string }>(`/${id}/adsets`, body);

      return {
        content: [
          {
            type: "text",
            text: `Ad set created successfully!\nID: ${result.id}\nName: ${name}\nCampaign: ${campaign_id}\nStatus: ${status}\nOptimization: ${optimization_goal}`,
          },
        ],
      };
    },
  );

  // ─── Update Ad Set ───────────────────────────────────────────
  server.tool(
    "meta_ads_update_adset",
    "Update an existing ad set's name, status, budget, targeting, destination_type, or bid settings.",
    {
      adset_id: z.string().describe("Ad set ID to update"),
      name: z.string().optional(),
      status: statusEnum.optional(),
      destination_type: destinationTypeEnum.optional().describe("Where the ad traffic is directed (e.g., WEBSITE, APP, MESSENGER, ON_AD)"),
      daily_budget: z.number().optional().describe("Daily budget in cents"),
      lifetime_budget: z.number().optional(),
      targeting: targetingSchema.optional(),
      bid_amount: z.number().optional().describe("Bid cap in cents"),
      bid_strategy: bidStrategyEnum.optional(),
      end_time: z.string().optional(),
    },
    async ({ adset_id, name, status, destination_type, daily_budget, lifetime_budget, targeting, bid_amount, bid_strategy, end_time }) => {
      const body: Record<string, string | number | boolean> = {};
      if (name !== undefined) body.name = name;
      if (status !== undefined) body.status = status;
      if (destination_type !== undefined) body.destination_type = destination_type;
      if (daily_budget !== undefined) body.daily_budget = String(daily_budget);
      if (lifetime_budget !== undefined) body.lifetime_budget = String(lifetime_budget);
      if (targeting !== undefined) body.targeting = JSON.stringify(targeting);
      if (bid_amount !== undefined) body.bid_amount = String(bid_amount);
      if (bid_strategy !== undefined) body.bid_strategy = bid_strategy;
      if (end_time !== undefined) body.end_time = end_time;

      await metaApiClient.postForm<{ success: boolean }>(`/${adset_id}`, body);

      return {
        content: [
          { type: "text", text: `Ad set ${adset_id} updated successfully.\nChanges: ${JSON.stringify(body)}` },
        ],
      };
    },
  );

  // ─── Delete Ad Set ───────────────────────────────────────────
  server.tool(
    "meta_ads_delete_adset",
    "Delete an ad set (soft delete — sets status to DELETED).",
    {
      adset_id: z.string().describe("Ad set ID to delete"),
    },
    async ({ adset_id }) => {
      await metaApiClient.postForm<{ success: boolean }>(`/${adset_id}`, {
        status: "DELETED",
      });

      return {
        content: [
          { type: "text", text: `Ad set ${adset_id} has been deleted (status set to DELETED).` },
        ],
      };
    },
  );
}
