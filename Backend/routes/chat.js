import express from "express";
import Thread from "../models/Thread.js";
import { registry } from "../providers/registry/index.js";
import { route, SwitchPolicy } from "../providers/router/ModelRouter.js";
import { ProviderError } from "../providers/interfaces/Provider.js";

const router = express.Router();

/* ============================== threads ================================= */

router.get("/thread", async (req, res) => {
  try {
    const threads = await Thread.find({}).sort({ updatedAt: -1 });
    res.json(threads);
  } catch (err) {
    console.error("Failed to fetch threads", err);
    res.status(500).json({ error: "Failed to fetch threads" });
  }
});

router.get("/thread/:threadId", async (req, res) => {
  try {
    const thread = await Thread.findOne({ threadId: req.params.threadId });
    if (!thread) return res.status(404).json({ error: "Thread not found" });
    res.json(thread.message);
  } catch (err) {
    console.error("Failed to fetch thread", err);
    res.status(500).json({ error: "Failed to fetch chat" });
  }
});

router.delete("/thread/:threadId", async (req, res) => {
  try {
    const deleted = await Thread.findOneAndDelete({ threadId: req.params.threadId });
    if (!deleted) return res.status(404).json({ error: "Thread not found" });
    res.json({ success: true });
  } catch (err) {
    console.error("Failed to delete thread", err);
    res.status(500).json({ error: "Failed to delete thread" });
  }
});

/** Rename / pin / archive a conversation. */
router.patch("/thread/:threadId", async (req, res) => {
  const { title, pinned, archived } = req.body;
  const set = { updatedAt: new Date() };
  if (typeof title === "string" && title.trim()) set.title = title.trim().slice(0, 120);
  if (typeof pinned === "boolean") set.pinned = pinned;
  if (typeof archived === "boolean") set.archived = archived;

  try {
    const thread = await Thread.findOneAndUpdate(
      { threadId: req.params.threadId },
      { $set: set },
      { new: true }
    );
    if (!thread) return res.status(404).json({ error: "Thread not found" });
    res.json(thread);
  } catch (err) {
    console.error("Failed to update thread", err);
    res.status(500).json({ error: "Failed to update thread" });
  }
});

/** Duplicate a conversation (messages + settings, fresh id, un-shared). */
router.post("/thread/:threadId/duplicate", async (req, res) => {
  try {
    const src = await Thread.findOne({ threadId: req.params.threadId });
    if (!src) return res.status(404).json({ error: "Thread not found" });

    const copy = new Thread({
      threadId: crypto.randomUUID(),
      title: `${src.title} (copy)`,
      message: src.message.map((m) => ({
        role: m.role,
        content: m.content,
        model: m.model,
        provider: m.provider,
        timestamp: m.timestamp,
      })),
      settings: src.settings,
    });
    await copy.save();
    res.json(copy);
  } catch (err) {
    console.error("Failed to duplicate thread", err);
    res.status(500).json({ error: "Failed to duplicate thread" });
  }
});

/** Create (or return) a public share link for a conversation. */
router.post("/thread/:threadId/share", async (req, res) => {
  try {
    const thread = await Thread.findOne({ threadId: req.params.threadId });
    if (!thread) return res.status(404).json({ error: "Thread not found" });
    if (!thread.shareId) {
      thread.shareId = crypto.randomUUID().slice(0, 12);
      await thread.save();
    }
    const base = process.env.PUBLIC_URL || "";
    res.json({ shareId: thread.shareId, url: `${base}/share/${thread.shareId}` });
  } catch (err) {
    console.error("Failed to share thread", err);
    res.status(500).json({ error: "Failed to share thread" });
  }
});

/** Public, read-only view of a shared conversation. */
router.get("/share/:shareId", async (req, res) => {
  try {
    const thread = await Thread.findOne({ shareId: req.params.shareId });
    if (!thread) return res.status(404).json({ error: "Shared chat not found" });
    res.json({ title: thread.title, message: thread.message });
  } catch (err) {
    console.error("Failed to load shared thread", err);
    res.status(500).json({ error: "Failed to load shared chat" });
  }
});

