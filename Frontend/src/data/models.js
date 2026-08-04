/**
 * Display catalog for marketing surfaces (landing, auth constellation).
 * One entry per provider. The chat's model picker uses the *live* catalog from
 * `GET /api/models` instead, so it always reflects real availability.
 */
export { PROVIDERS as MODELS, PROVIDER_BRAND, brandFor } from "./providers";
