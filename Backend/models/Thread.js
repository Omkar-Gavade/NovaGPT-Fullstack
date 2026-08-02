import mongoose from "mongoose";

const MessageSchema = new mongoose.Schema({
  role: {
    type: String,
    enum: ["user", "assistant"],
    required: true,
  },
  content: {
    type: String,
    required: true,
  },
  // which model actually produced an assistant message (null for user turns)
  model: {
    type: String,
    default: null,
  },
  provider: {
    type: String,
    default: null,
  },
  timestamp: {
    type: Date,
    default: Date.now,
  },
});

/** Per-conversation generation settings, owned by the workspace panel. */
const SettingsSchema = new mongoose.Schema(
  {
    model: { type: String, default: "gemini-2.5-flash" },
    temperature: { type: Number, default: 0.7, min: 0, max: 2 },
    maxTokens: { type: Number, default: 2048 },
    topP: { type: Number, default: 1, min: 0, max: 1 },
    systemPrompt: { type: String, default: "" },
    switchPolicy: { type: String, enum: ["auto", "ask", "never"], default: "auto" },
  },
  { _id: false }
);

const ThreadSchema = new mongoose.Schema({
  threadId: {
    type: String,
    required: true,
    unique: true,
  },
  title: {
    type: String,
    default: "New Chat",
  },
  message: [MessageSchema],
  settings: {
    type: SettingsSchema,
    default: () => ({}),
  },
  pinned: {
    type: Boolean,
    default: false,
  },
  archived: {
    type: Boolean,
    default: false,
  },
  shareId: {
    type: String,
    default: null,
    index: true,
  },
  createdAt: {
    type: Date,
    default: Date.now,
  },
  updatedAt: {
    type: Date,
    default: Date.now,
  },
});

export default mongoose.model("Thread", ThreadSchema);
