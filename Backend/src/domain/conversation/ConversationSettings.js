import { SwitchPolicy, isSwitchPolicy } from "../routing/RetryPolicy.js";

/**
 * Per-conversation generation settings.
 *
 * Owned by the thread rather than the request so a conversation behaves
 * consistently across turns: a user who set a system prompt on turn 1 does not
 * expect turn 40 to forget it. Request-level values still win for a single
 * turn, which is what makes "try this once with a different model" possible
 * without mutating the conversation.
 *
 * Validated on construction, clamped rather than rejected. A slightly wrong
 * temperature is not worth failing a user's message over; an unbounded one is
 * worth correcting.
 */
export class ConversationSettings {
  static DEFAULTS = Object.freeze({
    model: null, // null means "let the router choose"
    temperature: 0.7,
    maxTokens: 2048,
    topP: 1,
    systemPrompt: "",
    switchPolicy: SwitchPolicy.AUTO,
  });

  constructor(raw = {}) {
    const defaults = ConversationSettings.DEFAULTS;

    // null is meaningful and distinct from undefined: it is an explicit
    // "unpin the model", which must not fall back to the stored value.
    this.model = raw.model === undefined ? defaults.model : raw.model || null;

    this.temperature = clamp(numberOr(raw.temperature, defaults.temperature), 0, 2);
    this.maxTokens = Math.max(1, Math.floor(numberOr(raw.maxTokens, defaults.maxTokens)));
    this.topP = clamp(numberOr(raw.topP, defaults.topP), 0, 1);

    this.systemPrompt = typeof raw.systemPrompt === "string" ? raw.systemPrompt : defaults.systemPrompt;

    // An unknown policy silently becoming "never" would strand users on a dead
    // provider, so the safe default wins.
    this.switchPolicy = isSwitchPolicy(raw.switchPolicy) ? raw.switchPolicy : defaults.switchPolicy;

    Object.freeze(this);
  }

  /** Overlay per-request values without mutating the stored settings. */
  merge(overrides = {}) {
    const defined = Object.fromEntries(
      Object.entries(overrides).filter(([, value]) => value !== undefined)
    );
    return new ConversationSettings({ ...this.toJSON(), ...defined });
  }

  toJSON() {
    return {
      model: this.model,
      temperature: this.temperature,
      maxTokens: this.maxTokens,
      topP: this.topP,
      systemPrompt: this.systemPrompt,
      switchPolicy: this.switchPolicy,
    };
  }
}

const numberOr = (value, fallback) => (Number.isFinite(value) ? value : fallback);
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
