import { Router } from "express";
import { z } from "zod";
import { validate } from "../middleware/validate.js";

/**
 * Bring-your-own-key endpoints.
 *
 * **Write-only, by construction.** There is no route that returns a stored key
 * and no serialiser with a field for one: `toPublicJSON()` carries a mask and
 * nothing else. A user who has lost their key retrieves it from the provider,
 * not from us (docs/backend/10-security.md#rules-for-user-supplied-keys).
 *
 * `PUT` rather than `POST`: a user has at most one key per provider, and
 * replacing it is idempotent. `POST` would invite a second key nobody can see
 * and therefore nobody can revoke.
 */

const storeKeySchema = z
  .object({
    // A string, explicitly — an object here is the NoSQL injection vector, and
    // this is the one endpoint where the value goes straight into a credential.
    key: z.string().min(8).max(512),
  })
  .strict();

// The provider id is a path parameter, so it is validated separately and
// strictly: it selects which adapter receives the credential.
const providerParam = z.string().regex(/^[a-z0-9-]{2,32}$/);

export function userKeyController({ userKeyService, metrics }) {
  const router = Router();

  const context = (req) => ({
    ip: req.ip ?? req.socket?.remoteAddress ?? null,
    traceId: req.context?.traceId ?? null,
  });

  router.get("/me/keys", async (req, res) => {
    res.json({
      data: await userKeyService.list(req.principal.id),
      meta: { enabled: userKeyService.enabled },
    });
  });

  router.put("/me/keys/:provider", validate(storeKeySchema), async (req, res) => {
    const provider = providerParam.parse(req.params.provider);
    const record = await userKeyService.store({
      userId: req.principal.id,
      provider,
      key: req.body.key,
      context: context(req),
    });

    // The mask, never the key — including on the response to the request that
    // just supplied it.
    res.json({ data: record.toPublicJSON() });
  });

  router.delete("/me/keys/:provider", async (req, res) => {
    await userKeyService.forget({
      userId: req.principal.id,
      provider: providerParam.parse(req.params.provider),
      context: context(req),
    });
    res.json({ data: { removed: true } });
  });

  return router;
}
