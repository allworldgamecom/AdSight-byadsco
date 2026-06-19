import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  mapMoneyAction,
  GatewayWriteClient,
  GatewayWriteError,
  ReadDisabledError,
  isTokenFreeMode,
  validateGatewayUrl,
  resetGatewayWriteClientForTests,
} from "../../src/meta/gateway-client.js";

describe("mapMoneyAction — raw Graph write → typed gateway action", () => {
  it("POST /act_X/campaigns → publish_campaign", () => {
    const r = mapMoneyAction("POST", "/act_123/campaigns", { name: "c", daily_budget: 5000 });
    expect(r?.action).toBe("publish_campaign");
    expect(r?.target).toBe("act_123");
    expect(r?.costCents).toBe(5000);
  });

  it("POST /act_X/adsets → publish_adset", () => {
    const r = mapMoneyAction("POST", "/act_123/adsets", { name: "a", daily_budget: 2000 });
    expect(r?.action).toBe("publish_adset");
    expect(r?.costCents).toBe(2000);
  });

  it("POST /act_X/ads → null (нет publish_ad money-резерва в v1 → DENY)", () => {
    const r = mapMoneyAction("POST", "/act_123/ads", { name: "ad", adset_id: "1" });
    expect(r).toBeNull();
  });

  it("POST /act_X {spend_cap} → set_spend_cap", () => {
    const r = mapMoneyAction("POST", "/act_123", { spend_cap: 100000 });
    expect(r?.action).toBe("set_spend_cap");
    expect(r?.target).toBe("act_123");
  });

  it("POST /{id} {status:ACTIVE} → activate_campaign (gateway сам hard-reject)", () => {
    const r = mapMoneyAction("POST", "/9988", { status: "ACTIVE" });
    expect(r?.action).toBe("activate_campaign");
    expect(r?.body.campaign_id).toBe("9988");
  });

  it("POST /{id} {status:PAUSED} → pause_campaign", () => {
    const r = mapMoneyAction("POST", "/9988", { status: "PAUSED" });
    expect(r?.action).toBe("pause_campaign");
    expect(r?.costCents).toBe(0);
  });

  it("POST /{id} {daily_budget} (без status) → scale_budget", () => {
    const r = mapMoneyAction("POST", "/9988", { daily_budget: 7000 });
    expect(r?.action).toBe("scale_budget");
    expect(r?.costCents).toBe(7000);
    expect(r?.body.campaign_id).toBe("9988");
  });

  it("DELETE → null (gateway v1 знает pause_*, не delete_* → DENY)", () => {
    expect(mapMoneyAction("DELETE", "/9988", {})).toBeNull();
  });

  it("money по флагу, путь не распознан → null (fail-safe DENY)", () => {
    const r = mapMoneyAction("POST", "/a/b/c/d", { daily_budget: 1 });
    expect(r).toBeNull();
  });
});

describe("isTokenFreeMode flag", () => {
  const orig = process.env.ADSIGHT_GW_MODE;
  afterEach(() => {
    if (orig === undefined) delete process.env.ADSIGHT_GW_MODE;
    else process.env.ADSIGHT_GW_MODE = orig;
  });
  it("default (unset) = direct → false", () => {
    delete process.env.ADSIGHT_GW_MODE;
    expect(isTokenFreeMode()).toBe(false);
  });
  it("token-free → true", () => {
    process.env.ADSIGHT_GW_MODE = "token-free";
    expect(isTokenFreeMode()).toBe(true);
  });
});

