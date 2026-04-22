import { describe, it, expect, vi, beforeEach } from "vitest";
import { RateLimiter, type RequestContext } from "../../src/meta/rate-limiter.js";

describe("RateLimiter", () => {
  let limiter: RateLimiter;
  const ctx: RequestContext = { tokenHash: "tok1", accountId: "act_100" };
  const otherCtx: RequestContext = { tokenHash: "tok1", accountId: "act_999" };

  beforeEach(() => {
    limiter = new RateLimiter();
  });

  describe("getThrottleDelay", () => {
    it("returns 0 when no headers have been processed", () => {
      expect(limiter.getThrottleDelay(ctx)).toBe(0);
    });

    it("returns 0 when usage is below 75%", () => {
      limiter.updateFromHeaders(
        new Headers({
          "x-app-usage": JSON.stringify({
            call_count: 50,
            total_cputime: 30,
            total_time: 40,
          }),
        }),
        ctx,
      );
      expect(limiter.getThrottleDelay(ctx)).toBe(0);
    });

    it("returns linear backoff between 75-95%", () => {
      limiter.updateFromHeaders(
        new Headers({
          "x-app-usage": JSON.stringify({
            call_count: 85,
            total_cputime: 0,
            total_time: 0,
          }),
        }),
        ctx,
      );
      const delay = limiter.getThrottleDelay(ctx);
      expect(delay).toBeGreaterThan(0);
      expect(delay).toBeLessThan(2100);
    });

    it("returns higher delay above 95%", () => {
      limiter.updateFromHeaders(
        new Headers({
          "x-app-usage": JSON.stringify({
            call_count: 98,
            total_cputime: 0,
            total_time: 0,
          }),
        }),
        ctx,
      );
      expect(limiter.getThrottleDelay(ctx)).toBeGreaterThanOrEqual(5000);
    });

    it("honours estimated_time_to_regain_access from BUC header", () => {
      limiter.updateFromHeaders(
        new Headers({
          "x-business-use-case-usage": JSON.stringify({
            biz1: [
              {
                type: "ads_insights",
                call_count: 99,
                total_cputime: 0,
                total_time: 0,
                estimated_time_to_regain_access: 30, // minutes
                ads_api_access_tier: "development_access",
              },
            ],
          }),
        }),
        ctx,
      );
      // 30 minutes = 1_800_000 ms
      const delay = limiter.getThrottleDelay(ctx);
      expect(delay).toBeGreaterThan(1_700_000);
      expect(delay).toBeLessThanOrEqual(1_800_000);
    });
  });

  describe("per-account isolation", () => {
    it("does not apply one account's acc-scoped usage to another", () => {
      limiter.updateFromHeaders(
        new Headers({
          "x-ad-account-usage": JSON.stringify({
            acc_id_util_pct: 99,
            reset_time_duration: 600,
          }),
        }),
        ctx,
      );
      expect(limiter.getThrottleDelay(ctx)).toBeGreaterThan(0);
      expect(limiter.getThrottleDelay(otherCtx)).toBe(0);
    });

    it("insights throttle app-portion applies across accounts", () => {
      limiter.updateFromHeaders(
        new Headers({
          "x-fb-ads-insights-throttle": JSON.stringify({
            app_id_util_pct: 99,
            acc_id_util_pct: 50,
            ads_api_access_tier: "standard_access",
          }),
        }),
        ctx,
      );
      expect(limiter.getThrottleDelay(ctx)).toBeGreaterThan(0);
      expect(limiter.getThrottleDelay(otherCtx)).toBeGreaterThan(0);
    });
  });

  describe("updateFromHeaders", () => {
    it("reads x-business-use-case-usage across multiple businesses and types", () => {
      limiter.updateFromHeaders(
        new Headers({
          "x-business-use-case-usage": JSON.stringify({
            biz_a: [
              {
                type: "ads_insights",
                call_count: 40,
                total_cputime: 10,
                total_time: 10,
              },
            ],
            biz_b: [
              {
                type: "ads_management",
                call_count: 92,
                total_cputime: 10,
                total_time: 10,
              },
            ],
          }),
        }),
        ctx,
      );
      expect(limiter.snapshot()).toHaveLength(2);
      expect(limiter.getThrottleDelay(ctx)).toBeGreaterThan(0);
    });

    it("ignores malformed x-app-usage header", () => {
      limiter.updateFromHeaders(
        new Headers({ "x-app-usage": "not json" }),
        ctx,
      );
      expect(limiter.getThrottleDelay(ctx)).toBe(0);
    });

    it("handles missing headers gracefully", () => {
      limiter.updateFromHeaders(new Headers(), ctx);
      expect(limiter.getThrottleDelay(ctx)).toBe(0);
    });

    it("takes max delay across app and business usage for the same context", () => {
      limiter.updateFromHeaders(
        new Headers({
          "x-app-usage": JSON.stringify({
            call_count: 50,
            total_cputime: 0,
            total_time: 0,
          }),
          "x-business-use-case-usage": JSON.stringify({
            biz: [{ call_count: 80, total_cputime: 0, total_time: 0 }],
          }),
        }),
        ctx,
      );
      const delay = limiter.getThrottleDelay(ctx);
      // 80% sits in the linear staircase zone
      expect(delay).toBeGreaterThan(0);
    });
  });

  describe("markRetryAfter", () => {
    it("respects an explicitly recorded retry-after delay", () => {
      limiter.markRetryAfter(ctx, "ads_insights", 120_000);
      const delay = limiter.getThrottleDelay(ctx);
      expect(delay).toBeGreaterThan(100_000);
      expect(delay).toBeLessThanOrEqual(120_000);
    });

    it("does NOT apply a per-account retry-after to sibling accounts", () => {
      limiter.markRetryAfter(ctx, "ads_insights", 120_000);
      expect(limiter.getThrottleDelay(otherCtx)).toBe(0);
    });
  });

  describe("waitIfNeeded", () => {
    it("does not wait when usage is low", async () => {
      const start = Date.now();
      await limiter.waitIfNeeded(ctx);
      expect(Date.now() - start).toBeLessThan(50);
    });

    it("waits when usage is high", async () => {
      vi.useFakeTimers();
      limiter.updateFromHeaders(
        new Headers({
          "x-app-usage": JSON.stringify({
            call_count: 85,
            total_cputime: 0,
            total_time: 0,
          }),
        }),
        ctx,
      );

      const promise = limiter.waitIfNeeded(ctx);
      vi.advanceTimersByTime(2100);
      await promise;
      vi.useRealTimers();
    });
  });

  describe("snapshot", () => {
    it("returns an empty array initially", () => {
      expect(limiter.snapshot()).toEqual([]);
    });

    it("exposes parsed tier and retry-after for observability", () => {
      limiter.updateFromHeaders(
        new Headers({
          "x-business-use-case-usage": JSON.stringify({
            biz: [
              {
                type: "ads_management",
                call_count: 10,
                total_cputime: 5,
                total_time: 5,
                estimated_time_to_regain_access: 2,
                ads_api_access_tier: "development_access",
              },
            ],
          }),
        }),
        ctx,
      );
      const snap = limiter.snapshot();
      expect(snap).toHaveLength(1);
      expect(snap[0].adsApiAccessTier).toBe("development_access");
      expect(snap[0].estimatedTimeToRegainAccessMs).toBe(120_000);
    });
  });
});