/** Read/write the per-conversation generation settings. */
router.get("/thread/:threadId/settings", async (req, res) => {
  try {
    const thread = await Thread.findOne({ threadId: req.params.threadId });
    res.json(thread?.settings ?? {});
  } catch (err) {
    console.error("Failed to fetch settings", err);
    res.status(500).json({ error: "Failed to fetch settings" });
  }
});

router.put("/thread/:threadId/settings", async (req, res) => {
  const { model, temperature, maxTokens, topP, systemPrompt, switchPolicy } = req.body;
  try {
    const thread = await Thread.findOneAndUpdate(
      { threadId: req.params.threadId },
      {
        $set: {
          ...(model !== undefined && { "settings.model": model }),
          ...(temperature !== undefined && { "settings.temperature": temperature }),
          ...(maxTokens !== undefined && { "settings.maxTokens": maxTokens }),
          ...(topP !== undefined && { "settings.topP": topP }),
          ...(systemPrompt !== undefined && { "settings.systemPrompt": systemPrompt }),
          ...(switchPolicy !== undefined && { "settings.switchPolicy": switchPolicy }),
          updatedAt: new Date(),
        },
      },
      { new: true, upsert: true, setDefaultsOnInsert: true }
    );
    res.json(thread.settings);
  } catch (err) {
    console.error("Failed to update settings", err);
    res.status(500).json({ error: "Failed to update settings" });
  }
});

/* ================================ models ================================ */

router.get("/models", (req, res) => {
  res.json(registry.catalogWithStatus());
});

router.get("/providers", (req, res) => {
  res.json(registry.snapshot());
});

router.get("/providers/health", async (req, res) => {
  try {
    res.json(await registry.healthCheckAll());
  } catch (err) {
    console.error("Health check failed", err);
    res.status(500).json({ error: "Health check failed" });
  }
});

/* ================================= chat ================================= */

/** Build the message list sent to the provider, including the system prompt. */
function buildMessages(thread, userMessage) {
  const history = thread.message.map((m) => ({ role: m.role, content: m.content }));
  const system = thread.settings?.systemPrompt?.trim();
  return [
    ...(system ? [{ role: "system", content: system }] : []),
    ...history,
    { role: "user", content: userMessage },
  ];
}

async function loadOrCreateThread(threadId, message, settings = {}) {
  let thread = await Thread.findOne({ threadId });
  if (!thread) {
    thread = new Thread({
      threadId,
      title: message.trim().slice(0, 80),
      message: [],
      settings,
    });
  }
  return thread;
}

/**
 * Non-streaming chat. Routes through the model router so quota/rate-limit/
 * outage failures fail over to the next best provider — and reports it.
 */
router.post("/chat", async (req, res) => {
  const { threadId, message, model, temperature, maxTokens, topP, systemPrompt, switchPolicy } = req.body;

  if (typeof threadId !== "string" || typeof message !== "string" || !message.trim()) {
    return res.status(400).json({ error: "threadId and message are required" });
  }

  try {
    const thread = await loadOrCreateThread(threadId, message);

    // request-level settings win over stored ones
    if (model) thread.settings.model = model;
    if (temperature !== undefined) thread.settings.temperature = temperature;
    if (maxTokens !== undefined) thread.settings.maxTokens = maxTokens;
    if (topP !== undefined) thread.settings.topP = topP;
    if (systemPrompt !== undefined) thread.settings.systemPrompt = systemPrompt;
    if (switchPolicy) thread.settings.switchPolicy = switchPolicy;

    const conversation = buildMessages(thread, message.trim());
    const options = {
      temperature: thread.settings.temperature,
      maxTokens: thread.settings.maxTokens,
      topP: thread.settings.topP,
      systemPrompt: thread.settings.systemPrompt,
    };

    const ac = new AbortController();
    req.on("close", () => ac.abort());

    const { result, model: used, switched } = await route("generate", {
      modelId: thread.settings.model,
      switchPolicy: thread.settings.switchPolicy || SwitchPolicy.AUTO,
      signal: ac.signal,
      invoke: (provider, m) => provider.generate(conversation, { ...options, model: m.id, signal: ac.signal }),
    });

    thread.message.push({ role: "user", content: message.trim() });
    thread.message.push({
      role: "assistant",
      content: result.text,
      model: used.id,
      provider: used.provider,
    });
    thread.updatedAt = new Date();
    await thread.save();

    res.json({
      reply: result.text,
      model: used.id,
      provider: used.provider,
      usage: result.usage ?? null,
      switched,
    });
  } catch (err) {
    handleChatError(err, res);
  }
});

