import crypto from "node:crypto";
import { SignJWT, jwtVerify } from "jose";
import type { Request, Response } from "express";

const COOKIE_NAME = "mcp_session";
const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;

export interface SessionPayload {
  fbUserId: string;
  email: string | null;
  name: string | null;
}

let cachedSecret: Uint8Array | undefined;

function getSecret(): Uint8Array {
  if (cachedSecret) return cachedSecret;

  const raw = process.env.SESSION_COOKIE_SECRET;
  if (raw && raw.length >= 32) {
    cachedSecret = new TextEncoder().encode(raw);
    return cachedSecret;
  }

  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "SESSION_COOKIE_SECRET is required in production (>=32 chars)",
    );
  }

  cachedSecret = new TextEncoder().encode(crypto.randomBytes(32).toString("hex"));
  return cachedSecret;
}

export async function setSession(
  res: Response,
  payload: SessionPayload,
): Promise<void> {
  const secret = getSecret();
  const now = Math.floor(Date.now() / 1000);

  const jwt = await new SignJWT({
    fb: payload.fbUserId,
    em: payload.email,
    nm: payload.name,
  })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt(now)
    .setExpirationTime(now + SESSION_TTL_SECONDS)
    .sign(secret);

  res.cookie(COOKIE_NAME, jwt, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: SESSION_TTL_SECONDS * 1000,
    path: "/",
  });
}

export async function getSession(
  req: Request,
): Promise<SessionPayload | null> {
  const reqCookies = (req as Request & { cookies?: Record<string, string> })
    .cookies;
  const cookie = reqCookies?.[COOKIE_NAME];
  if (!cookie) return null;

  try {
    const { payload } = await jwtVerify(cookie, getSecret());
    if (typeof payload.fb !== "string") return null;
    return {
      fbUserId: payload.fb,
      email: typeof payload.em === "string" ? payload.em : null,
      name: typeof payload.nm === "string" ? payload.nm : null,
    };
  } catch {
    return null;
  }
}

export function clearSession(res: Response): void {
  res.clearCookie(COOKIE_NAME, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
  });
}

export function resetSecretCacheForTests(): void {
  cachedSecret = undefined;
}
