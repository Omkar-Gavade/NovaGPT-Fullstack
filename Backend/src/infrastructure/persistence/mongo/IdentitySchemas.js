import mongoose from "mongoose";

/**
 * The Mongo shapes for identity: accounts, refresh sessions, audit entries.
 *
 * Deliberately dumb, like `ThreadSchema`. Every rule lives in the aggregates —
 * a schema with business logic in it is a second source of truth that drifts
 * from the first one.
 */

export const UserSchema = new mongoose.Schema(
  {
    id: { type: String, required: true, unique: true },
    // Stored already normalised (lower-cased, trimmed). The unique index is
    // what actually prevents two accounts for one address — a check-then-insert
    // in application code loses that race under concurrent registration.
    email: { type: String, required: true, unique: true },
    passwordHash: { type: String, required: true },
    role: { type: String, enum: ["user", "admin"], default: "user" },
    displayName: { type: String, default: null },

    failedLoginCount: { type: Number, default: 0 },
    lockedUntil: { type: Date, default: null },

    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now },
    lastLoginAt: { type: Date, default: null },
    // Every access token issued before this instant is rejected, which is what
    // makes a password change evict a thief who already holds one.
    passwordChangedAt: { type: Date, default: Date.now },
    disabledAt: { type: Date, default: null },
  },
  { versionKey: "_v" }
);

// `unique: true` on the fields above already creates both indexes; repeating
// them here makes Mongoose warn about a duplicate definition on every boot.

export const SessionSchema = new mongoose.Schema(
  {
    id: { type: String, required: true, unique: true },
    // The login this token belongs to. Reuse detection revokes the family, not
    // the token: revoking only the replayed one leaves the thief's next token
    // working.
    familyId: { type: String, required: true },
    userId: { type: String, required: true },
    // A hash, never the token. A database dump then yields nothing usable —
    // the same reasoning as password hashing.
    tokenHash: { type: String, required: true },

    issuedAt: { type: Date, default: Date.now },
    expiresAt: { type: Date, required: true },
    usedAt: { type: Date, default: null },
    revokedAt: { type: Date, default: null },
    replacedBy: { type: String, default: null },
    clientHash: { type: String, default: null },
  },
  { versionKey: false }
);

// Reuse detection and "log out everywhere" both scan by family and by user.
SessionSchema.index({ familyId: 1 });
SessionSchema.index({ userId: 1, revokedAt: 1 });
// Mongo removes expired sessions on its own; a cleanup job that must be
// remembered is a cleanup job that eventually is not.
SessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const AuditSchema = new mongoose.Schema(
  {
    id: { type: String, required: true, unique: true },
    at: { type: Date, default: Date.now },
    action: { type: String, required: true },
    actorId: { type: String, default: null },
    actorIp: { type: String, default: null },
    resourceType: { type: String, default: null },
    resourceId: { type: String, default: null },
    outcome: { type: String, enum: ["success", "failure", "denied"], required: true },
    traceId: { type: String, default: null },
    // Identifiers and counts only. Never message content, prompts, completions,
    // key values or passwords — including them would make the audit log itself
    // the highest-value disclosure target in the system (T13).
    metadata: { type: mongoose.Schema.Types.Mixed, default: null },
  },
  { versionKey: false }
);

AuditSchema.index({ at: -1 });
AuditSchema.index({ actorId: 1, at: -1 });
AuditSchema.index({ action: 1, at: -1 });
// One-year retention (docs/backend/08-storage.md#retention-and-ttl).
AuditSchema.index({ at: 1 }, { expireAfterSeconds: 365 * 24 * 60 * 60 });