/**
 * Streaming chat over Server-Sent Events.
 * Frames: {type:"switched"|"delta"|"done"|"error", ...}
 */
router.post("/chat/stream", async (req, res) => {
  const { threadId, message, model, temperature, maxTokens, topP, systemPrompt, switchPolicy } = req.body;

  if (typeof threadId !== "string" || typeof message !== "string" || !message.trim()) {
    return res.status(400).json({ error: "threadId and message are required" });
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();

  const send = (payload) => res.write(`data: ${JSON.stringify(payload)}\n\n`);

  try {
    const thread = await loadOrCreateThread(threadId, message);
    if (model) thread.settings.model = model;
    if (temperature !== undefined) thread.settings.temperature = temperature;
    if (maxTokens !== undefined) thread.settings.maxTokens = maxTokens;
    if (topP !== undefined) thread.settings.topP = topP;
    if (systemPrompt !== undefined) thread.settings.systemPrompt = systemPrompt;
    if (switchPolicy) thread.settings.switchPolicy = switchPolicy;

    const conversation = buildMessages(thread, message.trim());
    const options = {
      temperature: thread.settings.temperature,
      maxTokens: thread.settings.maxTokens,
      topP: thread.settings.topP,
      systemPrompt: thread.settings.systemPrompt,
    };

    let full = "";
    const ac = new AbortController();
    let cancelled = false;
    req.on("close", () => {
      cancelled = true;
      ac.abort();
    });

    // The router retries on a fresh provider; buffer per attempt so a failover
    // mid-stream restarts cleanly instead of concatenating two half answers.
    const { model: used, switched } = await route("stream", {
      modelId: thread.settings.model,
      switchPolicy: thread.settings.switchPolicy || SwitchPolicy.AUTO,
      signal: ac.signal,
      invoke: async (provider, m) => {
        full = "";
        // a failover notice reaches the client before the new stream's tokens
        if (m.id !== thread.settings.model) send({ type: "provider", provider: m.provider, model: m.id });
        for await (const delta of provider.stream(conversation, { ...options, model: m.id, signal: ac.signal })) {
          full += delta;
          send({ type: "delta", text: delta });
        }
        if (!full) throw new ProviderError(`${provider.name} returned an empty response`, "outage");
        return full;
      },
    });

    if (cancelled) return; // client already gone; nothing to persist or send

    if (switched) send({ type: "switched", ...switched, message: switched.message });

    thread.message.push({ role: "user", content: message.trim() });
    thread.message.push({ role: "assistant", content: full, model: used.id, provider: used.provider });
    thread.updatedAt = new Date();
    await thread.save();

    send({ type: "done", model: used.id, provider: used.provider, switched });
    res.end();
  } catch (err) {
    if (err?.name === "AbortError") return res.end(); // client disconnected
    send({
      type: "error",
      error: err.message,
      kind: err.kind ?? "api_error",
      requiresConfirmation: Boolean(err.requiresConfirmation),
      suggestion: err.suggestion ?? null,
    });
    res.end();
  }
});

function handleChatError(err, res) {
  if (err instanceof ProviderError) {
    const status = err.kind === "auth" ? 401 : err.kind === "quota" || err.kind === "rate_limit" ? 429 : 502;
    return res.status(status).json({
      error: err.message,
      kind: err.kind,
      requiresConfirmation: Boolean(err.requiresConfirmation),
      suggestion: err.suggestion ?? null,
    });
  }
  console.error("Chat request failed", err);
  res.status(500).json({ error: "Unable to generate a reply" });
}

export default router;
