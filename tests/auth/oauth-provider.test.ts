import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Response } from "express";
import {
  oauthProvider,
  resetOAuthProviderForTests,
} from "../../src/auth/oauth-provider.js";
import type { OAuthClientInformationFull } from "@modelcontextprotocol/sdk/shared/auth.js";

const original = process.env.OAUTH_SECRET;

const fakeClient: OAuthClientInformationFull = {
  client_id: "test-client",
  client_name: "Test",
  redirect_uris: ["https://example.com/cb"],
  grant_types: ["authorization_code", "refresh_token"],
  response_types: ["code"],
  token_endpoint_auth_method: "none",
  client_id_issued_at: Math.floor(Date.now() / 1000),
};

function fakeRes(): Response {
  const stub = {
    redirect: vi.fn(),
  } as unknown as Response;
  return stub;
}

describe("MetaAdsOAuthProvider", () => {
  beforeEach(() => {
    process.env.OAUTH_SECRET = "x".repeat(64);
    resetOAuthProviderForTests();
  });

  afterEach(() => {
    if (original === undefined) delete process.env.OAUTH_SECRET;
    else process.env.OAUTH_SECRET = original;
    resetOAuthProviderForTests();
  });

  it("issues a code that can be exchanged for tokens including fb_user_id (and never the token name)", async () => {
    oauthProvider.configure({
      resolvePendingAuth: () => ({ fbUserId: "fb-1234" }),
    });

    const res = fakeRes();
    await oauthProvider.authorize(
      fakeClient,
      {
        codeChallenge: "ch",
        codeChallengeMethod: "S256",
        redirectUri: "https://example.com/cb",
        scopes: [],
      },
      res,
    );

    expect((res.redirect as never as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(
      1,
    );
    const redirected = (res.redirect as never as ReturnType<typeof vi.fn>).mock
      .calls[0][1] as string;
    const url = new URL(redirected);
    const code = url.searchParams.get("code");
    expect(code).toBeTruthy();

    const tokens = await oauthProvider.exchangeAuthorizationCode(
      fakeClient,
      code!,
    );
    expect(tokens.access_token).toBeTruthy();

    const authInfo = await oauthProvider.verifyAccessToken(tokens.access_token);
    expect(authInfo.clientId).toBe("test-client");
    expect((authInfo.extra as { fbUserId?: string } | undefined)?.fbUserId).toBe(
      "fb-1234",
    );
    expect(
      (authInfo.extra as Record<string, unknown> | undefined)?.metaTokenName,
    ).toBeUndefined();
  });

  it("rejects auth code that was issued to a different client", async () => {
    const res = fakeRes();
    await oauthProvider.authorize(
      fakeClient,
      {
        codeChallenge: "ch",
        codeChallengeMethod: "S256",
        redirectUri: "https://example.com/cb",
        scopes: [],
      },
      res,
    );
    const code = new URL(
      (res.redirect as never as ReturnType<typeof vi.fn>).mock.calls[0][1],
    ).searchParams.get("code")!;

    const otherClient: OAuthClientInformationFull = {
      ...fakeClient,
      client_id: "other-client",
    };

    await expect(
      oauthProvider.exchangeAuthorizationCode(otherClient, code),
    ).rejects.toThrow(/different client/);
  });

  it("preserves fb_user_id across refresh-token exchange (token name is never in the JWT)", async () => {
    oauthProvider.configure({
      resolvePendingAuth: () => ({ fbUserId: "fb-9999" }),
    });
    const res = fakeRes();
    await oauthProvider.authorize(
      fakeClient,
      {
        codeChallenge: "ch",
        codeChallengeMethod: "S256",
        redirectUri: "https://example.com/cb",
        scopes: [],
      },
      res,
    );
    const code = new URL(
      (res.redirect as never as ReturnType<typeof vi.fn>).mock.calls[0][1],
    ).searchParams.get("code")!;
    const tokens = await oauthProvider.exchangeAuthorizationCode(
      fakeClient,
      code,
    );

    const refreshed = await oauthProvider.exchangeRefreshToken(
      fakeClient,
      tokens.refresh_token!,
    );
    const authInfo = await oauthProvider.verifyAccessToken(refreshed.access_token);
    expect((authInfo.extra as { fbUserId?: string } | undefined)?.fbUserId).toBe(
      "fb-9999",
    );
    expect(
      (authInfo.extra as Record<string, unknown> | undefined)?.metaTokenName,
    ).toBeUndefined();
  });
});
