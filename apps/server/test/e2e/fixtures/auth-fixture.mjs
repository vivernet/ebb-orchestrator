import { createAuthRepository } from "../../../dist/platform/security/auth-repository.js";
import { createNodeDigestPort, createNodeRandomTokenPort } from "../../../dist/platform/security/auth-ports.js";
import { Buffer } from "node:buffer";

/** Создаёт единственную реальную локальную запись E2E; входной текст копируется в буфер и обнуляется независимо от результата. */

export async function seedE2ELocalUser({ database, passwordHasher, password, now }) {
  const repository = createAuthRepository(database, passwordHasher, createNodeRandomTokenPort(), createNodeDigestPort());
  const bytes = Buffer.from(password, "utf8");
  try {
    if (await repository.hasLocalUser()) {
      const error = new Error("DUPLICATE_SEED");
      error.code = "DUPLICATE_SEED";
      throw error;
    }
    await repository.createLocalUser(bytes, now);
  } finally {
    bytes.fill(0);
  }
}
