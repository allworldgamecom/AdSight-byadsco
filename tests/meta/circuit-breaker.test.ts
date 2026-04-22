import { describe, it, expect, beforeEach, vi } from "vitest";
import { CircuitBreaker } from "../../src/meta/circuit-breaker.js";
import { classifyMetaError } from "../../src/meta/errors.js";

describe("CircuitBreaker", () => {
  let cb: CircuitBreaker;
  const ctx = { tokenHash: "tok1", accountId: "act_1", type: "ads_insights" };
  const otherAccount = { tokenHash: "tok1", accountId: "act_2", type: "ads_insights" };
  const otherType = { tokenHash: "tok1", accountId: "act_1", type: "ads_management" };

  beforeEach(() => {
    cb = new CircuitBreaker();
  });

  it("starts closed", () => {
    expect(() => cb.assertClosed(ctx)).not.toThrow();
  });

  it("opens for 60 min on abuse signal (subcode 1996)", () => {
    const cls = classifyMetaError({
      code: 613,
      error_subcode: 1996,
      message: "Inconsistent request volume detected",
      type: "OAuthException",
    });
    cb.trip(ctx, cls);
    expect(() => cb.assertClosed(ctx)).toThrow(/Circuit open/);
    const snap = cb.snapshot()[0];
    expect(snap.reason).toBe("abuse_signal");
    expect(snap.openUntil).toBeGreaterThan(Date.now() + 59 * 60 * 1000);
  });

  it("does NOT open on first throttle without retry-after hint", () => {
    const cls = classifyMetaError({
      code: 80004,
      message: "Ads Management throttled",
      type: "OAuthException",
    });
    cb.trip(ctx, cls);
    expect(() => cb.assertClosed(ctx)).not.toThrow();
  });

  it("opens after 3 throttle events within 5 minutes", () => {
    const cls = classifyMetaError({
      code: 4,
      message: "rate limit",
      type: "OAuthException",
    });
    cb.trip(ctx, cls);
    cb.trip(ctx, cls);
    expect(() => cb.assertClosed(ctx)).not.toThrow();
    cb.trip(ctx, cls);
    expect(() => cb.assertClosed(ctx)).toThrow(/Circuit open/);
  });

  it("honours retry-after hint from global insights rate limit", () => {
    const cls = classifyMetaError({
      code: 4,
      error_subcode: 1504022,
      message: "global rate",
      type: "OAuthException",
    });
    cb.trip(ctx, cls);
    expect(() => cb.assertClosed(ctx)).toThrow(/Circuit open/);
  });

  it("isolates circuits per (account, type)", () => {
    const cls = classifyMetaError({
      code: 613,
      error_subcode: 1996,
      message: "abuse",
      type: "OAuthException",
    });
    cb.trip(ctx, cls);
    expect(() => cb.assertClosed(ctx)).toThrow();
    expect(() => cb.assertClosed(otherAccount)).not.toThrow();
    expect(() => cb.assertClosed(otherType)).not.toThrow();
  });

  it("auto-closes after openUntil passes", () => {
    vi.useFakeTimers();
    const cls = classifyMetaError({
      code: 4,
      error_subcode: 1504022,
      message: "global rate",
      type: "OAuthException",
    });
    cb.trip(ctx, cls);
    expect(() => cb.assertClosed(ctx)).toThrow();

    vi.advanceTimersByTime(3 * 60 * 1000); // > 2 min cooldown
    expect(() => cb.assertClosed(ctx)).not.toThrow();
    vi.useRealTimers();
  });
});
