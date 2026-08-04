import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { User } from "../../src/domain/identity/User.js";
import { Session } from "../../src/domain/identity/Session.js";
import { Principal } from "../../src/domain/identity/Principal.js";
import { LockoutPolicy } from "../../src/domain/identity/LockoutPolicy.js";
import { Role, Permission, roleGrants } from "../../src/domain/identity/Role.js";
import { assertEmail, assertPassword, normaliseEmail } from "../../src/domain/identity/Credentials.js";
import { Argon2Hasher } from "../../src/infrastructure/security/Argon2Hasher.js";
import { AppError } from "../../src/domain/errors/index.js";

describe("Credentials", () => {
  test("normalises case and whitespace", () => {
    // Without this, `Alice@x.com` and `alice@x.com` are two accounts, one of
    // which the user cannot log into and neither of which they can tell apart.
    assert.equal(normaliseEmail("  Alice@Example.COM "), "alice@example.com");
  });

  test("rejects an obviously malformed address", () => {
    assert.throws(() => assertEmail("not-an-email"), AppError);
    assert.throws(() => assertEmail(""), AppError);
  });

  test("enforces length over composition", () => {
    assert.throws(() => assertPassword("short", { minLength: 12 }), AppError);
    assert.equal(assertPassword("a-long-enough-passphrase"), "a-long-enough-passphrase");
  });

  test("rejects breach-list passwords that pass the length rule", () => {
    // The top handful of passwords account for a wildly disproportionate share
    // of successful credential stuffing, and rejecting them costs a lookup.
    assert.throws(() => assertPassword("1234567890", { minLength: 8 }), AppError);
    assert.throws(() => assertPassword("Password123", { minLength: 8 }), AppError);
  });

  test("rejects an unbounded password", () => {
    // Argon2id hashes whatever it is given: an unbounded field is 64 MB of
    // memory-hard work per unauthenticated request.
    assert.throws(() => assertPassword("x".repeat(5000)), AppError);
  });
});

describe("LockoutPolicy", () => {
  const policy = new LockoutPolicy({ threshold: 3, baseDelayMs: 1000, maxDelayMs: 8000 });

  test("does not lock below the threshold", () => {
    assert.equal(policy.durationFor(2), 0);
  });

  test("escalates, then stops at the ceiling", () => {
    assert.equal(policy.durationFor(3), 1000);
    assert.equal(policy.durationFor(4), 2000);
    assert.equal(policy.durationFor(5), 4000);
    assert.equal(policy.durationFor(6), 8000);
    // Uncapped escalation is a permanent lock, which hands an attacker a
    // denial-of-service primitive against any address they know.
    assert.equal(policy.durationFor(20), 8000);
  });
});

describe("User", () => {
  const base = () =>
    new User({ id: "u1", email: "a@b.co", passwordHash: "$test$hash", role: Role.USER });

  test("never exposes the password hash in the API shape", () => {
    const json = JSON.stringify(base().toPublicJSON());
    assert.ok(!json.includes("hash"), json);
  });

  test("a successful login clears the escalation", () => {
    const policy = new LockoutPolicy({ threshold: 1, baseDelayMs: 1000 });
    const locked = base().withFailedLogin(1000, policy).withFailedLogin(2000, policy);
    assert.ok(locked.isLocked(2000));

    const recovered = locked.withSuccessfulLogin(3000);
    assert.equal(recovered.failedLoginCount, 0);
    assert.equal(recovered.isLocked(3000), false);
  });

  test("a password change moves the eviction boundary", () => {
    // Every token issued before this instant stops being accepted — otherwise
    // changing a password does nothing about the thief who already has one.
    const changed = base().withPassword("$test$new", 5_000);
    assert.equal(changed.passwordChangedAt.getTime(), 5_000);
  });

  test("an unknown stored role degrades to the least privilege", () => {
    const user = new User({ id: "u", email: "a@b.co", passwordHash: "h", role: "superuser" });
    assert.equal(user.role, Role.USER);
  });
});

describe("Session", () => {
  const session = () =>
    new Session({
      id: "s1",
      familyId: "f1",
      userId: "u1",
      tokenHash: "h",
      expiresAt: new Date(10_000).toISOString(),
    });

  test("is usable exactly once", () => {
    assert.equal(session().isUsable(0), true);
    assert.equal(session().rotatedTo("s2", 1).isUsable(2), false);
  });

  test("is unusable once revoked or expired", () => {
    assert.equal(session().revoked(1).isUsable(2), false);
    assert.equal(session().isUsable(20_000), false);
  });
});

describe("Principal", () => {
  test("anonymous is a real principal, not a null", () => {
    const anon = Principal.anonymous();
    assert.equal(anon.isAuthenticated, false);
    // `null` is an owner scope, not a wildcard: anonymous callers see threads
    // with no owner and nothing else.
    assert.equal(anon.ownerId, null);
  });

  test("grants follow the role table", () => {
    assert.equal(roleGrants(Role.ANONYMOUS, Permission.CHAT), false);
    assert.equal(roleGrants(Role.USER, Permission.CHAT), true);
    assert.equal(roleGrants(Role.USER, Permission.ADMIN_METRICS), false);
    assert.equal(roleGrants(Role.ADMIN, Permission.ADMIN_METRICS), true);
    // A typo in a stored role must not escalate.
    assert.equal(roleGrants("root", Permission.CHAT), false);
  });

  test("log fields carry no email", () => {
    const fields = new Principal({ id: "u1", role: Role.USER, email: "a@b.co" }).toLogFields();
    assert.ok(!JSON.stringify(fields).includes("a@b.co"));
  });
});

describe("Argon2Hasher", () => {
  // The real hasher, at the real cost. Slow on purpose, so kept to the few
  // assertions that are actually about Argon2id.
  const hasher = new Argon2Hasher();

  test("verifies its own hash and rejects a wrong password", async () => {
    const hash = await hasher.hash("a-long-enough-passphrase");
    assert.match(hash, /^\$argon2id\$v=19\$m=65536,t=3,p=4\$/);
    assert.equal(await hasher.verify(hash, "a-long-enough-passphrase"), true);
    assert.equal(await hasher.verify(hash, "a-long-enough-passphrasf"), false);
  });

  test("a corrupt stored hash reads as a mismatch, not an error", async () => {
    // A 500 here would tell an attacker the account exists and is in an
    // unusual state.
    assert.equal(await hasher.verify("not-a-hash", "whatever"), false);
    assert.equal(await hasher.verify(null, "whatever"), false);
  });

  test("flags hashes made with weaker parameters for rehash", () => {
    assert.equal(hasher.needsRehash("$argon2id$v=19$m=4096,t=1,p=1$abc$def"), true);
    assert.equal(hasher.needsRehash("$2b$10$bcryptstyle"), true);
    assert.equal(hasher.needsRehash("$argon2id$v=19$m=65536,t=3,p=4$abc$def"), false);
  });
});
