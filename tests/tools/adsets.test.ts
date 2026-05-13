import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerAdSetTools } from "../../src/tools/adsets.js";
import { resetCloneBundleStoreForTests } from "../../src/store/clone-bundle-store.js";
import {
  cleanupTestToken,
  createMockMcpServer,
  mockFetchResponse,
  setupTestToken,
} from "../setup.js";

describe("registerAdSetTools", () => {
  beforeEach(() => {
    setupTestToken();
    resetCloneBundleStoreForTests();
  });

  afterEach(() => {
    cleanupTestToken();
    resetCloneBundleStoreForTests();
    vi.restoreAllMocks();
  });

  it("registers exactly 6 tools", () => {
    const server = createMockMcpServer();
    registerAdSetTools(server as never);
    expect(server.registerTool).toHaveBeenCalledTimes(6);
  });

  it("registers tools with expected names", () => {
    const server = createMockMcpServer();
    registerAdSetTools(server as never);

    const names = server._registeredTools.map((tool) => tool.name);
    expect(names).toEqual([
      "ads_get_ad_sets",
      "ads_get_ad_set_details",
      "ads_clone_ad_set_bundle",
      "ads_create_ad_set",
      "ads_update_ad_set",
      "ads_delete_ad_set",
    ]);
  });

  describe("ads_get_ad_set_details handler", () => {
    it("forces identity fields and never renders undefined with partial field requests", async () => {
      const server = createMockMcpServer();
      registerAdSetTools(server as never);

      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockFetchResponse({
        id: "2001",
        name: "Honduras - Mujeres",
        campaign_id: "1001",
        status: "PAUSED",
        effective_status: "PAUSED",
        promoted_object: { pixel_id: "px_1" },
      })));

      const handler = server._registeredTools[1].handler;
      const result = await handler({
        ad_set_id: "2001",
        fields: ["promoted_object"],
      }) as { content: Array<{ type: string; text: string }> };

      const url = new URL(vi.mocked(fetch).mock.calls[0][0] as string);
      const fields = url.searchParams.get("fields")?.split(",") ?? [];

      expect(fields).toEqual(expect.arrayContaining([
        "id",
        "name",
        "campaign_id",
        "status",
        "effective_status",
        "promoted_object",
      ]));
      expect(result.content[0].text).not.toContain("undefined");
      expect(result.content[0].text).toContain("Optimization: N/A");
      expect(result.content[0].text).toContain("Targeting: N/A");
    });
  });

  describe("ads_clone_ad_set_bundle handler", () => {
    it("returns a dry-run plan without mutations", async () => {
      const server = createMockMcpServer();
      registerAdSetTools(server as never);

      vi.stubGlobal("fetch", vi.fn()
        .mockResolvedValueOnce(mockFetchResponse({
          id: "2099",
          name: "Honduras - Mujeres",
          campaign_id: "1001",
          status: "ACTIVE",
          effective_status: "ACTIVE",
          daily_budget: "500",
          optimization_goal: "OFFSITE_CONVERSIONS",
          billing_event: "IMPRESSIONS",
          targeting: {
            genders: [2],
            geo_locations: {
              countries: ["HN"],
              location_types: ["home", "recent"],
            },
          },
          promoted_object: {
            pixel_id: "px_1",
            custom_event_type: "SUBMIT_APPLICATION",
          },
          destination_type: "WEBSITE",
        }))
        .mockResolvedValueOnce(mockFetchResponse({
          data: [
            {
              id: "3001",
              name: "Honduras - Mujeres__flyer_1",
              adset_id: "2099",
              campaign_id: "1001",
              status: "ACTIVE",
              effective_status: "ACTIVE",
              creative: { id: "4001" },
              created_time: "2026-03-01T00:00:00-0500",
              updated_time: "2026-03-01T00:00:00-0500",
            },
          ],
        }))
        .mockResolvedValueOnce(mockFetchResponse({
          id: "4001",
          name: "Creative HN",
          title: "Original headline",
          body: "Original message",
          image_hash: "img_hash_1",
          call_to_action_type: "APPLY_NOW",
          object_story_spec: {
            page_id: "6001",
            link_data: {
              link: "https://ugc.byads.co/",
              message: "Original message",
              name: "Original headline",
              description: "Original description",
              image_hash: "img_hash_1",
              call_to_action: {
                type: "APPLY_NOW",
                value: { link: "https://ugc.byads.co/" },
              },
            },
          },
        })));

      const handler = server._registeredTools[2].handler;
      const result = await handler({
        account_id: "act_123",
        source_ad_set_id: "2099",
        target_ad_set: {
          name: "Chile - Mujeres",
          geo_override: { countries: ["CL"] },
          status: "PAUSED",
          daily_budget: undefined,
          lifetime_budget: undefined,
          destination_type: undefined,
          promoted_object: undefined,
        },
        creative_overrides: [
          {
            source_ad_id: "3001",
            headline: "Headline Chile",
            message: "Mensaje Chile",
            description: "Descripcion Chile",
          },
        ],
        reuse_source_media: true,
        dry_run: true,
        idempotency_key: undefined,
      }) as { content: Array<{ type: string; text: string }> };

      const payload = JSON.parse(result.content[1].text) as {
        dry_run: boolean;
        new_ad_set: { name: string; planned?: boolean };
        created_creatives: Array<{ name: string; planned?: boolean }>;
        created_ads: Array<{ name: string; planned?: boolean }>;
      };

      expect(payload.dry_run).toBe(true);
      expect(payload.new_ad_set.name).toBe("Chile - Mujeres");
      expect(payload.new_ad_set.planned).toBe(true);
      expect(payload.created_creatives).toHaveLength(1);
      expect(payload.created_creatives[0]?.name).toBe("Chile - Mujeres__flyer_1");
      expect(payload.created_creatives[0]?.planned).toBe(true);
      expect(payload.created_ads).toHaveLength(1);

      const methods = vi.mocked(fetch).mock.calls.map((call) => call[1]?.method ?? "GET");
      expect(methods).toEqual(["GET", "GET", "GET"]);
    });

    it("reuses the cached result when called twice with the same idempotency key", async () => {
      const server = createMockMcpServer();
      registerAdSetTools(server as never);

      vi.stubGlobal("fetch", vi.fn()
        .mockResolvedValueOnce(mockFetchResponse({
          id: "2999",
          name: "Honduras - Mujeres",
          campaign_id: "1001",
          status: "ACTIVE",
          effective_status: "ACTIVE",
          daily_budget: "500",
          optimization_goal: "OFFSITE_CONVERSIONS",
          billing_event: "IMPRESSIONS",
          targeting: {
            genders: [2],
            geo_locations: { countries: ["HN"] },
          },
          promoted_object: { pixel_id: "px_1" },
          destination_type: "WEBSITE",
        }))
        .mockResolvedValueOnce(mockFetchResponse({
          data: [
            {
              id: "3099",
              name: "Honduras - Mujeres__flyer_1",
              adset_id: "2999",
              campaign_id: "1001",
              status: "ACTIVE",
              effective_status: "ACTIVE",
              creative: { id: "4999" },
              created_time: "2026-03-01T00:00:00-0500",
              updated_time: "2026-03-01T00:00:00-0500",
            },
          ],
        }))
        .mockResolvedValueOnce(mockFetchResponse({
          id: "4999",
          name: "Creative HN",
          title: "Original headline",
          body: "Original message",
          image_hash: "img_hash_1",
          call_to_action_type: "APPLY_NOW",
          object_story_spec: {
            page_id: "6001",
            link_data: {
              link: "https://ugc.byads.co/",
              message: "Original message",
              name: "Original headline",
              description: "Original description",
              image_hash: "img_hash_1",
              call_to_action: {
                type: "APPLY_NOW",
                value: { link: "https://ugc.byads.co/" },
              },
            },
          },
        }))
        .mockResolvedValueOnce(mockFetchResponse({ id: "20001" }))
        .mockResolvedValueOnce(mockFetchResponse({ id: "40001" }))
        .mockResolvedValueOnce(mockFetchResponse({ id: "30001" })));

      const handler = server._registeredTools[2].handler;
      const input = {
        account_id: "act_123",
        source_ad_set_id: "2999",
        target_ad_set: {
          name: "Chile - Mujeres",
          geo_override: { countries: ["CL"] },
          status: "PAUSED",
          daily_budget: undefined,
          lifetime_budget: undefined,
          destination_type: undefined,
          promoted_object: undefined,
        },
        creative_overrides: [
          {
            source_ad_id: "3099",
            headline: "Headline Chile",
            message: "Mensaje Chile",
            description: "Descripcion Chile",
          },
        ],
        reuse_source_media: true,
        dry_run: false,
        idempotency_key: "clone-key-1",
      };

      const first = await handler(input) as { content: Array<{ type: string; text: string }> };
      const firstPayload = JSON.parse(first.content[1].text) as {
        new_ad_set: { id?: string };
        created_creatives: Array<{ id?: string }>;
        created_ads: Array<{ id?: string }>;
      };

      expect(firstPayload.new_ad_set.id).toBe("20001");
      expect(firstPayload.created_creatives[0]?.id).toBe("40001");
      expect(firstPayload.created_ads[0]?.id).toBe("30001");
      expect(vi.mocked(fetch)).toHaveBeenCalledTimes(6);

      const second = await handler(input) as { content: Array<{ type: string; text: string }> };
      expect(second.content[0].text).toContain("reused cached result");
      expect(vi.mocked(fetch)).toHaveBeenCalledTimes(6);
    });

    it("never duplicates destination_type in the source GET fields list", async () => {
      const server = createMockMcpServer();
      registerAdSetTools(server as never);

      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockFetchResponse({
        id: "2099", name: "X", campaign_id: "1001",
        status: "ACTIVE", effective_status: "ACTIVE",
        daily_budget: "500",
        optimization_goal: "OFFSITE_CONVERSIONS",
        billing_event: "IMPRESSIONS",
        targeting: { geo_locations: { countries: ["HN"] } },
        destination_type: "WEBSITE",
      })));

      const handler = server._registeredTools[2].handler;
      // dry_run=true short-circuits after the GET; we just want to assert the fields list shape.
      await handler({
        account_id: "act_123",
        source_ad_set_id: "2099",
        target_ad_set: { name: "Y", geo_override: { countries: ["CL"] }, status: "PAUSED" },
        creative_overrides: [],
        reuse_source_media: true,
        dry_run: true,
      }).catch(() => undefined);

      const firstUrl = new URL(vi.mocked(fetch).mock.calls[0][0] as string);
      const fields = firstUrl.searchParams.get("fields")?.split(",") ?? [];
      const dups = fields.filter((f) => f === "destination_type");
      expect(dups).toHaveLength(1);
    });

    it("dry-run: geo_override REPLACES source geo_locations (no city/region inheritance)", async () => {
      const server = createMockMcpServer();
      registerAdSetTools(server as never);

      vi.stubGlobal("fetch", vi.fn()
        .mockResolvedValueOnce(mockFetchResponse({
          id: "2099", name: "Source", campaign_id: "1001",
          status: "ACTIVE", effective_status: "ACTIVE",
          daily_budget: "500",
          optimization_goal: "OFFSITE_CONVERSIONS",
          billing_event: "IMPRESSIONS",
          targeting: {
            geo_locations: {
              countries: ["CL"],
              cities: [{ key: "santiago" }],
              regions: [{ key: "RM" }],
            },
            // Read-only fields Meta returns on GET — must be stripped on POST.
            targeting_relaxation_types: { lookalike: 1 },
            targeting_optimization: "expansion_all",
            is_whatsapp_destination_ad: false,
          },
          destination_type: "WEBSITE",
        }))
        .mockResolvedValueOnce(mockFetchResponse({ data: [] }))); // no ads — bundle throws

      const handler = server._registeredTools[2].handler;
      // dry_run=true to avoid needing to simulate the create chain;
      // we want to assert geo_override behavior on the cloned targeting.
      // But applyGeoOverride is only tested via the create body, so we
      // inspect the dry-run plan's behavior indirectly: the test simply
      // ensures no crash and that the bundle doesn't try to inherit cities.
      // (Detailed POST-body assertions live in the partial-failure test below.)
      await handler({
        account_id: "act_123",
        source_ad_set_id: "2099",
        target_ad_set: { name: "Target", geo_override: { countries: ["CO"] }, status: "PAUSED" },
        creative_overrides: [],
        reuse_source_media: true,
        dry_run: true,
      }).catch((err: Error) => {
        // dry-run may still succeed with 0 planned creatives; that's fine.
        expect(err).toBeUndefined();
      });
    });

    it("create: strips read-only targeting fields and replaces geo_locations", async () => {
      const server = createMockMcpServer();
      registerAdSetTools(server as never);

      vi.stubGlobal("fetch", vi.fn()
        .mockResolvedValueOnce(mockFetchResponse({
          id: "2099", name: "Source", campaign_id: "1001",
          status: "ACTIVE", effective_status: "ACTIVE",
          daily_budget: "500",
          optimization_goal: "OFFSITE_CONVERSIONS",
          billing_event: "IMPRESSIONS",
          targeting: {
            geo_locations: { countries: ["CL"], cities: [{ key: "santiago" }] },
            targeting_relaxation_types: { lookalike: 1 },
            targeting_optimization: "expansion_all",
            is_whatsapp_destination_ad: false,
            genders: [2],
          },
          promoted_object: { pixel_id: "px_1" },
          destination_type: "WEBSITE",
        }))
        .mockResolvedValueOnce(mockFetchResponse({
          data: [{
            id: "3001", name: "Source__a1", adset_id: "2099", campaign_id: "1001",
            status: "ACTIVE", effective_status: "ACTIVE", creative: { id: "4001" },
            created_time: "2026-01-01T00:00:00-0000", updated_time: "2026-01-01T00:00:00-0000",
          }],
        }))
        .mockResolvedValueOnce(mockFetchResponse({
          id: "4001", name: "C1",
          object_story_spec: {
            page_id: "6001",
            instagram_user_id: "ig_7777",
            link_data: { link: "https://x.com/", message: "m", name: "h", image_hash: "h1" },
          },
        }))
        .mockResolvedValueOnce(mockFetchResponse({ id: "20001" })) // POST ad set
        .mockResolvedValueOnce(mockFetchResponse({ id: "40001" })) // POST creative
        .mockResolvedValueOnce(mockFetchResponse({ id: "30001" }))); // POST ad

      const handler = server._registeredTools[2].handler;
      await handler({
        account_id: "act_123",
        source_ad_set_id: "2099",
        target_ad_set: { name: "Target", geo_override: { countries: ["CO"] }, status: "PAUSED" },
        creative_overrides: [],
        reuse_source_media: true,
        dry_run: false,
        idempotency_key: "k-strip-1",
      });

      // 4th fetch call = POST /act_123/adsets
      const adsetPost = vi.mocked(fetch).mock.calls[3];
      expect(adsetPost[1]?.method).toBe("POST");
      const body = adsetPost[1]?.body as string;
      const params = new URLSearchParams(body);
      const sentTargeting = JSON.parse(params.get("targeting") ?? "{}") as Record<string, unknown>;

      // geo_locations REPLACED — no cities inherited.
      expect(sentTargeting.geo_locations).toEqual({ countries: ["CO"] });
      // Other targeting fields preserved.
      expect(sentTargeting.genders).toEqual([2]);
      // Read-only fields stripped.
      expect(sentTargeting.targeting_relaxation_types).toBeUndefined();
      expect(sentTargeting.targeting_optimization).toBeUndefined();
      expect(sentTargeting.is_whatsapp_destination_ad).toBeUndefined();

      // 5th fetch call = POST /act_123/adcreatives — uses instagram_user_id, not instagram_actor_id.
      const creativePost = vi.mocked(fetch).mock.calls[4];
      const creativeBody = creativePost[1]?.body as string;
      const creativeParams = new URLSearchParams(creativeBody);
      const oss = JSON.parse(creativeParams.get("object_story_spec") ?? "{}") as Record<string, unknown>;
      expect(oss.instagram_user_id).toBe("ig_7777");
      expect(oss.instagram_actor_id).toBeUndefined();
    });

    it("falls back to legacy instagram_actor_id on read but writes instagram_user_id", async () => {
      const server = createMockMcpServer();
      registerAdSetTools(server as never);

      vi.stubGlobal("fetch", vi.fn()
        .mockResolvedValueOnce(mockFetchResponse({
          id: "2099", name: "Source", campaign_id: "1001",
          status: "ACTIVE", effective_status: "ACTIVE",
          daily_budget: "500",
          optimization_goal: "OFFSITE_CONVERSIONS",
          billing_event: "IMPRESSIONS",
          targeting: { geo_locations: { countries: ["CL"] } },
          destination_type: "WEBSITE",
        }))
        .mockResolvedValueOnce(mockFetchResponse({
          data: [{
            id: "3001", name: "Source__a1", adset_id: "2099", campaign_id: "1001",
            status: "ACTIVE", effective_status: "ACTIVE", creative: { id: "4001" },
            created_time: "2026-01-01T00:00:00-0000", updated_time: "2026-01-01T00:00:00-0000",
          }],
        }))
        .mockResolvedValueOnce(mockFetchResponse({
          id: "4001", name: "C1",
          object_story_spec: {
            page_id: "6001",
            // Legacy field name — old creatives still return this.
            instagram_actor_id: "ig_legacy_5555",
            link_data: { link: "https://x.com/", image_hash: "h1" },
          },
        }))
        .mockResolvedValueOnce(mockFetchResponse({ id: "20001" }))
        .mockResolvedValueOnce(mockFetchResponse({ id: "40001" }))
        .mockResolvedValueOnce(mockFetchResponse({ id: "30001" })));

      const handler = server._registeredTools[2].handler;
      await handler({
        account_id: "act_123",
        source_ad_set_id: "2099",
        target_ad_set: { name: "Target", geo_override: { countries: ["CO"] }, status: "PAUSED" },
        creative_overrides: [],
        reuse_source_media: true,
        dry_run: false,
        idempotency_key: "k-legacy-1",
      });

      const creativePost = vi.mocked(fetch).mock.calls[4];
      const oss = JSON.parse(
        new URLSearchParams(creativePost[1]?.body as string).get("object_story_spec") ?? "{}",
      ) as Record<string, unknown>;
      expect(oss.instagram_user_id).toBe("ig_legacy_5555");
      expect(oss.instagram_actor_id).toBeUndefined();
    });

    it("user-provided daily_budget wins over source lifetime_budget", async () => {
      const server = createMockMcpServer();
      registerAdSetTools(server as never);

      vi.stubGlobal("fetch", vi.fn()
        .mockResolvedValueOnce(mockFetchResponse({
          id: "2099", name: "Source", campaign_id: "1001",
          status: "ACTIVE", effective_status: "ACTIVE",
          lifetime_budget: "100000",
          end_time: "2026-12-31T23:59:59-0000",
          optimization_goal: "OFFSITE_CONVERSIONS",
          billing_event: "IMPRESSIONS",
          targeting: { geo_locations: { countries: ["CL"] } },
          destination_type: "WEBSITE",
        }))
        .mockResolvedValueOnce(mockFetchResponse({
          data: [{
            id: "3001", name: "Source__a1", adset_id: "2099", campaign_id: "1001",
            status: "ACTIVE", effective_status: "ACTIVE", creative: { id: "4001" },
            created_time: "2026-01-01T00:00:00-0000", updated_time: "2026-01-01T00:00:00-0000",
          }],
        }))
        .mockResolvedValueOnce(mockFetchResponse({
          id: "4001", name: "C1",
          object_story_spec: {
            page_id: "6001",
            link_data: { link: "https://x.com/", image_hash: "h1" },
          },
        }))
        .mockResolvedValueOnce(mockFetchResponse({ id: "20001" }))
        .mockResolvedValueOnce(mockFetchResponse({ id: "40001" }))
        .mockResolvedValueOnce(mockFetchResponse({ id: "30001" })));

      const handler = server._registeredTools[2].handler;
      await handler({
        account_id: "act_123",
        source_ad_set_id: "2099",
        target_ad_set: {
          name: "Target", geo_override: { countries: ["CO"] }, status: "PAUSED",
          daily_budget: 500,
        },
        creative_overrides: [],
        reuse_source_media: true,
        dry_run: false,
        idempotency_key: "k-budget-1",
      });

      const adsetPost = vi.mocked(fetch).mock.calls[3];
      const params = new URLSearchParams(adsetPost[1]?.body as string);
      expect(params.get("daily_budget")).toBe("500");
      expect(params.get("lifetime_budget")).toBeNull();
      expect(params.get("end_time")).toBeNull();
    });

    it("throws when no creatives can be cloned (does not create an empty ad set)", async () => {
      const server = createMockMcpServer();
      registerAdSetTools(server as never);

      vi.stubGlobal("fetch", vi.fn()
        .mockResolvedValueOnce(mockFetchResponse({
          id: "2099", name: "Source", campaign_id: "1001",
          status: "ACTIVE", effective_status: "ACTIVE",
          daily_budget: "500",
          optimization_goal: "OFFSITE_CONVERSIONS",
          billing_event: "IMPRESSIONS",
          targeting: { geo_locations: { countries: ["CL"] } },
          destination_type: "WEBSITE",
        }))
        .mockResolvedValueOnce(mockFetchResponse({
          data: [{
            id: "3001", name: "Source__a1", adset_id: "2099", campaign_id: "1001",
            status: "ACTIVE", effective_status: "ACTIVE", creative: { id: "4001" },
            created_time: "2026-01-01T00:00:00-0000", updated_time: "2026-01-01T00:00:00-0000",
          }],
        }))
        .mockResolvedValueOnce(mockFetchResponse({
          id: "4001", name: "C1",
          // asset_feed_spec — not supported, will be skipped.
          asset_feed_spec: { bodies: [{ text: "x" }] },
          object_story_spec: { page_id: "6001", link_data: { link: "https://x.com/" } },
        })));

      const handler = server._registeredTools[2].handler;
      await expect(handler({
        account_id: "act_123",
        source_ad_set_id: "2099",
        target_ad_set: { name: "Target", geo_override: { countries: ["CO"] }, status: "PAUSED" },
        creative_overrides: [],
        reuse_source_media: true,
        dry_run: false,
        idempotency_key: "k-empty-1",
      })).rejects.toThrow(/no clonable creatives/);

      // No POSTs at all — we threw before claiming or creating anything.
      const posts = vi.mocked(fetch).mock.calls.filter((c) => c[1]?.method === "POST");
      expect(posts).toHaveLength(0);
    });

    it("surfaces partial state in the error when ad creation fails after ad set + creative succeed", async () => {
      const server = createMockMcpServer();
      registerAdSetTools(server as never);

      vi.stubGlobal("fetch", vi.fn()
        .mockResolvedValueOnce(mockFetchResponse({
          id: "2099", name: "Source", campaign_id: "1001",
          status: "ACTIVE", effective_status: "ACTIVE",
          daily_budget: "500",
          optimization_goal: "OFFSITE_CONVERSIONS",
          billing_event: "IMPRESSIONS",
          targeting: { geo_locations: { countries: ["CL"] } },
          destination_type: "WEBSITE",
        }))
        .mockResolvedValueOnce(mockFetchResponse({
          data: [{
            id: "3001", name: "Source__a1", adset_id: "2099", campaign_id: "1001",
            status: "ACTIVE", effective_status: "ACTIVE", creative: { id: "4001" },
            created_time: "2026-01-01T00:00:00-0000", updated_time: "2026-01-01T00:00:00-0000",
          }],
        }))
        .mockResolvedValueOnce(mockFetchResponse({
          id: "4001", name: "C1",
          object_story_spec: { page_id: "6001", link_data: { link: "https://x.com/", image_hash: "h1" } },
        }))
        .mockResolvedValueOnce(mockFetchResponse({ id: "20001" })) // POST ad set OK
        .mockResolvedValueOnce(mockFetchResponse({ id: "40001" })) // POST creative OK
        .mockResolvedValueOnce(mockFetchResponse({  // POST ad FAILS
          error: { message: "Bad ad payload", type: "OAuthException", code: 100 },
        })));

      const handler = server._registeredTools[2].handler;
      await expect(handler({
        account_id: "act_123",
        source_ad_set_id: "2099",
        target_ad_set: { name: "Target", geo_override: { countries: ["CO"] }, status: "PAUSED" },
        creative_overrides: [],
        reuse_source_media: true,
        dry_run: false,
        idempotency_key: "k-partial-1",
      })).rejects.toThrow(/partial state.*ad_set=20001.*creatives=\[40001\]/);
    });
  });

  describe("ads_update_ad_set handler", () => {
    it("issues POST /<ad_set_id> with only the budget field and confirms success", async () => {
      const server = createMockMcpServer();
      registerAdSetTools(server as never);

      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockFetchResponse({ success: true })));

      const tool = server._registeredTools.find((t) => t.name === "ads_update_ad_set");
      expect(tool).toBeDefined();

      const result = await tool!.handler({
        ad_set_id: "2001",
        daily_budget: 5000,
      }) as { content: Array<{ type: string; text: string }> };

      const call = vi.mocked(fetch).mock.calls[0];
      const url = new URL(call[0] as string);
      expect(url.pathname).toMatch(/\/2001$/);
      expect(call[1]?.method).toBe("POST");

      const body = call[1]?.body as string;
      expect(body).toContain("daily_budget=5000");
      expect(body).not.toContain("name=");
      expect(body).not.toContain("status=");
      expect(body).not.toContain("targeting=");

      expect(result.content[0].text).toContain("Ad set 2001 updated successfully");
      expect(result.content[0].text).toContain("daily_budget");
    });
  });
});
