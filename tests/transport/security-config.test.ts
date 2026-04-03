import { afterEach, describe, expect, it } from "vitest";
import { resolveSecurityConfig } from "../../src/transport/security-config.js";

const originalEnv = {
  NODE_ENV: process.env.NODE_ENV,
  OAUTH_APPROVAL_PIN: process.env.OAUTH_APPROVAL_PIN,
  OAUTH_SECRET: process.env.OAUTH_SECRET,
};

describe("resolveSecurityConfig", () => {
  afterEach(() => {
    if (originalEnv.NODE_ENV === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = originalEnv.NODE_ENV;
    }

    if (originalEnv.OAUTH_APPROVAL_PIN === undefined) {
      delete process.env.OAUTH_APPROVAL_PIN;
    } else {
      process.env.OAUTH_APPROVAL_PIN = originalEnv.OAUTH_APPROVAL_PIN;
    }

    if (originalEnv.OAUTH_SECRET === undefined) {
      delete process.env.OAUTH_SECRET;
    } else {
      process.env.OAUTH_SECRET = originalEnv.OAUTH_SECRET;
    }
  });

  it("throws in production when OAUTH_APPROVAL_PIN is missing", () => {
    process.env.NODE_ENV = "production";
    delete process.env.OAUTH_APPROVAL_PIN;
    process.env.OAUTH_SECRET = "test-secret";

    expect(() => resolveSecurityConfig()).toThrow(
      /OAUTH_APPROVAL_PIN environment variable is required in production/,
    );
  });

  it("throws in production when OAUTH_APPROVAL_PIN is empty", () => {
    process.env.NODE_ENV = "production";
    process.env.OAUTH_APPROVAL_PIN = "   ";
    process.env.OAUTH_SECRET = "test-secret";

    expect(() => resolveSecurityConfig()).toThrow(
      /OAUTH_APPROVAL_PIN environment variable is required in production/,
    );
  });

  it("throws in production when OAUTH_APPROVAL_PIN is too short", () => {
    process.env.NODE_ENV = "production";
    process.env.OAUTH_APPROVAL_PIN = "123";
    process.env.OAUTH_SECRET = "test-secret";

    expect(() => resolveSecurityConfig()).toThrow(
      /OAUTH_APPROVAL_PIN must be at least 4 characters in production/,
    );
  });

  it("throws in production when OAUTH_SECRET is missing", () => {
    process.env.NODE_ENV = "production";
    process.env.OAUTH_APPROVAL_PIN = "1234";
    delete process.env.OAUTH_SECRET;

    expect(() => resolveSecurityConfig()).toThrow(
      /OAUTH_SECRET environment variable is required in production/,
    );
  });

  it("allows missing PIN outside production", () => {
    process.env.NODE_ENV = "development";
    delete process.env.OAUTH_APPROVAL_PIN;
    delete process.env.OAUTH_SECRET;

    expect(resolveSecurityConfig()).toEqual({
      approvalPin: "",
      pinRequired: false,
    });
  });

  it("requires PIN UI outside production when a PIN is configured", () => {
    process.env.NODE_ENV = "development";
    process.env.OAUTH_APPROVAL_PIN = "1234";
    delete process.env.OAUTH_SECRET;

    expect(resolveSecurityConfig()).toEqual({
      approvalPin: "1234",
      pinRequired: true,
    });
  });
});
