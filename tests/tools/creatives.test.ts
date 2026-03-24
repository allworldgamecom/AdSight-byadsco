import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { registerCreativeTools } from "../../src/tools/creatives.js";
import {
  createMockMcpServer,
  setupTestToken,
  cleanupTestToken,
  mockFetchResponse,
} from "../setup.js";

describe("registerCreativeTools", () => {
  beforeEach(() => {
    setupTestToken();
  });

  afterEach(() => {
    cleanupTestToken();
    vi.restoreAllMocks();
  });

  it("registers exactly 9 tools", () => {
    const server = createMockMcpServer();
    registerCreativeTools(server as never);
    expect(server.tool).toHaveBeenCalledTimes(9);
  });

  it("registers tools with expected names", () => {
    const server = createMockMcpServer();
    registerCreativeTools(server as never);

    const names = server._registeredTools.map((t) => t.name);
    expect(names).toEqual([
      "meta_ads_get_ad_creatives",
      "meta_ads_get_creative_details",
      "meta_ads_create_ad_creative",
      "meta_ads_update_ad_creative",
      "meta_ads_upload_ad_image",
      "meta_ads_get_ad_images",
      "meta_ads_get_ad_videos",
      "meta_ads_get_video_details",
      "meta_ads_upload_ad_video",
    ]);
  });

  describe("meta_ads_get_creative_details handler", () => {
    it("uses default fields and returns a readable summary", async () => {
      const server = createMockMcpServer();
      registerCreativeTools(server as never);

      const mockCreative = {
        id: "crt_123",
        name: "Spring Creative",
        status: "ACTIVE",
        call_to_action_type: "LEARN_MORE",
        link_url: "https://example.com",
        effective_object_story_id: "page_1_post_9",
      };

      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockFetchResponse(mockCreative)));

      const handler = server._registeredTools[1].handler;
      const result = await handler({
        creative_id: "crt_123",
        fields: undefined,
      }) as { content: Array<{ type: string; text: string }> };

      expect(result.content[0].text).toContain("Creative: Spring Creative (crt_123)");
      expect(result.content[0].text).toContain("Status: ACTIVE");
      expect(result.content[0].text).toContain("CTA: LEARN_MORE");

      const url = new URL(vi.mocked(fetch).mock.calls[0][0] as string);
      expect(url.pathname).toContain("/crt_123");
      expect(url.searchParams.get("fields")).toBe(
        "id,name,title,body,image_hash,image_url,thumbnail_url,object_story_spec,asset_feed_spec,call_to_action_type,link_url,effective_object_story_id,status",
      );
    });

    it("uses custom fields when provided", async () => {
      const server = createMockMcpServer();
      registerCreativeTools(server as never);

      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockFetchResponse({
        id: "crt_999",
        name: "Custom Fields Creative",
      })));

      const handler = server._registeredTools[1].handler;
      await handler({
        creative_id: "crt_999",
        fields: ["id", "name"],
      });

      const url = new URL(vi.mocked(fetch).mock.calls[0][0] as string);
      expect(url.searchParams.get("fields")).toBe("id,name");
    });
  });
});
