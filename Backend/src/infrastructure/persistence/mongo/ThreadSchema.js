import mongoose from "mongoose";

/**
 * The Mongo shape of a conversation.
 *
 * Messages are **embedded**, not a separate collection: they are never queried
 * independently of their thread, always loaded together, and immutable once
 * written. Embedding makes the hottest read one operation and the append atomic;
 * a separate collection would add a join to the hottest path in exchange for
 * flexibility nothing uses (docs/backend/08-storage.md#threads).
 *
 * Deliberately dumb. Every rule lives in the `Thread` aggregate — a schema with
 * business logic in it is a second source of truth that drifts.
 */

const MessageSchema = new mongoose.Schema(
  {
    id: { type: String, required: true },
    role: { type: String, enum: ["user", "assistant", "system", "tool"], required: true },
    content: { type: mongoose.Schema.Types.Mixed, required: true },
    model: { type: String, default: null },
    provider: { type: String, default: null },
    pinned: { type: Boolean, default: false },
    isSummary: { type: Boolean, default: false },
    // Cached at write time so assembly never recomputes it.
    tokenEstimate: { type: Number, default: null },
    usage: { type: mongoose.Schema.Types.Mixed, default: null },
    finishReason: { type: String, default: null },
    attachments: { type: [mongoose.Schema.Types.Mixed], default: [] },
    // Summaries only. The full objects belong in logs, not in every document.
    contextReport: { type: mongoose.Schema.Types.Mixed, default: null },
    routingDecision: { type: mongoose.Schema.Types.Mixed, default: null },
    error: { type: mongoose.Schema.Types.Mixed, default: null },
    createdAt: { type: Date, default: Date.now },
  },
  { _id: false }
);

const SettingsSchema = new mongoose.Schema(
  {
    model: { type: String, default: null },
    temperature: { type: Number, default: 0.7 },
    maxTokens: { type: Number, default: 2048 },
    topP: { type: Number, default: 1 },
    systemPrompt: { type: String, default: "" },
    switchPolicy: { type: String, enum: ["auto", "ask", "never"], default: "auto" },
  },
  { _id: false }
);

export const ThreadSchema = new mongoose.Schema(
  {
    id: { type: String, required: true, unique: true },
    userId: { type: String, default: null },
    tenantId: { type: String, default: null },
    title: { type: String, default: "New chat" },
    messages: { type: [MessageSchema], default: [] },
    settings: { type: SettingsSchema, default: () => ({}) },
    pinned: { type: Boolean, default: false },
    archived: { type: Boolean, default: false },
    shareId: { type: String, default: null },
    // Denormalised so the sidebar does not load every message of every thread.
    messageCount: { type: Number, default: 0 },
    totalTokens: { type: Number, default: 0 },
    tokenCorrectionFactor: { type: Number, default: 1 },
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now },
    lastMessageAt: { type: Date, default: null },
    // Soft delete: a 30-day undo window, then a real purge.
    deletedAt: { type: Date, default: null },
  },
  { versionKey: "_v" }
);

/*
 * Indexes. Every one serves a named query; an index without a query is write
 * amplification and storage cost for nothing
 * (docs/backend/08-storage.md#indexes).
 */

// The hottest query — loading one conversation — is served by the unique index
// `id: { unique: true }` above already creates. Declaring it a second time here
// makes Mongoose warn about a duplicate on every boot.

// Sidebar. ESR order — equality (userId, archived, deletedAt), then sort
// (updatedAt). Any other order forces an in-memory sort, which Mongo aborts
// above 32MB — failing for exactly the heaviest users.
ThreadSchema.index({ userId: 1, archived: 1, deletedAt: 1, updatedAt: -1 });

// Pinned-first sidebar ordering.
ThreadSchema.index({ userId: 1, pinned: -1, updatedAt: -1 });

// Public share lookup. Sparse because most threads are unshared, and a
// non-sparse index would store an entry for every one of them.
ThreadSchema.index({ shareId: 1 }, { sparse: true });

// Purge job: find soft-deleted threads past the undo window.
ThreadSchema.index({ deletedAt: 1 }, { sparse: true });

export const THREAD_COLLECTION = "threads";
