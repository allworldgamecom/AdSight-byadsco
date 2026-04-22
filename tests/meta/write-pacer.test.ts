import { describe, it, expect, beforeEach } from "vitest";
import { WritePacer } from "../../src/meta/write-pacer.js";

describe("WritePacer", () => {
  let pacer: WritePacer;

  beforeEach(() => {
    pacer = new WritePacer();
  });

  it("allows an initial burst up to capacity without blocking", async () => {
    const start = Date.now();
    await pacer.acquire("tok", "act_1");
    await pacer.acquire("tok", "act_1");
    await pacer.acquire("tok", "act_1");
    expect(Date.now() - start).toBeLessThan(100);
  });

  it("reports separate buckets per (token, account)", async () => {
    await pacer.acquire("tok", "act_1");
    await pacer.acquire("tok", "act_2");
    const snap = pacer.snapshot();
    expect(snap).toHaveLength(2);
    expect(snap.map((b) => b.key).sort()).toEqual(["tok:act_1", "tok:act_2"]);
  });

  it("adjusts rate when tier upgrades to standard_access", async () => {
    await pacer.acquire("tok", "act_1");
    pacer.updateTier("tok", "act_1", "standard_access");
    const snap = pacer.snapshot()[0];
    expect(snap.tier).toBe("standard_access");
    expect(snap.rateRps).toBeGreaterThan(1); // standard = (100_000 + 40*50)/3600
  });

  it("ignores unknown tier strings", async () => {
    await pacer.acquire("tok", "act_1");
    pacer.updateTier("tok", "act_1", "nonsense_tier");
    expect(pacer.snapshot()[0].tier).toBe("development_access");
  });
});
