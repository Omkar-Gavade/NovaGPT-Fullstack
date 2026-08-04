import { Router } from "express";
import { validate } from "../middleware/validate.js";
import { embeddingsSchema } from "../schemas/chatSchemas.js";
import { z } from "zod";

/**
 * Tool calling and embeddings.
 *
 * Both sit behind the same auth gate as chat and draw on the same provider
 * fleet, so both carry their own rate limit: the pools serving them are small —
 * three providers for embeddings, eight for tools — and a limit shared with
 * chat would let ordinary conversation exhaust a capability nothing else can
 * serve (docs/backend/11-observability.md).
 */

const toolRequestSchema = z
  .object({
    messages: z
      .array(
        z
          .object({
            role: z.enum(["system", "user", "assistant", "tool"]),
            content: z.string().max(100_000),
            // A tool *result* the client is feeding back. The platform never
            // produced it — execution is the client's, deliberately.
            toolCallId: z.string().max(128).optional(),
          })
          .strict()
      )
      .min(1)
      .max(100),
    tools: z
      .array(
        z
          .object({
            name: z.string().min(1).max(64).regex(/^[a-zA-Z0-9_-]+$/),
            description: z.string().max(1024).optional(),
            parameters: z.record(z.string(), z.any()).optional(),
          })
          .strict()
      )
      .min(1)
      .max(64),
    model: z.string().min(1).optional(),
    settings: z
      .object({
        temperature: z.number().min(0).max(2).optional(),
        maxTokens: z.number().int().min(1).max(200_000).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export function capabilityController({ capabilityService, userKeyService, limit = [] }) {
  const router = Router();
  const guards = Array.isArray(limit) ? limit : [limit];

  // Resolved per request, so a user's own key is used for these endpoints too.
  // Omitting it here would mean BYOK worked for chat and silently did not for
  // embeddings — the kind of gap nobody notices until a bill arrives.
  const credentialsFor = (req) => userKeyService?.resolve(req.principal.ownerId) ?? new Map();

  router.post("/tools/call", ...guards, validate(toolRequestSchema), async (req, res) => {
    const result = await capabilityService.callTools({
      messages: req.body.messages,
      tools: req.body.tools,
      model: req.body.model ?? null,
      settings: req.body.settings ?? {},
      credentials: await credentialsFor(req),
    });

    res.json({
      data: {
        text: result.text,
        toolCalls: result.toolCalls,
        // Stated rather than implied: a client must not read a tool call as
        // something the platform has already done.
        executed: false,
      },
      meta: {
        model: result.model?.id ?? null,
        provider: result.model?.provider ?? null,
        usage: result.usage,
      },
    });
  });

  router.post("/embeddings", ...guards, validate(embeddingsSchema), async (req, res) => {
    const result = await capabilityService.embed({
      inputs: req.body.input,
      model: req.body.model ?? null,
      credentials: await credentialsFor(req),
    });

    res.json({
      data: result.embeddings,
      meta: {
        model: result.model?.id ?? null,
        provider: result.model?.provider ?? null,
        dimensions: result.dimensions,
        count: result.embeddings.length,
      },
    });
  });

  return router;
}
