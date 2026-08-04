import { Router } from "express";

/**
 * Model catalog and provider status.
 *
 * `/models` is public: the landing page renders it before login, and it
 * contains no user data and no secrets — only what the deployment can do.
 * Unconfigured providers are omitted, because which keys a deployment holds is
 * operational information (docs/backend/09-api-design.md#models-and-providers).
 *
 * The rate limit is attached **per route** rather than with `router.use`. A
 * router-level middleware runs for every request that enters the router,
 * including the ones that fall through to a later controller — so mounting it
 * that way would charge every chat and thread request against the anonymous
 * budget as well as its own.
 */
export function catalogController({ catalogService, limit = [] }) {
  const router = Router();
  const guards = Array.isArray(limit) ? limit : [limit];

  router.get("/models", ...guards, (req, res) => {
    const catalog = catalogService.listModels();
    // Clients cache against `catalogVersion`; a changed version invalidates.
    res.set("Cache-Control", "public, max-age=60");
    res.json(catalog);
  });

  router.get("/providers", ...guards, (req, res) => {
    res.json({ data: catalogService.listProviders() });
  });

  return router;
}
