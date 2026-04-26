import { Firestore } from "@google-cloud/firestore";
import { logger } from "../utils/logger.js";

let cachedClient: Firestore | undefined;

export function getFirestore(): Firestore {
  if (cachedClient) return cachedClient;

  const projectId =
    process.env.FIRESTORE_PROJECT_ID?.trim() ||
    process.env.GOOGLE_CLOUD_PROJECT?.trim();

  cachedClient = new Firestore({
    ...(projectId ? { projectId } : {}),
    ignoreUndefinedProperties: true,
  });
  logger.info(
    { projectId: projectId ?? "(adc)", emulator: process.env.FIRESTORE_EMULATOR_HOST ?? null },
    "Firestore client initialized",
  );

  return cachedClient;
}

export function isFirestoreEnabled(): boolean {
  return (
    !!process.env.FIRESTORE_PROJECT_ID ||
    !!process.env.GOOGLE_CLOUD_PROJECT ||
    !!process.env.FIRESTORE_EMULATOR_HOST
  );
}

export function resetFirestoreForTests(): void {
  cachedClient = undefined;
}
