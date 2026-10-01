import { z } from "zod";

const digestSchema = z.string().regex(/^[0-9a-f]{64}$/);
const nonEmptySchema = z.string().min(1);
const roleSchema = z.enum(["coordinator", "product_manager", "architect", "developer", "reviewer", "qa", "integration"]);

/** Subject, к которому безопасно привязана сохранённая provenance-запись Run. */
export const contextManifestSubjectSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("TASK"), id: nonEmptySchema }).strict(),
  z.object({ type: z.literal("EPIC"), id: nonEmptySchema }).strict(),
  z.object({ type: z.literal("REQUEST"), id: nonEmptySchema }).strict(),
]);

/** Идентификатор выбранного элемента и его проверяемая версия provenance. */
export const contextManifestItemSchema = z.object({
  id: nonEmptySchema,
  version: z.number().int().positive().nullable(),
  digest: digestSchema.nullable(),
}).strict();

/** Безопасная проекция подтверждённого сохранённого манифеста. */
export const availableContextManifestSchema = z.object({
  availability: z.literal("available"),
  id: nonEmptySchema,
  runId: nonEmptySchema,
  subject: contextManifestSubjectSchema,
  role: roleSchema,
  contractRequestDigest: digestSchema.nullable(),
  items: z.array(contextManifestItemSchema),
  promptHash: digestSchema,
  contextHash: digestSchema,
  contextBuilderVersion: nonEmptySchema,
  initialTokenSize: z.number().int().nonnegative().nullable(),
}).strict();

/** Явное состояние старого или повреждённого provenance без подмены на пустой контекст. */
export const unavailableContextManifestSchema = z.object({
  availability: z.literal("unavailable"),
  runId: nonEmptySchema,
  subject: contextManifestSubjectSchema.nullable(),
  role: roleSchema.or(z.literal("unknown")),
  reason: z.enum(["LEGACY_PROVENANCE_UNAVAILABLE", "INVALID_PERSISTED_PROVENANCE"]),
}).strict();

/** Ответ GET Run context-manifests; пустой items отличается от unavailable. */
export const contextManifestProjectionSchema = z.discriminatedUnion("availability", [
  availableContextManifestSchema,
  unavailableContextManifestSchema,
]);

export type ContextManifestSubjectProjection = z.infer<typeof contextManifestSubjectSchema>;
export type ContextManifestItemProjection = z.infer<typeof contextManifestItemSchema>;
export type AvailableContextManifestProjection = z.infer<typeof availableContextManifestSchema>;
export type UnavailableContextManifestProjection = z.infer<typeof unavailableContextManifestSchema>;
export type ContextManifestProjection = z.infer<typeof contextManifestProjectionSchema>;
