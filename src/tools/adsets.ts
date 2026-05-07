import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { metaApiClient } from "../meta/client.js";
import { normalizeAccountId, validateMetaId } from "../utils/format.js";
import { buildFieldsParam } from "../utils/validation.js";
import { ADSET_DEFAULT_FIELDS } from "../meta/types/adset.js";
import { AD_DEFAULT_FIELDS } from "../meta/types/ad.js";
import { CREATIVE_DEFAULT_FIELDS } from "../meta/types/creative.js";
import type { Ad, AdCreative, AdSet, GeoLocation, MetaApiResponse, TargetingSpec } from "../meta/types/index.js";
import { READ, CREATE, UPDATE, DELETE, WRITE_WARNING } from "./_register.js";

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
    geo_locations: geoLocationSchema.optional(),
    excluded_geo_locations: geoLocationSchema.optional().describe("Locations to exclude from targeting"),

    age_min: z.number().min(13).max(65).optional(),
    age_max: z.number().min(13).max(65).optional(),
    genders: z.array(z.number().min(0).max(2)).optional().describe("0=all, 1=male, 2=female"),
    locales: z.array(z.number()).optional().describe("Locale IDs for language targeting (e.g., 6=English, 24=Spanish)"),
    relationship_statuses: z.array(z.number()).optional().describe("1=single, 2=in_relationship, 3=married, 4=engaged, 6=unspecified"),

    interests: idNameArray,
    behaviors: idNameArray,

    education_statuses: z.array(z.number()).optional().describe("1=HIGH_SCHOOL, 2=UNDERGRAD, 3=ALUM, 7=IN_GRAD_SCHOOL, 9=MASTER_DEGREE, etc."),
    education_schools: idNameArray,
    education_majors: idNameArray,
    college_years: z.array(z.number()).optional(),
    work_employers: idNameArray,
    work_positions: idNameArray,

    life_events: idNameArray,
    industries: idNameArray,
    income: idNameArray,
    family_statuses: idNameArray,
    user_adclusters: idNameArray.describe("Broad category targeting clusters"),

    custom_audiences: z.array(z.object({ id: z.string() })).optional(),
    excluded_custom_audiences: z.array(z.object({ id: z.string() })).optional(),

    device_platforms: z.array(z.string()).optional().describe("mobile, desktop"),
    user_os: z.array(z.string()).optional().describe("OS targeting: iOS, Android, or versioned like iOS_ver_15.0_and_above"),
    user_device: z.array(z.string()).optional().describe("Target specific devices (e.g., Galaxy S24, iPhone 15)"),
    excluded_user_device: z.array(z.string()).optional(),
    wireless_carrier: z.array(z.string()).optional().describe("Carrier targeting (use 'Wifi' for wifi-only users)"),

    publisher_platforms: z.array(z.string()).optional().describe("facebook, instagram, threads, messenger, audience_network"),
    facebook_positions: z.array(z.string()).optional().describe("feed, right_hand_column, marketplace, video_feeds, story, search, instream_video, facebook_reels, facebook_reels_overlay, profile_feed, notification"),
    instagram_positions: z.array(z.string()).optional().describe("stream, story, explore, explore_home, reels, profile_feed, ig_search, profile_reels"),
    threads_positions: z.array(z.string()).optional().describe("threads_stream (requires instagram stream)"),
    audience_network_positions: z.array(z.string()).optional().describe("classic, rewarded_video"),
    messenger_positions: z.array(z.string()).optional().describe("sponsored_messages, story"),
    whatsapp_positions: z.array(z.string()).optional().describe("status (requires instagram story)"),

    brand_safety_content_filter_levels: z.array(z.string()).optional().describe("FACEBOOK_RELAXED/STANDARD/STRICT, AN_RELAXED/STANDARD/STRICT, FEED_RELAXED/STANDARD/STRICT"),
    excluded_publisher_categories: z.array(z.string()).optional().describe("dating, gambling, debated_social_issues, mature_audiences, tragedy_and_conflict"),
    excluded_publisher_list_ids: z.array(z.string()).optional().describe("Block list IDs to exclude specific publishers"),

    flexible_spec: z.array(z.record(z.unknown())).optional().describe("Array of targeting groups combined with AND; items within each group use OR"),
    exclusions: z.record(z.unknown()).optional(),

    targeting_automation: z.object({
      advantage_audience: z.number().optional().describe("1 to enable Advantage+ audience"),
    }).passthrough().optional().describe("Advantage+ audience automation settings"),
  })
  .passthrough()
  .describe("Targeting specification for the ad set");

