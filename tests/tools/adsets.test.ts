import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerAdSetTools } from "../../src/tools/adsets.js";
import {
  cleanupTestToken,
  createMockMcpServer,
  mockFetchResponse,
  setupTestToken,
} from "../setup.js";

describe("registerAdSetTools", () => {
  beforeEach(() => {
    setupTestToken();
  });

  afterEach(() => {
    cleanupTestToken();
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
