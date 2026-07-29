import { OpenAICompatibleProvider } from "../../utils/OpenAICompatibleProvider.js";
import { modelsFor } from "../../registry/catalog.js";

/**
 * Cloudflare Workers AI — free daily neurons, OpenAI-compatible.
 * The base URL embeds the account id, so it needs both the account id and an
 * API token to be considered configured.
 */
export class CloudflareProvider extends OpenAICompatibleProvider {
  constructor() {
    const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
    super({
      id: "cloudflare",
      name: "Cloudflare Workers AI",
      apiKey: process.env.CLOUDFLARE_API_TOKEN,
      baseURL: accountId
        ? `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/v1`
        : undefined,
      models: modelsFor("cloudflare"),
    });
    this.accountId = accountId;
  }

  get isConfigured() {
    return Boolean(this.apiKey && this.accountId);
  }
}
