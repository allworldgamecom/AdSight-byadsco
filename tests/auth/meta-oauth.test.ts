import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  fetchPrimaryBusiness,
  fetchProfile,
  validateToken,
} from "../../src/auth/meta-oauth.js";
import { mockFetchResponse } from "../setup.js";

describe("fetchPrimaryBusiness", () => {
  beforeEach(() => {
    vi.spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns id and name for the first business", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(
      mockFetchResponse({
        data: [{ id: "1234567890", name: "Acme Corp" }],
      }),
    );

    const result = await fetchPrimaryBusiness("token-x", "v22.0");
    expect(result).toEqual({ id: "1234567890", name: "Acme Corp" });

    const url = vi.mocked(globalThis.fetch).mock.calls[0][0] as string;
    expect(url).toContain("/v22.0/me/businesses");
    expect(url).toContain("fields=id%2Cname");
    expect(url).toContain("limit=1");
    expect(url).toContain("access_token=token-x");
  });

  it("returns null when the businesses list is empty", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(
      mockFetchResponse({ data: [] }),
    );

    const result = await fetchPrimaryBusiness("token-x");
    expect(result).toBeNull();
  });

  it("returns null when the API responds with an error (missing permission)", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(
      mockFetchResponse(
        {
          error: {
            message:
              "(#200) Permissions error: business_management is required",
          },
        },
        { status: 400 },
      ),
    );

    const result = await fetchPrimaryBusiness("token-no-perm");
    expect(result).toBeNull();
  });

  it("returns null when the network call throws", async () => {
    vi.mocked(globalThis.fetch).mockRejectedValueOnce(new Error("network down"));

    const result = await fetchPrimaryBusiness("token-x");
    expect(result).toBeNull();
  });

  it("preserves the id and tolerates a missing name", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(
      mockFetchResponse({ data: [{ id: "9999" }] }),
    );

    const result = await fetchPrimaryBusiness("token-x");
    expect(result).toEqual({ id: "9999", name: null });
  });
});

// INV-A: direct Graph fetches in meta-oauth must refuse in token-free mode
// (red-team FINDING-1/-9). Guard runs before any fetch().
describe("meta-oauth token-free guard (INV-A)", () => {
  beforeEach(() => {
    vi.spyOn(globalThis, "fetch");
    process.env.ADSIGHT_GW_MODE = "token-free";
  });

  afterEach(() => {
    delete process.env.ADSIGHT_GW_MODE;
    vi.restoreAllMocks();
  });

  it("fetchProfile throws and never calls fetch in token-free", async () => {
    await expect(fetchProfile("any-token")).rejects.toThrow(/token-free.*INV-A/);
    expect(vi.mocked(globalThis.fetch)).not.toHaveBeenCalled();
  });

  it("fetchPrimaryBusiness throws and never calls fetch in token-free", async () => {
    await expect(fetchPrimaryBusiness("any-token")).rejects.toThrow(
      /token-free.*INV-A/,
    );
    expect(vi.mocked(globalThis.fetch)).not.toHaveBeenCalled();
  });

  it("validateToken reports invalid (guard surfaces via fetchProfile) without hitting Graph", async () => {
    const result = await validateToken("any-token");
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/token-free.*INV-A/);
    expect(vi.mocked(globalThis.fetch)).not.toHaveBeenCalled();
  });
});
