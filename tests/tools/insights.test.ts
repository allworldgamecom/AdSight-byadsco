import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { registerInsightsTools } from "../../src/tools/insights.js";
import { createMockMcpServer, setupTestToken, cleanupTestToken, mockFetchResponse } from "../setup.js";

describe("registerInsightsTools", () => {
  beforeEach(() => {
    setupTestToken();
  });

  afterEach(() => {
    cleanupTestToken();
    vi.restoreAllMocks();
  });

  it("registers exactly 1 tool (account_insights replaced by insights view in v3)", () => {
    const server = createMockMcpServer();
    registerInsightsTools(server as never);
    expect(server.registerTool).toHaveBeenCalledTimes(1);
  });

  it("registers tool with correct name", () => {
    const server = createMockMcpServer();
    registerInsightsTools(server as never);
    const names = server._registeredTools.map((t) => t.name);
    expect(names).toEqual(["ads_get_insights"]);
  });

  describe("ads_get_insights handler", () => {
    it("returns formatted insights data", async () => {
      const server = createMockMcpServer();
      registerInsightsTools(server as never);

      const mockData = {
        data: [
          {
            date_start: "2024-01-01",
            date_stop: "2024-01-31",
            impressions: "50000",
            reach: "25000",
            clicks: "1500",
            spend: "250.50",
            ctr: "3.00",
            cpc: "0.17",
            cpm: "5.01",
          },
        ],
      };

      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockFetchResponse(mockData)));

      const handler = server._registeredTools[0].handler;
      const result = await handler({
        object_id: "100123",
        level: undefined,
        time_range: undefined,
        date_preset: "last_30d",
        breakdowns: undefined,
        fields: undefined,
        action_attribution_windows: undefined,
        time_increment: undefined,
        limit: 100,
      }) as { content: Array<{ type: string; text: string }> };

      expect(result.content[0].text).toContain("2024-01-01");
      expect(result.content[0].text).toContain("50,000");
      expect(result.content[0].text).toContain("$250.50");
    });

    it("handles empty insights", async () => {
      const server = createMockMcpServer();
      registerInsightsTools(server as never);

      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockFetchResponse({ data: [] })));

      const handler = server._registeredTools[0].handler;
      const result = await handler({
        object_id: "100123",
        level: undefined,
        time_range: undefined,
        date_preset: undefined,
        breakdowns: undefined,
        fields: undefined,
        action_attribution_windows: undefined,
        time_increment: undefined,
        limit: 100,
      }) as { content: Array<{ type: string; text: string }> };

      expect(result.content[0].text).toContain("No insights data available");
    });

    it("includes actions in summary", async () => {
      const server = createMockMcpServer();
      registerInsightsTools(server as never);

      const mockData = {
        data: [
          {
            date_start: "2024-01-01",
            date_stop: "2024-01-31",
            impressions: "1000",
            actions: [
              { action_type: "link_click", value: "50" },
              { action_type: "purchase", value: "10" },
            ],
          },
        ],
      };

      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockFetchResponse(mockData)));

      const handler = server._registeredTools[0].handler;
      const result = await handler({
        object_id: "100123",
        level: undefined,
        time_range: undefined,
        date_preset: undefined,
        breakdowns: undefined,
        fields: undefined,
        action_attribution_windows: undefined,
        time_increment: undefined,
        limit: 100,
      }) as { content: Array<{ type: string; text: string }> };

      expect(result.content[0].text).toContain("link_click");
      expect(result.content[0].text).toContain("purchase");
    });
  });
});
