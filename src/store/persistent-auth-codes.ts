import { getFirestore } from "./firestore.js";

const COLLECTION = "mcp_auth_codes";

export interface AuthCodeEntry {
  clientId: string;
  codeChallenge: string;
  redirectUri: string;
  resource?: string;
  fbUserId?: string;
  expiresAt: number;
}

export interface AuthCodesStore {
  set(code: string, entry: AuthCodeEntry): Promise<void>;
  get(code: string): Promise<AuthCodeEntry | undefined>;
  delete(code: string): Promise<void>;
}

export class FirestoreAuthCodesStore implements AuthCodesStore {
  private get collection() {
    return getFirestore().collection(COLLECTION);
  }

  async set(code: string, entry: AuthCodeEntry): Promise<void> {
    await this.collection.doc(code).set(entry);
  }

  async get(code: string): Promise<AuthCodeEntry | undefined> {
    const snap = await this.collection.doc(code).get();
    if (!snap.exists) return undefined;
    return snap.data() as AuthCodeEntry;
  }

  async delete(code: string): Promise<void> {
    await this.collection.doc(code).delete();
  }
}

export class InMemoryAuthCodesStore implements AuthCodesStore {
  private codes = new Map<string, AuthCodeEntry>();

  async set(code: string, entry: AuthCodeEntry): Promise<void> {
    this.codes.set(code, entry);
  }

  async get(code: string): Promise<AuthCodeEntry | undefined> {
    return this.codes.get(code);
  }

  async delete(code: string): Promise<void> {
    this.codes.delete(code);
  }
}