describe("GatewayWriteClient.route — endpoint selection + HTTP", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let client: GatewayWriteClient;
  const calls: { url: string; body: any }[] = [];

  beforeEach(() => {
    calls.length = 0;
    resetGatewayWriteClientForTests();
    fetchMock = vi.fn(async (url: string, opts: any) => {
      calls.push({ url, body: JSON.parse(opts.body) });
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true, requestId: "rid" }),
      } as any;
    });
    vi.stubGlobal("fetch", fetchMock);
    client = new GatewayWriteClient({
      url: "http://127.0.0.1:8787",
      apiKey: "k",
      session: "S-traffic_specialist",
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("GET → ReadDisabledError (без сети)", async () => {
    await expect(client.route("GET", "/act_1/campaigns")).rejects.toBeInstanceOf(ReadDisabledError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("money create → /v1/act с правильными заголовками", async () => {
    await client.route("POST", "/act_1/campaigns", { name: "c", daily_budget: 1000 });
    expect(calls[0].url).toBe("http://127.0.0.1:8787/v1/act");
    expect(calls[0].body.action).toBe("publish_campaign");
    const hdrs = fetchMock.mock.calls[0][1].headers;
    expect(hdrs["X-AdSight-Key"]).toBe("k");
    expect(hdrs["X-AdSight-Session"]).toBe("S-traffic_specialist");
  });

  it("non-money write → /v1/meta raw pass", async () => {
    await client.route("POST", "/act_1/adcreatives", { name: "cr", object_story_spec: {} });
    expect(calls[0].url).toBe("http://127.0.0.1:8787/v1/meta");
    expect(calls[0].body.method).toBe("POST");
    expect(calls[0].body.path).toBe("/act_1/adcreatives");
  });

  it("money, не маппится → локальный DENY 403 unmappedMoney (НЕ шлёт raw в /v1/meta)", async () => {
    // /act_1/ads money-create без publish_ad → null → DENY, сеть не дёргается
    await expect(client.route("POST", "/act_1/ads", { name: "ad", status: "ACTIVE" })).rejects.toMatchObject({
      status: 403,
      enforced: "unmappedMoney",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("gateway 403 hitl → GatewayWriteError проброшен наверх", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 403,
      json: async () => ({ error: "hitl required", enforced: "hitl", requestId: "r2" }),
    } as any);
    await expect(client.route("POST", "/9988", { daily_budget: 5000 })).rejects.toMatchObject({
      status: 403,
      enforced: "hitl",
    });
  });

  it("DELETE → unmappedMoney DENY (нет delete_* в v1)", async () => {
    await expect(client.route("DELETE", "/9988", {})).rejects.toMatchObject({
      status: 403,
      enforced: "unmappedMoney",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ── AUDIT-3 additions ─────────────────────────────────────────────────────
describe("AUDIT-3 MAJOR-B — fail-closed mode parsing", () => {
  const orig = process.env.ADSIGHT_GW_MODE;
  afterEach(() => {
    if (orig === undefined) delete process.env.ADSIGHT_GW_MODE;
    else process.env.ADSIGHT_GW_MODE = orig;
  });
  it("' token-free ' (whitespace) -> true (trim), NOT direct", () => {
    process.env.ADSIGHT_GW_MODE = " token-free ";
    expect(isTokenFreeMode()).toBe(true);
  });
  it("'TOKEN-FREE' (upper) -> true", () => {
    process.env.ADSIGHT_GW_MODE = "TOKEN-FREE";
    expect(isTokenFreeMode()).toBe(true);
  });
  it("'direct' -> false", () => {
    process.env.ADSIGHT_GW_MODE = "direct";
    expect(isTokenFreeMode()).toBe(false);
  });
  it("'token_free' (typo) -> THROW (fail-closed, not silent direct)", () => {
    process.env.ADSIGHT_GW_MODE = "token_free";
    expect(() => isTokenFreeMode()).toThrow();
  });
  it("'garbage' -> THROW", () => {
    process.env.ADSIGHT_GW_MODE = "garbage";
    expect(() => isTokenFreeMode()).toThrow();
  });
});

describe("AUDIT-3 MAJOR-A — recursive money classifier (endpoint selection)", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let client: GatewayWriteClient;
  const calls: { url: string; body: any }[] = [];
  beforeEach(() => {
    calls.length = 0;
    resetGatewayWriteClientForTests();
    fetchMock = vi.fn(async (url: string, opts: any) => {
      calls.push({ url, body: JSON.parse(opts.body) });
      return { ok: true, status: 200, json: async () => ({ ok: true }) } as any;
    });
    vi.stubGlobal("fetch", fetchMock);
    client = new GatewayWriteClient({ url: "http://127.0.0.1:8787", apiKey: "k", session: "S-traffic_specialist" });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("nested money {object_story_spec:{daily_budget}} on /{id} -> /v1/act (not raw /v1/meta)", async () => {
    await client.route("POST", "/9988", { object_story_spec: { daily_budget: 100 } });
    expect(calls[0].url).toContain("/v1/act");
  });
  it("JSON-string structured money {asset_feed_spec} -> /v1/act", async () => {
    await client.route("POST", "/9988", { asset_feed_spec: JSON.stringify({ bid_amount: 5 }) });
    expect(calls[0].url).toContain("/v1/act");
  });
  it("unparseable structured-blob -> fail-closed money -> /v1/act", async () => {
    await client.route("POST", "/9988", { targeting: "{not-json" });
    expect(calls[0].url).toContain("/v1/act");
  });
  it("status UNPAUSED -> activation -> /v1/act (not raw)", async () => {
    await client.route("POST", "/9988", { status: "UNPAUSED" });
    expect(calls[0].url).toContain("/v1/act");
  });
  it("control-key {batch:[...]} -> money -> /v1/act (path isolation)", async () => {
    await client.route("POST", "/9988", { batch: [{ method: "POST" }] });
    expect(calls[0].url).toContain("/v1/act");
  });
  it("clean non-money creative -> /v1/meta", async () => {
    await client.route("POST", "/act_1/adcreatives", { name: "cr", title: "hi" });
    expect(calls[0].url).toContain("/v1/meta");
  });
});

describe("AUDIT-3 whitespace status bypass", () => {
  it("status ' ACTIVE ' (padding) -> activate_campaign (not non-money)", () => {
    const r = mapMoneyAction("POST", "/9988", { status: " ACTIVE " });
    expect(r?.action).toBe("activate_campaign");
  });
  it("status 'active' (lower) -> activate_campaign", () => {
    const r = mapMoneyAction("POST", "/9988", { status: "active" });
    expect(r?.action).toBe("activate_campaign");
  });
});

describe("AUDIT-3 MAJOR-C — budgetCents = MAX over all budget keys", () => {
  it("{daily_budget:1, lifetime_budget:100000} -> costCents=100000 (not first-match 1)", () => {
    const r = mapMoneyAction("POST", "/act_1/campaigns", { daily_budget: 1, lifetime_budget: 100000 });
    expect(r?.costCents).toBe(100000);
  });
});

describe("AUDIT-3 MAJOR-E — reserve aliases *_cents for gateway reserve", () => {
  it("publish_campaign {daily_budget:'5000'} (string) -> body.daily_budget_cents=5000 (int)", () => {
    const r = mapMoneyAction("POST", "/act_1/campaigns", { daily_budget: "5000" });
    expect(r?.body.daily_budget_cents).toBe(5000);
    expect(r?.body.daily_budget).toBe("5000");
  });
  it("does not overwrite existing daily_budget_cents", () => {
    const r = mapMoneyAction("POST", "/act_1/campaigns", { daily_budget: "5000", daily_budget_cents: 4000 });
    expect(r?.body.daily_budget_cents).toBe(4000);
  });
});

describe("AUDIT-3 MINOR-1 — validateGatewayUrl", () => {
  it("http loopback ok", () => {
    expect(validateGatewayUrl("http://127.0.0.1:8787")).toBe("http://127.0.0.1:8787");
    expect(validateGatewayUrl("http://localhost:8787/")).toBe("http://localhost:8787");
  });
  it("https any host ok", () => {
    expect(validateGatewayUrl("https://gw.example.com")).toBe("https://gw.example.com");
  });
  it("http non-loopback -> throw", () => {
    expect(() => validateGatewayUrl("http://evil.example.com")).toThrow(/loopback/);
  });
  it("userinfo -> throw", () => {
    expect(() => validateGatewayUrl("https://user:pass@gw.example.com")).toThrow(/userinfo/);
  });
  it("query/fragment -> throw", () => {
    expect(() => validateGatewayUrl("https://gw.example.com?x=1")).toThrow(/query/);
  });
  it("non-http(s) protocol -> throw", () => {
    expect(() => validateGatewayUrl("ftp://gw.example.com")).toThrow();
  });
  it("GatewayWriteClient constructor rejects bad URL", () => {
    expect(() => new GatewayWriteClient({ url: "http://evil.example.com", apiKey: "k", session: "s" })).toThrow();
  });
});
