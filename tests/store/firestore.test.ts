import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const constructorSpy = vi.fn();

vi.mock("@google-cloud/firestore", () => ({
  Firestore: class {
    constructor(opts: unknown) {
      constructorSpy(opts);
    }
  },
}));

describe("getFirestore", () => {
  const originalProjectId = process.env.FIRESTORE_PROJECT_ID;
  const originalGoogleProject = process.env.GOOGLE_CLOUD_PROJECT;

  beforeEach(async () => {
    vi.resetModules();
    constructorSpy.mockClear();
    delete process.env.FIRESTORE_PROJECT_ID;
    delete process.env.GOOGLE_CLOUD_PROJECT;
  });

  afterEach(async () => {
    if (originalProjectId === undefined) delete process.env.FIRESTORE_PROJECT_ID;
    else process.env.FIRESTORE_PROJECT_ID = originalProjectId;
    if (originalGoogleProject === undefined)
      delete process.env.GOOGLE_CLOUD_PROJECT;
    else process.env.GOOGLE_CLOUD_PROJECT = originalGoogleProject;
    const { resetFirestoreForTests } = await import(
      "../../src/store/firestore.js"
    );
    resetFirestoreForTests();
  });

  it("constructs Firestore with ignoreUndefinedProperties enabled (prevents auth-code writes from throwing on undefined fields)", async () => {
    process.env.FIRESTORE_PROJECT_ID = "test-project";
    const { getFirestore } = await import("../../src/store/firestore.js");

    getFirestore();

    expect(constructorSpy).toHaveBeenCalledTimes(1);
    expect(constructorSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "test-project",
        ignoreUndefinedProperties: true,
      }),
    );
  });

  it("still passes ignoreUndefinedProperties when no projectId is set (relies on ADC)", async () => {
    const { getFirestore } = await import("../../src/store/firestore.js");

    getFirestore();

    expect(constructorSpy).toHaveBeenCalledWith(
      expect.objectContaining({ ignoreUndefinedProperties: true }),
    );
  });
});
