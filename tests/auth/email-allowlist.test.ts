import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  isAllowed,
  isAllowlistConfigured,
} from "../../src/auth/email-allowlist.js";

const KEYS = [
  "AUTH_ALLOWED_EMAILS",
  "AUTH_ALLOWED_DOMAINS",
  "AUTH_ALLOWED_FB_USER_IDS",
  "NODE_ENV",
] as const;

const original: Record<(typeof KEYS)[number], string | undefined> =
  Object.fromEntries(KEYS.map((k) => [k, process.env[k]])) as Record<
    (typeof KEYS)[number],
    string | undefined
  >;

describe("email-allowlist", () => {
  beforeEach(() => {
    for (const k of KEYS) delete process.env[k];
  });

  afterEach(() => {
    for (const k of KEYS) {
      if (original[k] === undefined) delete process.env[k];
      else process.env[k] = original[k];
    }
  });

  it("matches by exact email (case-insensitive)", () => {
    process.env.AUTH_ALLOWED_EMAILS = "alice@x.com,bob@y.com";
    expect(isAllowed({ email: "Alice@X.com" })).toBe(true);
    expect(isAllowed({ email: "carol@x.com" })).toBe(false);
  });

  it("matches by domain", () => {
    process.env.AUTH_ALLOWED_DOMAINS = "byads.co";
    expect(isAllowed({ email: "anyone@byads.co" })).toBe(true);
    expect(isAllowed({ email: "anyone@byads.com" })).toBe(false);
  });

  it("matches by FB user id", () => {
    process.env.AUTH_ALLOWED_FB_USER_IDS = "1001,1002";
    expect(isAllowed({ fbUserId: "1001" })).toBe(true);
    expect(isAllowed({ fbUserId: "9999" })).toBe(false);
  });

  it("rejects everyone when no allowlist source is set in production", () => {
    process.env.NODE_ENV = "production";
    expect(isAllowed({ email: "alice@x.com" })).toBe(false);
  });

  it("allows everyone when no allowlist is set outside production (dev convenience)", () => {
    process.env.NODE_ENV = "development";
    expect(isAllowed({ email: "alice@x.com" })).toBe(true);
  });

  it("isAllowlistConfigured reflects env state", () => {
    expect(isAllowlistConfigured()).toBe(false);
    process.env.AUTH_ALLOWED_EMAILS = "x@y.com";
    expect(isAllowlistConfigured()).toBe(true);
  });
});