const adSetIdentityFields = ["id", "name", "campaign_id", "status", "effective_status"] as const;

const cloneTargetAdSetSchema = z.object({
  name: z.string().min(1).describe("Name for the cloned ad set"),
  geo_override: geoLocationSchema.describe("Geo override applied on top of the source targeting (for example, { countries: ['CL'] })"),
  status: z.enum(["ACTIVE", "PAUSED"]).default("PAUSED").describe("Status for the cloned ad set and ads. Defaults to PAUSED."),
  daily_budget: z.number().optional().describe("Optional daily budget override in cents"),
  lifetime_budget: z.number().optional().describe("Optional lifetime budget override in cents"),
  destination_type: destinationTypeEnum.optional().describe("Optional destination_type override"),
  promoted_object: z.record(z.unknown()).optional().describe("Optional promoted_object override"),
});

const creativeOverrideSchema = z.object({
  source_ad_id: z.string().optional().describe("Source ad ID to override"),
  source_creative_id: z.string().optional().describe("Source creative ID to override"),
  name: z.string().optional().describe("Name for the cloned creative"),
  headline: z.string().optional().describe("Headline/title override"),
  message: z.string().optional().describe("Primary text override"),
  description: z.string().optional().describe("Description override"),
  link_url: z.string().optional().describe("Optional destination URL override"),
  call_to_action_type: z.string().optional().describe("Optional CTA override"),
}).refine(
  (value) => Boolean(value.source_ad_id || value.source_creative_id),
  "Each creative override must include source_ad_id or source_creative_id.",
);

interface CreativeOverrideInput {
  source_ad_id?: string;
  source_creative_id?: string;
  name?: string;
  headline?: string;
  message?: string;
  description?: string;
  link_url?: string;
  call_to_action_type?: string;
}

interface CloneAdSetBundleResource {
  id?: string;
  name: string;
  status?: string;
  campaign_id?: string;
  ad_set_id?: string;
  creative_id?: string;
  source_ad_id?: string;
  source_creative_id?: string;
  planned?: boolean;
}

interface CloneAdSetBundleSkip {
  source_ad_id?: string;
  source_creative_id?: string;
  name?: string;
  reason: string;
}

interface CloneAdSetBundleResult {
  dry_run: boolean;
  idempotency_key?: string;
  new_ad_set: CloneAdSetBundleResource;
  created_creatives: CloneAdSetBundleResource[];
  created_ads: CloneAdSetBundleResource[];
  skipped: CloneAdSetBundleSkip[];
  warnings: string[];
}

interface CachedCloneBundleOperation {
  signature: string;
  result: CloneAdSetBundleResult;
}

interface ResolvedCloneCreativeInput {
  name: string;
  page_id: string;
  instagram_actor_id?: string;
  image_hash?: string;
  image_url?: string;
  video_id?: string;
  link_url?: string;
  message?: string;
  headline?: string;
  description?: string;
  call_to_action_type?: string;
}

const cloneAdSetBundleCache = new Map<string, CachedCloneBundleOperation>();

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : undefined;
}

