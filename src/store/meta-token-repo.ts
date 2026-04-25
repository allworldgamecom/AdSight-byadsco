import { getFirestore } from "./firestore.js";
import {
  decryptToken,
  encryptToken,
  type EncryptedPayload,
} from "../auth/crypto.js";
import {
  exchangeForLongLivedToken,
  loadMetaOAuthConfig,
  type MetaProfile,
} from "../auth/meta-oauth.js";
import { logger } from "../utils/logger.js";

const REFRESH_THRESHOLD_SECONDS = 7 * 24 * 60 * 60;

export type TokenKind = "user" | "system_user";

export interface UserDoc {
  email: string | null;
  name: string | null;
  picture: string | null;
  firstLoginAt: number;
  lastLoginAt: number;
}

export interface MetaTokenDoc {
  encryptedToken: EncryptedPayload;
  kind: TokenKind;
  expiresAt: number | null;
  scopes: string[];
  metaUserId: string | null;
  metaUserName: string | null;
  businessId?: string | null;
  isDefault: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface MetaTokenSummary {
  name: string;
  kind: TokenKind;
  expiresAt: number | null;
  metaUserId: string | null;
  metaUserName: string | null;
  isDefault: boolean;
  isExpired: boolean;
}

function userDocRef(fbUserId: string) {
  return getFirestore().collection("users").doc(fbUserId);
}

function tokenDocRef(fbUserId: string, name: string) {
  return userDocRef(fbUserId).collection("meta_tokens").doc(name);
}

export async function upsertUser(
  fbUserId: string,
  profile: MetaProfile,
): Promise<void> {
  const ref = userDocRef(fbUserId);
  const now = Math.floor(Date.now() / 1000);
  const snap = await ref.get();
  if (snap.exists) {
    await ref.update({
      email: profile.email,
      name: profile.name,
      picture: profile.pictureUrl,
      lastLoginAt: now,
    });
  } else {
    const doc: UserDoc = {
      email: profile.email,
      name: profile.name,
      picture: profile.pictureUrl,
      firstLoginAt: now,
      lastLoginAt: now,
    };
    await ref.set(doc);
  }
}

export async function getUser(fbUserId: string): Promise<UserDoc | null> {
  const snap = await userDocRef(fbUserId).get();
  if (!snap.exists) return null;
  return snap.data() as UserDoc;
}

interface SaveTokenInput {
  fbUserId: string;
  name: string;
  accessToken: string;
  kind: TokenKind;
  expiresAt: number | null;
  scopes?: string[];
  metaUserId: string | null;
  metaUserName: string | null;
  businessId?: string | null;
  setAsDefault?: boolean;
}

export async function saveToken(input: SaveTokenInput): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const encryptedToken = encryptToken(input.accessToken);

  const doc: MetaTokenDoc = {
    encryptedToken,
    kind: input.kind,
    expiresAt: input.expiresAt,
    scopes: input.scopes ?? [],
    metaUserId: input.metaUserId,
    metaUserName: input.metaUserName,
    businessId: input.businessId ?? null,
    isDefault: input.setAsDefault ?? false,
    createdAt: now,
    updatedAt: now,
  };

  if (input.setAsDefault) {
    await clearDefaults(input.fbUserId);
  } else {
    const existingDefault = await getDefaultTokenName(input.fbUserId);
    if (!existingDefault) {
      doc.isDefault = true;
    }
  }

  await tokenDocRef(input.fbUserId, input.name).set(doc, { merge: false });
}

async function clearDefaults(fbUserId: string): Promise<void> {
  const tokens = await userDocRef(fbUserId).collection("meta_tokens").get();
  const batch = getFirestore().batch();
  for (const snap of tokens.docs) {
    batch.update(snap.ref, { isDefault: false });
  }
  if (!tokens.empty) await batch.commit();
}

