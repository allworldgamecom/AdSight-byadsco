import crypto from "node:crypto";
import { SignJWT, jwtVerify } from "jose";
import type { Response } from "express";
import type {
  OAuthServerProvider,
  AuthorizationParams,
} from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type {
  OAuthClientInformationFull,
  OAuthTokens,
  OAuthTokenRevocationRequest,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import { logger } from "../utils/logger.js";
import {
  InMemoryAuthCodesStore,
  type AuthCodesStore,
} from "../store/persistent-auth-codes.js";
import { InMemoryClientsStore } from "../store/persistent-clients-store.js";

let cachedSecret: Uint8Array | undefined;

function getJwtSecret(): Uint8Array {
  if (cachedSecret) return cachedSecret;

  const secret = process.env.OAUTH_SECRET;
  if (secret) {
    cachedSecret = new TextEncoder().encode(secret);
    return cachedSecret;
  }

  if (process.env.NODE_ENV === "production") {
    throw new Error("OAUTH_SECRET environment variable is required in production");
  }

  logger.warn("OAUTH_SECRET not set; generating random secret (tokens won't survive restart)");
  const randomSecret = crypto.randomBytes(32).toString("hex");
  process.env.OAUTH_SECRET = randomSecret;
  cachedSecret = new TextEncoder().encode(randomSecret);
  return cachedSecret;
}

export interface PendingAuthSession {
  fbUserId: string;
  metaTokenName: string;
}

export class MetaAdsOAuthProvider implements OAuthServerProvider {
  private clientsStoreImpl: OAuthRegisteredClientsStore = new InMemoryClientsStore();
  private authCodesImpl: AuthCodesStore = new InMemoryAuthCodesStore();
  private pendingAuthResolver: () => PendingAuthSession | null = () => null;

  configure(opts: {
    clientsStore?: OAuthRegisteredClientsStore;
    authCodesStore?: AuthCodesStore;
    resolvePendingAuth?: () => PendingAuthSession | null;
  }): void {
    if (opts.clientsStore) this.clientsStoreImpl = opts.clientsStore;
    if (opts.authCodesStore) this.authCodesImpl = opts.authCodesStore;
    if (opts.resolvePendingAuth) this.pendingAuthResolver = opts.resolvePendingAuth;
  }

  get clientsStore(): OAuthRegisteredClientsStore {
    return this.clientsStoreImpl;
  }

  async authorize(
    client: OAuthClientInformationFull,
    params: AuthorizationParams,
    res: Response,
  ): Promise<void> {
    const code = crypto.randomBytes(32).toString("hex");
    const pending = this.pendingAuthResolver();

    await this.authCodesImpl.set(code, {
      clientId: client.client_id,
      codeChallenge: params.codeChallenge,
      redirectUri: params.redirectUri,
      resource: params.resource?.href,
      fbUserId: pending?.fbUserId,
      metaTokenName: pending?.metaTokenName,
      expiresAt: Math.floor(Date.now() / 1000) + 600,
    });

    const redirectUrl = new URL(params.redirectUri);
    redirectUrl.searchParams.set("code", code);
    if (params.state) {
      redirectUrl.searchParams.set("state", params.state);
    }

    logger.info(
      { clientId: client.client_id, fbUserId: pending?.fbUserId ?? null },
      "Authorization code issued",
    );
    res.redirect(302, redirectUrl.toString());
  }

  async challengeForAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
  ): Promise<string> {
    const entry = await this.authCodesImpl.get(authorizationCode);
    if (!entry) {
      throw new Error("Invalid authorization code");
    }
    if (entry.clientId !== client.client_id) {
      throw new Error("Authorization code was issued to a different client");
    }
    if (entry.expiresAt < Math.floor(Date.now() / 1000)) {
      await this.authCodesImpl.delete(authorizationCode);
      throw new Error("Authorization code has expired");
    }
    return entry.codeChallenge;
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
    _codeVerifier?: string,
    _redirectUri?: string,
    resource?: URL,
  ): Promise<OAuthTokens> {
    const entry = await this.authCodesImpl.get(authorizationCode);
    if (!entry) {
      throw new Error("Invalid authorization code");
    }

    await this.authCodesImpl.delete(authorizationCode);

    if (entry.clientId !== client.client_id) {
      throw new Error("Authorization code was issued to a different client");
    }
    if (entry.expiresAt < Math.floor(Date.now() / 1000)) {
      throw new Error("Authorization code has expired");
    }

    return this.generateTokens({
      clientId: client.client_id,
      resource:
        resource ?? (entry.resource ? new URL(entry.resource) : undefined),
      fbUserId: entry.fbUserId,
      metaTokenName: entry.metaTokenName,
    });
  }

  async exchangeRefreshToken(
    client: OAuthClientInformationFull,
    refreshToken: string,
    _scopes?: string[],
    resource?: URL,
  ): Promise<OAuthTokens> {
    const secret = getJwtSecret();

    const { payload } = await jwtVerify(refreshToken, secret).catch(() => {
      throw new Error("Invalid refresh token");
    });

    if (payload.type !== "refresh") {
      throw new Error("Token is not a refresh token");
    }
    if (payload.sub !== client.client_id) {
      throw new Error("Refresh token was issued to a different client");
    }

    return this.generateTokens({
      clientId: client.client_id,
      resource,
      fbUserId:
        typeof payload.fb_user_id === "string" ? payload.fb_user_id : undefined,
      metaTokenName:
        typeof payload.meta_token_name === "string"
          ? payload.meta_token_name
          : undefined,
    });
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const secret = getJwtSecret();

    const { payload } = await jwtVerify(token, secret).catch(() => {
      throw new Error("Invalid access token");
    });

    if (payload.type !== "access") {
      throw new Error("Token is not an access token");
    }

    const extra: Record<string, unknown> = {};
    if (typeof payload.fb_user_id === "string") {
      extra.fbUserId = payload.fb_user_id;
    }
    if (typeof payload.meta_token_name === "string") {
      extra.metaTokenName = payload.meta_token_name;
    }

    const authInfo: AuthInfo = {
      token,
      clientId: payload.sub!,
      scopes: [],
      expiresAt: payload.exp,
      extra: Object.keys(extra).length > 0 ? extra : undefined,
    };
    if (payload.resource) {
      authInfo.resource = new URL(payload.resource as string);
    }
    return authInfo;
  }

  async revokeToken(
    _client: OAuthClientInformationFull,
    _request: OAuthTokenRevocationRequest,
  ): Promise<void> {
    logger.debug("Token revocation requested (no-op for stateless JWTs)");
  }

  private async generateTokens(input: {
    clientId: string;
    resource?: URL;
    fbUserId?: string;
    metaTokenName?: string;
  }): Promise<OAuthTokens> {
    const secret = getJwtSecret();
    const now = Math.floor(Date.now() / 1000);

    const claims: Record<string, unknown> = {
      sub: input.clientId,
      type: "access",
    };
    if (input.resource) claims.resource = input.resource.href;
    if (input.fbUserId) claims.fb_user_id = input.fbUserId;
    if (input.metaTokenName) claims.meta_token_name = input.metaTokenName;

    const accessToken = await new SignJWT(claims)
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt(now)
      .setExpirationTime(now + 3600)
      .sign(secret);

    const refreshClaims: Record<string, unknown> = {
      sub: input.clientId,
      type: "refresh",
    };
    if (input.fbUserId) refreshClaims.fb_user_id = input.fbUserId;
    if (input.metaTokenName) refreshClaims.meta_token_name = input.metaTokenName;

    const refreshToken = await new SignJWT(refreshClaims)
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt(now)
      .setExpirationTime(now + 30 * 24 * 3600)
      .sign(secret);

    logger.info(
      { clientId: input.clientId, fbUserId: input.fbUserId ?? null },
      "Tokens issued",
    );

    return {
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: 3600,
      refresh_token: refreshToken,
    };
  }
}

export const oauthProvider: MetaAdsOAuthProvider = new MetaAdsOAuthProvider();

export function resetOAuthProviderForTests(): void {
  cachedSecret = undefined;
  oauthProvider.configure({
    clientsStore: new InMemoryClientsStore(),
    authCodesStore: new InMemoryAuthCodesStore(),
    resolvePendingAuth: () => null,
  });
}
