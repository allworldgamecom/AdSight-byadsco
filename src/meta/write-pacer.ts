import { logger } from "../utils/logger.js";

/**
 * Preventive self-pacing for Ads Management writes.
 *
 * Meta's BUC quota for Ads Management is tight in `development_access`:
 *   300 + 40 × active_ads per hour (standard)
 *   100 000 + 40 × active_ads per hour (advanced)
 *
 * We apply a token-bucket per (token, account) on POST/PUT/DELETE calls so a
 * burst of writes from an agent never blows the hourly quota. This is
 * independent of (and complementary to) the reactive `RateLimiter` that reads
 * response headers — the pacer prevents, the limiter reacts.
 */
type Tier = "development_access" | "standard_access";

interface Bucket {
  tokens: number;
  capacity: number;
  refillRatePerSec: number;
  lastRefillMs: number;
  activeAds: number;
  tier: Tier;
}

const DEFAULT_ACTIVE_ADS = 50;

export class WritePacer {
  private readonly buckets = new Map<string, Bucket>();

  /**
   * Record known active-ads count for an account (typically fed from an
   * Insights response). Allows tighter/wider pacing as volume changes.
   */
  updateActiveAds(
    tokenHash: string,
    accountId: string,
    activeAds: number,
  ): void {
    const key = pacerKey(tokenHash, accountId);
    const existing = this.buckets.get(key);
    if (existing) {
      existing.activeAds = activeAds;
      existing.refillRatePerSec = computeRate(existing.tier, activeAds);
      existing.capacity = Math.max(10, Math.round(existing.refillRatePerSec * 10));
    }
  }

  /**
   * Record the tier observed in a response header so pacing matches reality.
   */
  updateTier(tokenHash: string, accountId: string, tier: string): void {
    if (tier !== "development_access" && tier !== "standard_access") return;
    const key = pacerKey(tokenHash, accountId);
    const existing = this.buckets.get(key);
    if (existing && existing.tier !== tier) {
      existing.tier = tier;
      existing.refillRatePerSec = computeRate(tier, existing.activeAds);
      existing.capacity = tier === "standard_access" ? 50 : 10;
      logger.info(
        { event: "meta_write_pacer_tier", accountId, tier },
        "Write pacer adjusted to observed access tier",
      );
    }
  }

  /**
   * Block until a token is available in the bucket.
   */
  async acquire(tokenHash: string, accountId: string): Promise<void> {
    const bucket = this.getOrCreate(tokenHash, accountId);
    this.refill(bucket);

    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return;
    }

    // Compute wait to gain 1 token.
    const needed = 1 - bucket.tokens;
    const waitMs = Math.ceil((needed / bucket.refillRatePerSec) * 1000);
    logger.warn(
      {
        event: "meta_write_pacer_wait",
        accountId,
        waitMs,
        rateRps: bucket.refillRatePerSec,
        tier: bucket.tier,
      },
      "Write pacer delaying a write to stay under Ads Management quota",
    );
    await new Promise((resolve) => setTimeout(resolve, waitMs));
    this.refill(this.getOrCreate(tokenHash, accountId));
    bucket.tokens = Math.max(0, bucket.tokens - 1);
  }

  snapshot(): Array<{
    key: string;
    tokens: number;
    capacity: number;
    rateRps: number;
    tier: Tier;
  }> {
    return Array.from(this.buckets.entries()).map(([key, b]) => ({
      key,
      tokens: Math.round(b.tokens * 100) / 100,
      capacity: b.capacity,
      rateRps: Math.round(b.refillRatePerSec * 1000) / 1000,
      tier: b.tier,
    }));
  }

  reset(): void {
    this.buckets.clear();
  }

  private getOrCreate(tokenHash: string, accountId: string): Bucket {
    const key = pacerKey(tokenHash, accountId);
    let bucket = this.buckets.get(key);
    if (!bucket) {
      const tier: Tier = "development_access";
      const rate = computeRate(tier, DEFAULT_ACTIVE_ADS);
      bucket = {
        tokens: 10,
        capacity: 10,
        refillRatePerSec: rate,
        lastRefillMs: Date.now(),
        activeAds: DEFAULT_ACTIVE_ADS,
        tier,
      };
      this.buckets.set(key, bucket);
    }
    return bucket;
  }

  private refill(bucket: Bucket): void {
    const now = Date.now();
    const elapsedSec = (now - bucket.lastRefillMs) / 1000;
    if (elapsedSec <= 0) return;
    bucket.tokens = Math.min(
      bucket.capacity,
      bucket.tokens + elapsedSec * bucket.refillRatePerSec,
    );
    bucket.lastRefillMs = now;
  }
}

function computeRate(tier: Tier, activeAds: number): number {
  const hourly =
    tier === "standard_access"
      ? 100_000 + 40 * activeAds
      : 300 + 40 * activeAds;
  return hourly / 3600;
}

function pacerKey(tokenHash: string, accountId: string): string {
  return `${tokenHash}:${accountId}`;
}