export async function setDefaultToken(
  fbUserId: string,
  name: string,
): Promise<boolean> {
  const ref = tokenDocRef(fbUserId, name);
  const snap = await ref.get();
  if (!snap.exists) return false;
  await clearDefaults(fbUserId);
  await ref.update({ isDefault: true, updatedAt: Math.floor(Date.now() / 1000) });
  return true;
}

export async function deleteToken(
  fbUserId: string,
  name: string,
): Promise<boolean> {
  const ref = tokenDocRef(fbUserId, name);
  const snap = await ref.get();
  if (!snap.exists) return false;
  const wasDefault = (snap.data() as MetaTokenDoc).isDefault;
  await ref.delete();
  if (wasDefault) {
    const remaining = await userDocRef(fbUserId).collection("meta_tokens").limit(1).get();
    if (!remaining.empty) {
      await remaining.docs[0].ref.update({ isDefault: true });
    }
  }
  return true;
}

export async function listTokens(
  fbUserId: string,
): Promise<MetaTokenSummary[]> {
  const snap = await userDocRef(fbUserId).collection("meta_tokens").get();
  const now = Math.floor(Date.now() / 1000);
  return snap.docs.map((d) => {
    const data = d.data() as MetaTokenDoc;
    return {
      name: d.id,
      kind: data.kind,
      expiresAt: data.expiresAt,
      metaUserId: data.metaUserId,
      metaUserName: data.metaUserName,
      isDefault: data.isDefault,
      isExpired: data.expiresAt !== null && data.expiresAt < now,
    };
  });
}

export async function getDefaultTokenName(
  fbUserId: string,
): Promise<string | null> {
  const snap = await userDocRef(fbUserId)
    .collection("meta_tokens")
    .where("isDefault", "==", true)
    .limit(1)
    .get();
  if (snap.empty) return null;
  return snap.docs[0].id;
}

/**
 * Resolve a Meta access token in plaintext for the given user.
 *
 * Auto-refreshes long-lived user tokens when within the refresh window.
 * Throws if the token does not exist or refresh fails on an already-expired
 * token. System User tokens never refresh (they don't expire).
 */
export async function getDecryptedToken(
  fbUserId: string,
  name?: string,
  serverUrl?: URL,
): Promise<string> {
  const tokenName = name ?? (await getDefaultTokenName(fbUserId));
  if (!tokenName) {
    throw new Error(`No Meta token registered for user ${fbUserId}`);
  }

  const ref = tokenDocRef(fbUserId, tokenName);
  const snap = await ref.get();
  if (!snap.exists) {
    throw new Error(`Meta token "${tokenName}" not found for user ${fbUserId}`);
  }

  const data = snap.data() as MetaTokenDoc;
  const plaintext = decryptToken(data.encryptedToken);

  if (data.kind === "system_user") {
    return plaintext;
  }

  const now = Math.floor(Date.now() / 1000);
  if (data.expiresAt && data.expiresAt - now < REFRESH_THRESHOLD_SECONDS) {
    const config = serverUrl ? loadMetaOAuthConfig(serverUrl) : null;
    if (!config) {
      logger.warn(
        { fbUserId, tokenName },
        "Cannot refresh long-lived token: META_APP_ID/SECRET not configured",
      );
      return plaintext;
    }
    try {
      const refreshed = await exchangeForLongLivedToken(config, plaintext);
      const newDoc: Partial<MetaTokenDoc> = {
        encryptedToken: encryptToken(refreshed.accessToken),
        expiresAt: refreshed.expiresAt,
        updatedAt: Math.floor(Date.now() / 1000),
      };
      await ref.update(newDoc);
      logger.info(
        {
          fbUserId,
          tokenName,
          expiresAt: refreshed.expiresAt,
          event: "meta_token_refreshed",
        },
        "Refreshed long-lived Meta token",
      );
      return refreshed.accessToken;
    } catch (err) {
      logger.warn(
        {
          fbUserId,
          tokenName,
          error: err instanceof Error ? err.message : String(err),
          event: "meta_token_refresh_failed",
        },
        "Long-lived token refresh failed; using existing token",
      );
      return plaintext;
    }
  }

  return plaintext;
}
