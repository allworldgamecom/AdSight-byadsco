import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { registerAudienceTools } from "../../src/tools/audiences.js";
import {
  createMockMcpServer,
  setupTestToken,
  cleanupTestToken,
  mockFetchResponse,
} from "../setup.js";

const CREATE_AUDIENCE_INDEX = 2;

const PIXEL_RULE = JSON.stringify({
  inclusions: {
    operator: "or",
    rules: [
      {
        event_sources: [{ id: "319119567739392", type: "pixel" }],
        retention_seconds: 15552000,
        filter: {
          operator: "and",
          filters: [{ field: "event", operator: "=", value: "FTD" }],
        },
      },
    ],
  },
});

describe("registerAudienceTools", () => {
  beforeEach(() => {
    setupTestToken();
  });

  afterEach(() => {
    cleanupTestToken();
    vi.restoreAllMocks();
  });

  it("registers exactly 5 tools", () => {
    const server = createMockMcpServer();
    registerAudienceTools(server as never);
    expect(server.registerTool).toHaveBeenCalledTimes(5);
  });

  it("registers tools with expected names", () => {
    const server = createMockMcpServer();
    registerAudienceTools(server as never);

    const names = server._registeredTools.map((t) => t.name);
    expect(names).toEqual([
      "ads_get_custom_audiences",
      "ads_get_audience_details",
      "ads_create_custom_audience",
      "ads_create_lookalike_audience",
      "ads_delete_custom_audience",
    ]);
  });

  describe("ads_create_custom_audience handler", () => {
    it("omits subtype and forwards rule when creating a pixel-based WEBSITE audience", async () => {
      const server = createMockMcpServer();
      registerAudienceTools(server as never);

      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockFetchResponse({ id: "9000123" })));

      const handler = server._registeredTools[CREATE_AUDIENCE_INDEX].handler;
      const result = await handler({
        account_id: "1564852554415330",
        name: "Doradobet - FTD - 180D",
        description: undefined,
        subtype: undefined,
        customer_file_source: undefined,
        retention_days: 180,
        rule: PIXEL_RULE,
        prefill: true,
      }) as { content: Array<{ type: string; text: string }> };

      expect(result.content[0].text).toContain("Custom audience created!");
      expect(result.content[0].text).toContain("9000123");

      const call = vi.mocked(fetch).mock.calls[0];
      const body = String(call[1]?.body ?? "");
      const params = new URLSearchParams(body);

      expect(params.get("name")).toBe("Doradobet - FTD - 180D");
      expect(params.get("rule")).toBe(PIXEL_RULE);
      expect(params.get("retention_days")).toBe("180");
      expect(params.get("prefill")).toBe("true");
      expect(params.has("subtype")).toBe(false);
      expect(params.has("customer_file_source")).toBe(false);
    });

    it("silences subtype when caller passes both subtype WEBSITE and rule (Meta v25 rejects it)", async () => {
      const server = createMockMcpServer();
      registerAudienceTools(server as never);

      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockFetchResponse({ id: "9000124" })));

      const handler = server._registeredTools[CREATE_AUDIENCE_INDEX].handler;
      await handler({
        account_id: "1564852554415330",
        name: "Doradobet - FTD - 180D",
        description: undefined,
        subtype: "WEBSITE",
        customer_file_source: undefined,
        retention_days: 180,
        rule: PIXEL_RULE,
        prefill: undefined,
      });

      const call = vi.mocked(fetch).mock.calls[0];
      const params = new URLSearchParams(String(call[1]?.body ?? ""));

      expect(params.get("rule")).toBe(PIXEL_RULE);
      expect(params.has("subtype")).toBe(false);
    });

    it("throws early when subtype=CUSTOM is missing customer_file_source", async () => {
      const server = createMockMcpServer();
      registerAudienceTools(server as never);

      const fetchSpy = vi.fn();
      vi.stubGlobal("fetch", fetchSpy);

      const handler = server._registeredTools[CREATE_AUDIENCE_INDEX].handler;

      await expect(
        handler({
          account_id: "1564852554415330",
          name: "Test customer list",
          description: undefined,
          subtype: "CUSTOM",
          customer_file_source: undefined,
          retention_days: undefined,
          rule: undefined,
          prefill: undefined,
        }),
      ).rejects.toThrow(/customer_file_source/);

      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it("defaults to subtype=CUSTOM when caller passes customer_file_source without subtype (no rule)", async () => {
      const server = createMockMcpServer();
      registerAudienceTools(server as never);

      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockFetchResponse({ id: "9000126" })));

      const handler = server._registeredTools[CREATE_AUDIENCE_INDEX].handler;
      await handler({
        account_id: "1564852554415330",
        name: "Customer list (no explicit subtype)",
        description: undefined,
        subtype: undefined,
        customer_file_source: "USER_PROVIDED_ONLY",
        retention_days: undefined,
        rule: undefined,
        prefill: undefined,
      });

      const call = vi.mocked(fetch).mock.calls[0];
      const params = new URLSearchParams(String(call[1]?.body ?? ""));

      expect(params.get("subtype")).toBe("CUSTOM");
      expect(params.get("customer_file_source")).toBe("USER_PROVIDED_ONLY");
    });

    it("forwards subtype and customer_file_source for a customer-list audience", async () => {
      const server = createMockMcpServer();
      registerAudienceTools(server as never);

      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockFetchResponse({ id: "9000125" })));

      const handler = server._registeredTools[CREATE_AUDIENCE_INDEX].handler;
      await handler({
        account_id: "1564852554415330",
        name: "Customer list test",
        description: "seed list",
        subtype: "CUSTOM",
        customer_file_source: "USER_PROVIDED_ONLY",
        retention_days: 365,
        rule: undefined,
        prefill: undefined,
      });

      const call = vi.mocked(fetch).mock.calls[0];
      const params = new URLSearchParams(String(call[1]?.body ?? ""));

      expect(params.get("subtype")).toBe("CUSTOM");
      expect(params.get("customer_file_source")).toBe("USER_PROVIDED_ONLY");
      expect(params.get("description")).toBe("seed list");
      expect(params.get("retention_days")).toBe("365");
      expect(params.has("rule")).toBe(false);
    });
  });
});