function getString(record: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function getNestedString(record: Record<string, unknown> | undefined, path: string[]): string | undefined {
  let current: unknown = record;
  for (const key of path) {
    if (typeof current !== "object" || current === null || !(key in current)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[key];
  }

  return typeof current === "string" && current.length > 0 ? current : undefined;
}

function extractEffectiveCreativeLinkUrl(creative: AdCreative): string | undefined {
  if (creative.link_url) return creative.link_url;

  const objectStorySpec = asRecord(creative.object_story_spec);
  const videoData = asRecord(objectStorySpec?.["video_data"]);
  const linkData = asRecord(objectStorySpec?.["link_data"]);
  const assetFeedSpec = asRecord(creative.asset_feed_spec);

  return (
    getNestedString(videoData, ["call_to_action", "value", "link"])
    ?? getString(linkData, "link")
    ?? getNestedString(linkData, ["call_to_action", "value", "link"])
    ?? getNestedString(assetFeedSpec, ["link_urls", "0", "website_url"])
  );
}

function buildAdSetDetailsFields(fields?: string[]): string {
  const requested =
    fields && fields.length > 0
      ? [...new Set([...adSetIdentityFields, ...fields])]
      : [...ADSET_DEFAULT_FIELDS, "frequency_control_specs", "promoted_object", "destination_type"];

  return buildFieldsParam(requested, requested);
}

function applyGeoOverride(targeting: TargetingSpec | undefined, geoOverride: GeoLocation): TargetingSpec {
  const nextTargeting = structuredClone(targeting ?? {}) as TargetingSpec;
  nextTargeting.geo_locations = {
    ...(nextTargeting.geo_locations ?? {}),
    ...geoOverride,
  };
  return nextTargeting;
}

function deriveClonedName(sourceName: string, sourcePrefix: string, targetPrefix: string): string {
  if (sourceName.startsWith(sourcePrefix)) {
    return `${targetPrefix}${sourceName.slice(sourcePrefix.length)}`;
  }

  return sourceName;
}

function findCreativeOverride(
  overrides: readonly CreativeOverrideInput[],
  sourceAdId: string,
  sourceCreativeId?: string,
): CreativeOverrideInput | undefined {
  return overrides.find((override) =>
    override.source_ad_id === sourceAdId
    || (sourceCreativeId && override.source_creative_id === sourceCreativeId),
  );
}

function resolveCreativeCloneInput(
  sourceCreative: AdCreative,
  sourceAd: Ad,
  sourceAdSetName: string,
  targetAdSetName: string,
  override: CreativeOverrideInput | undefined,
  reuseSourceMedia: boolean,
): { input?: ResolvedCloneCreativeInput; reason?: string } {
  if (!reuseSourceMedia) {
    return { reason: "reuse_source_media=false todavía no está soportado para clonado automático." };
  }

  const objectStorySpec = asRecord(sourceCreative.object_story_spec);
  const videoData = asRecord(objectStorySpec?.["video_data"]);
  const linkData = asRecord(objectStorySpec?.["link_data"]);
  const pageId = getString(objectStorySpec, "page_id");
  const instagramActorId = getString(objectStorySpec, "instagram_actor_id");
  const effectiveLinkUrl = override?.link_url ?? extractEffectiveCreativeLinkUrl(sourceCreative);
  const defaultName =
    override?.name
    ?? deriveClonedName(sourceAd.name, sourceAdSetName, targetAdSetName);

  if (!pageId) {
    return { reason: "El creative fuente no tiene page_id en object_story_spec." };
  }

  if (videoData) {
    const videoId = getString(videoData, "video_id");
    const imageHash = getString(videoData, "image_hash") ?? sourceCreative.image_hash;
    const imageUrl = getString(videoData, "image_url") ?? sourceCreative.thumbnail_url ?? sourceCreative.image_url;

    if (!videoId) {
      return { reason: "El creative de video fuente no incluye video_id." };
    }

    if (!imageHash && !imageUrl) {
      return { reason: "El creative de video fuente no incluye thumbnail reusable (image_hash o image_url)." };
    }

    return {
      input: {
        name: defaultName,
        page_id: pageId,
        instagram_actor_id: instagramActorId,
        video_id: videoId,
        image_hash: imageHash,
        image_url: imageHash ? undefined : imageUrl,
        link_url: effectiveLinkUrl,
        message: override?.message ?? getString(videoData, "message") ?? sourceCreative.body,
        headline: override?.headline ?? getString(videoData, "title") ?? sourceCreative.title,
        description: override?.description ?? getString(videoData, "link_description"),
        call_to_action_type:
          override?.call_to_action_type
          ?? getNestedString(videoData, ["call_to_action", "type"])
          ?? sourceCreative.call_to_action_type,
      },
    };
  }

  if (linkData) {
    return {
      input: {
        name: defaultName,
        page_id: pageId,
        instagram_actor_id: instagramActorId,
        image_hash: getString(linkData, "image_hash") ?? sourceCreative.image_hash,
        image_url: getString(linkData, "picture") ?? sourceCreative.image_url,
        link_url: effectiveLinkUrl,
        message: override?.message ?? getString(linkData, "message") ?? sourceCreative.body,
        headline: override?.headline ?? getString(linkData, "name") ?? sourceCreative.title,
        description: override?.description ?? getString(linkData, "description"),
        call_to_action_type:
          override?.call_to_action_type
          ?? getNestedString(linkData, ["call_to_action", "type"])
          ?? sourceCreative.call_to_action_type,
      },
    };
  }

  if (sourceCreative.asset_feed_spec) {
    return { reason: "El creative fuente usa asset_feed_spec y esa variante aún no está soportada por ads_clone_ad_set_bundle." };
  }

  return { reason: "No se pudo resolver una estructura clonable de object_story_spec en el creative fuente." };
}

export function registerAdSetTools(server: McpServer): void {
  // ─── Get Ad Sets ─────────────────────────────────────────────
  server.registerTool(
    "ads_get_ad_sets",
    {
      description: "Get ad sets for an ad account. Optionally filter by campaign or status.",
      inputSchema: {
        account_id: z.string().describe("Ad account ID"),
        limit: z.number().min(1).max(100).default(25),
        campaign_id: z.string().optional().describe("Filter by campaign ID"),
        status_filter: z.array(statusEnum).optional(),
      },
      annotations: { ...READ },
    },
    async ({ account_id, limit, campaign_id, status_filter }) => {
      const path = campaign_id
        ? `/${validateMetaId(campaign_id, "campaign")}/adsets`
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
      const adSets = response.data ?? [];

      const text =
        adSets.length === 0
          ? "No ad sets found."
          : adSets
              .map(
                (a) =>
                  `• ${a.name} (${a.id}) — ${a.status} — Goal: ${a.optimization_goal} — Budget: ${a.daily_budget ? `${a.daily_budget}/day` : a.lifetime_budget ? `${a.lifetime_budget} lifetime` : "N/A"}`,
              )
              .join("\n");

      return {
        content: [
          { type: "text", text: `Found ${adSets.length} ad set(s):\n\n${text}` },
          { type: "text", text: JSON.stringify(adSets, null, 2) },
        ],
      };
    },
  );

  // ─── Get Ad Set Details ──────────────────────────────────────
  server.registerTool(
    "ads_get_ad_set_details",
    {
      description:
        "Get detailed information about a specific ad set including targeting, budget, and optimization settings.",
      inputSchema: {
        ad_set_id: z.string().describe("Ad set ID"),
        fields: z.array(z.string()).optional(),
      },
      annotations: { ...READ },
    },
    async ({ ad_set_id, fields }) => {
      const id = validateMetaId(ad_set_id, "adset");
      const fieldsParam = buildAdSetDetailsFields(fields);
      const adSet = await metaApiClient.get<AdSet>(`/${id}`, { fields: fieldsParam });
      const targetingSummary = adSet.targeting ? JSON.stringify(adSet.targeting, null, 2) : "N/A";

      return {
        content: [
          {
            type: "text",
            text: `Ad Set: ${adSet.name ?? "N/A"}\nID: ${adSet.id ?? "N/A"}\nCampaign: ${adSet.campaign_id ?? "N/A"}\nStatus: ${adSet.status ?? "N/A"} (effective: ${adSet.effective_status ?? "N/A"})\nOptimization: ${adSet.optimization_goal ?? "N/A"}\nBilling: ${adSet.billing_event ?? "N/A"}\nBid: ${adSet.bid_amount ?? "Auto"}\nDaily Budget: ${adSet.daily_budget ?? "N/A"}\nLifetime Budget: ${adSet.lifetime_budget ?? "N/A"}\nTargeting: ${targetingSummary}`,
          },
          { type: "text", text: JSON.stringify(adSet, null, 2) },
        ],
      };
    },
  );

  // ─── Clone Ad Set Bundle ────────────────────────────────────
  server.registerTool(
    "ads_clone_ad_set_bundle",
    {
      description: `${WRITE_WARNING}Clone an ad set bundle in one operation: reads a source ad set, clones its targeting/budget setup into a new ad set, recreates its ads with reused source media, and applies explicit creative copy overrides. Designed for workflows like duplicating a GEO-specific ad set to another country while keeping every new resource PAUSED by default. Supports dry_run planning and idempotency_key-based retry safety.`,
      inputSchema: {
        account_id: z.string().describe("Ad account ID"),
        source_ad_set_id: z.string().describe("Source ad set ID to clone"),
        target_ad_set: cloneTargetAdSetSchema.describe("Configuration for the cloned ad set"),
        creative_overrides: z.array(creativeOverrideSchema).default([]).describe("Optional creative overrides keyed by source_ad_id or source_creative_id"),
        reuse_source_media: z.boolean().default(true).describe("Reuse source image/video assets when cloning creatives"),
        dry_run: z.boolean().default(false).describe("Plan the operation without creating any resources"),
        idempotency_key: z.string().optional().describe("Required for real execution. Reusing the same key returns the prior result instead of duplicating resources."),
      },
      annotations: { ...CREATE },
    },
    async ({ account_id, source_ad_set_id, target_ad_set, creative_overrides, reuse_source_media, dry_run, idempotency_key }) => {
      if (!dry_run && !idempotency_key) {
        throw new Error("idempotency_key is required when dry_run is false.");
      }

      const accountPath = normalizeAccountId(account_id);
      const sourceAdSetIdValidated = validateMetaId(source_ad_set_id, "adset");

      const requestSignature = JSON.stringify({
        account_id: accountPath,
        source_ad_set_id: sourceAdSetIdValidated,
        target_ad_set,
        creative_overrides,
        reuse_source_media,
      });
      const cacheKey = idempotency_key
        ? `${idempotency_key}:${accountPath}:${sourceAdSetIdValidated}:${target_ad_set.name}`
        : undefined;

      if (cacheKey) {
        const cached = cloneAdSetBundleCache.get(cacheKey);
        if (cached) {
          if (cached.signature !== requestSignature) {
            throw new Error("idempotency_key already exists for a different ads_clone_ad_set_bundle payload.");
          }

          return {
            content: [
              { type: "text", text: `ads_clone_ad_set_bundle reused cached result for key ${idempotency_key}.` },
              { type: "text", text: JSON.stringify(cached.result, null, 2) },
            ],
          };
        }
      }

      const sourceAdSetFields = buildAdSetDetailsFields(undefined);
      const sourceAdSet = await metaApiClient.get<AdSet>(`/${sourceAdSetIdValidated}`, {
        fields: sourceAdSetFields,
      });

      if (!sourceAdSet.optimization_goal || !sourceAdSet.billing_event) {
        throw new Error("Source ad set is missing optimization_goal or billing_event and cannot be cloned safely.");
      }

      if (
        target_ad_set.daily_budget === undefined
        && target_ad_set.lifetime_budget === undefined
        && sourceAdSet.daily_budget === undefined
        && sourceAdSet.lifetime_budget === undefined
      ) {
        throw new Error("Source ad set has no ad-set-level budget. Provide target_ad_set.daily_budget or target_ad_set.lifetime_budget.");
      }

      const adsFieldsParam = buildFieldsParam(undefined, [...AD_DEFAULT_FIELDS, "tracking_specs"]);
      const sourceAds = await metaApiClient.getPaginated<Ad>(
        `/${sourceAdSetIdValidated}/ads`,
        { fields: adsFieldsParam, limit: 100 },
        500,
      );

      const warnings: string[] = [];
      const skipped: CloneAdSetBundleSkip[] = [];
      const plannedCreatives: CloneAdSetBundleResource[] = [];
      const plannedAds: CloneAdSetBundleResource[] = [];

      const clonedTargeting = applyGeoOverride(sourceAdSet.targeting, target_ad_set.geo_override);
      const targetStatus = target_ad_set.status ?? "PAUSED";

      const resolvedCreativePlans: Array<{
        sourceAd: Ad;
        sourceCreativeId: string;
        input: ResolvedCloneCreativeInput;
      }> = [];

      for (const sourceAd of sourceAds) {
        const sourceCreativeId = sourceAd.creative?.id;
        if (!sourceCreativeId) {
          skipped.push({
            source_ad_id: sourceAd.id,
            name: sourceAd.name,
            reason: "Source ad has no creative.id.",
          });
          continue;
        }

        const sourceCreative = await metaApiClient.get<AdCreative>(`/${sourceCreativeId}`, {
          fields: buildFieldsParam(undefined, [...CREATIVE_DEFAULT_FIELDS]),
        });

        const override = findCreativeOverride(creative_overrides, sourceAd.id, sourceCreativeId);
        const resolved = resolveCreativeCloneInput(
          sourceCreative,
          sourceAd,
          sourceAdSet.name,
          target_ad_set.name,
          override,
          reuse_source_media,
        );

        if (!resolved.input) {
          skipped.push({
            source_ad_id: sourceAd.id,
            source_creative_id: sourceCreativeId,
            name: sourceAd.name,
            reason: resolved.reason ?? "Unknown creative clone resolution error.",
          });
          continue;
        }

        resolvedCreativePlans.push({
          sourceAd,
          sourceCreativeId,
          input: resolved.input,
        });

        plannedCreatives.push({
          source_ad_id: sourceAd.id,
          source_creative_id: sourceCreativeId,
          name: resolved.input.name,
          status: targetStatus,
          planned: true,
        });
        plannedAds.push({
          source_ad_id: sourceAd.id,
          name: deriveClonedName(sourceAd.name, sourceAdSet.name, target_ad_set.name),
          status: targetStatus,
          planned: true,
        });
      }

      const result: CloneAdSetBundleResult = {
        dry_run,
        idempotency_key,
        new_ad_set: {
          name: target_ad_set.name,
          campaign_id: sourceAdSet.campaign_id,
          status: targetStatus,
          planned: dry_run,
        },
        created_creatives: [],
        created_ads: [],
        skipped,
        warnings,
      };

      if (dry_run) {
        result.created_creatives = plannedCreatives;
        result.created_ads = plannedAds;

        return {
          content: [
            {
              type: "text",
              text: `Dry run ready: ${target_ad_set.name}\nSource ads inspected: ${sourceAds.length}\nCreatives planned: ${plannedCreatives.length}\nAds planned: ${plannedAds.length}\nSkipped: ${skipped.length}`,
            },
            { type: "text", text: JSON.stringify(result, null, 2) },
          ],
        };
      }

      const accountNodeId = normalizeAccountId(account_id);
      const createAdSetBody: Record<string, string | number | boolean> = {
        campaign_id: sourceAdSet.campaign_id,
        name: target_ad_set.name,
        destination_type: target_ad_set.destination_type ?? sourceAdSet.destination_type ?? "WEBSITE",
        status: targetStatus,
        optimization_goal: sourceAdSet.optimization_goal,
        billing_event: sourceAdSet.billing_event,
        targeting: JSON.stringify(clonedTargeting),
      };

      const resolvedLifetimeBudget = target_ad_set.lifetime_budget ?? (sourceAdSet.lifetime_budget ? Number(sourceAdSet.lifetime_budget) : undefined);
      const resolvedDailyBudget =
        resolvedLifetimeBudget === undefined
          ? target_ad_set.daily_budget ?? (sourceAdSet.daily_budget ? Number(sourceAdSet.daily_budget) : undefined)
          : undefined;

      if (resolvedLifetimeBudget !== undefined) createAdSetBody.lifetime_budget = String(resolvedLifetimeBudget);
      if (resolvedDailyBudget !== undefined) createAdSetBody.daily_budget = String(resolvedDailyBudget);
      if (sourceAdSet.bid_amount !== undefined) createAdSetBody.bid_amount = sourceAdSet.bid_amount;
      if (sourceAdSet.bid_strategy) createAdSetBody.bid_strategy = sourceAdSet.bid_strategy;
      if (sourceAdSet.start_time) createAdSetBody.start_time = sourceAdSet.start_time;
      if (sourceAdSet.end_time && resolvedLifetimeBudget !== undefined) createAdSetBody.end_time = sourceAdSet.end_time;

      const promotedObject = target_ad_set.promoted_object ?? sourceAdSet.promoted_object;
      if (promotedObject) createAdSetBody.promoted_object = JSON.stringify(promotedObject);

      const newAdSet = await metaApiClient.postForm<{ id: string }>(`/${accountNodeId}/adsets`, createAdSetBody);
      result.new_ad_set = {
        id: newAdSet.id,
        name: target_ad_set.name,
        campaign_id: sourceAdSet.campaign_id,
        status: targetStatus,
      };

      for (const plan of resolvedCreativePlans) {
        const creativeBody: Record<string, string | number | boolean> = {
          name: plan.input.name,
          object_story_spec: JSON.stringify({
            page_id: plan.input.page_id,
            ...(plan.input.instagram_actor_id ? { instagram_actor_id: plan.input.instagram_actor_id } : {}),
            ...(plan.input.video_id
              ? {
                  video_data: {
                    video_id: plan.input.video_id,
                    ...(plan.input.message ? { message: plan.input.message } : {}),
                    ...(plan.input.image_hash ? { image_hash: plan.input.image_hash } : {}),
                    ...(!plan.input.image_hash && plan.input.image_url ? { image_url: plan.input.image_url } : {}),
                    ...(plan.input.headline ? { title: plan.input.headline } : {}),
                    ...(
                      plan.input.call_to_action_type || plan.input.link_url
                        ? {
                            call_to_action: {
                              type: plan.input.call_to_action_type ?? "LEARN_MORE",
                              ...(plan.input.link_url ? { value: { link: plan.input.link_url } } : {}),
                            },
                          }
                        : {}
                    ),
                    ...(plan.input.description ? { link_description: plan.input.description } : {}),
                  },
                }
              : {
                  link_data: {
                    ...(plan.input.image_hash ? { image_hash: plan.input.image_hash } : {}),
                    ...(!plan.input.image_hash && plan.input.image_url ? { picture: plan.input.image_url } : {}),
                    ...(plan.input.link_url ? { link: plan.input.link_url } : {}),
                    ...(plan.input.message ? { message: plan.input.message } : {}),
                    ...(plan.input.headline ? { name: plan.input.headline } : {}),
                    ...(plan.input.description ? { description: plan.input.description } : {}),
                    ...(
                      plan.input.call_to_action_type
                        ? {
                            call_to_action: {
                              type: plan.input.call_to_action_type,
                              ...(plan.input.link_url ? { value: { link: plan.input.link_url } } : {}),
                            },
                          }
                        : {}
                    ),
                  },
                }),
          }),
        };

        const createdCreative = await metaApiClient.postForm<{ id: string }>(
          `/${accountNodeId}/adcreatives`,
          creativeBody,
        );

        result.created_creatives.push({
          id: createdCreative.id,
          name: plan.input.name,
          source_ad_id: plan.sourceAd.id,
          source_creative_id: plan.sourceCreativeId,
          status: targetStatus,
        });

        const clonedAdName = deriveClonedName(plan.sourceAd.name, sourceAdSet.name, target_ad_set.name);
        const adBody: Record<string, string | number | boolean> = {
          name: clonedAdName,
          adset_id: newAdSet.id,
          creative: JSON.stringify({ creative_id: createdCreative.id }),
          status: targetStatus,
        };

        if (plan.sourceAd.tracking_specs) {
          adBody.tracking_specs = JSON.stringify(plan.sourceAd.tracking_specs);
        }

        const createdAd = await metaApiClient.postForm<{ id: string }>(`/${accountNodeId}/ads`, adBody);
        result.created_ads.push({
          id: createdAd.id,
          name: clonedAdName,
          ad_set_id: newAdSet.id,
          creative_id: createdCreative.id,
          source_ad_id: plan.sourceAd.id,
          status: targetStatus,
        });
      }

      if (cacheKey) {
        cloneAdSetBundleCache.set(cacheKey, { signature: requestSignature, result });
      }

      return {
        content: [
          {
            type: "text",
            text: `Bundle cloned successfully!\nAd Set: ${target_ad_set.name} (${result.new_ad_set.id})\nCreatives created: ${result.created_creatives.length}\nAds created: ${result.created_ads.length}\nSkipped: ${result.skipped.length}`,
          },
          { type: "text", text: JSON.stringify(result, null, 2) },
        ],
      };
    },
  );

  // ─── Create Ad Set ───────────────────────────────────────────
  server.registerTool(
    "ads_create_ad_set",
    {
      description: `${WRITE_WARNING}Create a new ad set within a campaign. Requires targeting specification, optimization goal, budget, and destination_type (required for ODAX campaigns). Common destination_type values: WEBSITE (traffic/sales to website), APP (app installs), MESSENGER/WHATSAPP/INSTAGRAM_DIRECT (messaging), ON_AD (lead forms, instant experiences). Ad sets are created in PAUSED status by default.`,
      inputSchema: {
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
      annotations: { ...CREATE },
    },
    async ({
      account_id, campaign_id, name, destination_type, status, daily_budget, lifetime_budget,
      optimization_goal, billing_event, bid_amount, bid_strategy, targeting,
      start_time, end_time, promoted_object,
    }) => {
      const accountPath = normalizeAccountId(account_id);
      const campaignIdValidated = validateMetaId(campaign_id, "campaign");

      const body: Record<string, string | number | boolean> = {
        campaign_id: campaignIdValidated,
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

      const result = await metaApiClient.postForm<{ id: string }>(`/${accountPath}/adsets`, body);

      return {
        content: [
          {
            type: "text",
            text: `Ad set created successfully!\nID: ${result.id}\nName: ${name}\nCampaign: ${campaignIdValidated}\nStatus: ${status}\nOptimization: ${optimization_goal}`,
          },
        ],
      };
    },
  );

  // ─── Update Ad Set ───────────────────────────────────────────
  server.registerTool(
    "ads_update_ad_set",
    {
      description: `${WRITE_WARNING}Update an existing ad set in place. Common use cases: change daily_budget or lifetime_budget (values in cents — e.g., 2000 = $20.00), pause/reactivate via status (ACTIVE/PAUSED), extend end_time, replace targeting, adjust bid_amount/bid_strategy, or rename. Only the fields you pass are sent to Meta — omitted fields keep their current value. lifetime_budget requires a corresponding end_time on the ad set. Authentication is handled transparently: the active Meta token is resolved from the request context (Sign in with Meta OAuth, registered System User token, or X-Meta-Token header in service-to-service mode). Note that meaningful changes to bid_amount, bid_strategy, or targeting can re-trigger Meta's learning phase.`,
      inputSchema: {
        ad_set_id: z.string().describe("Ad set ID to update"),
        name: z.string().optional().describe("New ad set name"),
        status: statusEnum.optional().describe("New status. Use ACTIVE to start delivery, PAUSED to stop, ARCHIVED to retire. Use ads_delete_ad_set for soft-deletion."),
        destination_type: destinationTypeEnum.optional().describe("Where the ad traffic is directed. Common values: WEBSITE (website traffic/conversions), APP (app installs), MESSENGER (Messenger conversations), WHATSAPP (WhatsApp conversations), INSTAGRAM_DIRECT (Instagram DMs), ON_AD (lead forms, instant experiences, post engagement), ON_VIDEO (video views), ON_PAGE (page engagement), SHOP_AUTOMATIC (shop)"),
        daily_budget: z.number().optional().describe("Daily budget in cents (e.g., 2000 = $20.00). Mutually exclusive with lifetime_budget."),
        lifetime_budget: z.number().optional().describe("Lifetime budget in cents. Requires the ad set to have an end_time set; pass end_time in the same call if it isn't already configured."),
        targeting: targetingSchema.optional().describe("Replacement targeting spec. Replaces the entire targeting object — pass the full spec, not a partial one."),
        bid_amount: z.number().optional().describe("Bid cap in cents. Only meaningful with bid_strategy = LOWEST_COST_WITH_BID_CAP or COST_CAP."),
        bid_strategy: bidStrategyEnum.optional().describe("Bidding strategy. Changing strategy may require corresponding changes to bid_amount."),
        end_time: z.string().optional().describe("ISO 8601 end time. Required when setting or keeping lifetime_budget."),
      },
      annotations: { ...UPDATE },
    },
    async ({ ad_set_id, name, status, destination_type, daily_budget, lifetime_budget, targeting, bid_amount, bid_strategy, end_time }) => {
      const id = validateMetaId(ad_set_id, "adset");
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

      await metaApiClient.postForm<{ success: boolean }>(`/${id}`, body);

      return {
        content: [
          { type: "text", text: `Ad set ${id} updated successfully.\nChanges: ${JSON.stringify(body)}` },
        ],
      };
    },
  );

  // ─── Delete Ad Set ───────────────────────────────────────────
  server.registerTool(
    "ads_delete_ad_set",
    {
      description: `${WRITE_WARNING}Delete an ad set (soft delete — sets status to DELETED).`,
      inputSchema: {
        ad_set_id: z.string().describe("Ad set ID to delete"),
      },
      annotations: { ...DELETE },
    },
    async ({ ad_set_id }) => {
      const id = validateMetaId(ad_set_id, "adset");
      await metaApiClient.postForm<{ success: boolean }>(`/${id}`, {
        status: "DELETED",
      });

      return {
        content: [
          { type: "text", text: `Ad set ${id} has been deleted (status set to DELETED).` },
        ],
      };
    },
  );
}
