import { z } from "zod";

/**
 * Request validation.
 *
 * The single source of truth for shape, types, and the generated OpenAPI
 * document (docs/backend/15-decisions.md#adr-016--openapi-generated-from-runtime-validation-schemas).
 *
 * `.strict()` everywhere: an unknown field is **rejected**, not stripped. A
 * client sending `temperture: 0.9` would otherwise get silent default behaviour
 * and a bug report nobody can reproduce.
 */

const settings = z
  .object({
    model: z.string().min(1).nullable().optional(),
    temperature: z.number().min(0).max(2).optional(),
    maxTokens: z.number().int().min(1).max(200_000).optional(),
    topP: z.number().min(0).max(1).optional(),
    systemPrompt: z.string().max(20_000).optional(),
    switchPolicy: z.enum(["auto", "ask", "never"]).optional(),
  })
  .strict();

const attachment = z
  .object({
    type: z.enum(["image", "pdf"]),
    url: z.string().url().optional(),
    data: z.string().optional(),
    mimeType: z.string().optional(),
  })
  .strict();

export const sendMessageSchema = z
  .object({
    threadId: z.string().min(1).optional(),
    // Bounded so a single request cannot consume a whole context window or
    // exhaust memory before the parser finishes.
    message: z.string().min(1).max(100_000),
    attachments: z.array(attachment).max(10).optional(),
    settings: settings.optional(),
    idempotencyKey: z.string().min(8).max(128).optional(),
  })
  .strict();

export const regenerateSchema = z
  .object({
    threadId: z.string().min(1),
    messageId: z.string().min(1),
    settings: settings.optional(),
  })
  .strict();

export const continueSchema = z
  .object({
    threadId: z.string().min(1),
    messageId: z.string().min(1).optional(),
    settings: settings.optional(),
  })
  .strict();

export const stopSchema = z.object({ streamId: z.string().min(1) }).strict();

export const renameSchema = z.object({ title: z.string().min(1).max(120) }).strict();

export const patchThreadSchema = z
  .object({
    title: z.string().min(1).max(120).optional(),
    pinned: z.boolean().optional(),
    archived: z.boolean().optional(),
  })
  .strict();

export const settingsSchema = settings;

export const pinMessageSchema = z.object({ pinned: z.boolean() }).strict();

/**
 * A query-string boolean.
 *
 * `z.coerce.boolean()` is wrong here and silently so: it applies `Boolean(v)`,
 * and `Boolean("false") === true`. Every `?archived=false` would therefore list
 * archived threads — which is exactly how an empty sidebar was produced while
 * the data was fine.
 */
const queryBool = z
  .union([z.boolean(), z.enum(["true", "false", "1", "0"])])
  .transform((v) => v === true || v === "true" || v === "1");

export const listThreadsSchema = z
  .object({
    // Clamped rather than rejected: a client asking for too much still gets
    // useful data (docs/backend/09-api-design.md#pagination).
    limit: z.coerce.number().int().min(1).max(100).default(20),
    cursor: z.string().optional(),
    archived: queryBool.default(false),
    q: z.string().max(200).optional(),
  })
  .strict();
