import { randomUUID, createHash } from "node:crypto";
import { User } from "../../domain/identity/User.js";
import { Role } from "../../domain/identity/Role.js";
import { assertEmail, assertPassword, normaliseEmail } from "../../domain/identity/Credentials.js";
import { AppError, ErrorKind } from "../../domain/errors/index.js";

/**
 * Registration, login, refresh, logout, password change.
 *
 * Two properties run through everything here and are worth stating once:
 *
 * **Failures are indistinguishable.** A wrong password, an unknown email and a
 * disabled account all produce the same message and the same timing. Anything
 * else is an account-enumeration oracle: an attacker who can tell "no such
 * user" from "wrong password" has a free list of valid addresses to stuff.
 *
 * **Every outcome is audited, including the failures.** A login failure that is
 * not recorded is a credential-stuffing campaign nobody can see (T9).
 */
export class AuthService {
  constructor({
    users,
    tokens,
    hasher,
    audit,
    lockoutPolicy,
    clock,
    logger,
    metrics,
    passwordPolicy = {},
    allowRegistration = true,
  }) {
    this.users = users;
    this.tokens = tokens;
    this.hasher = hasher;
    this.audit = audit;
    this.lockoutPolicy = lockoutPolicy;
    this.clock = clock;
    this.logger = logger?.child?.({ component: "auth" }) ?? logger;
    this.metrics = metrics;
    this.passwordPolicy = passwordPolicy;
    this.allowRegistration = allowRegistration;
  }

  /* ------------------------------- register ---------------------------- */

  async register({ email: rawEmail, password: rawPassword, displayName = null, context = {} }) {
    if (!this.allowRegistration) {
      throw new AppError("Registration is closed on this deployment.", ErrorKind.FORBIDDEN);
    }

    const email = assertEmail(rawEmail);
    const password = assertPassword(rawPassword, this.passwordPolicy);
    const now = this.clock.now();

    // The first account is the operator's. Bootstrapping an admin any other way
    // means either a seeded default password or a manual database edit, and the
    // first of those is a well-known credential shipped to every deployment.
    const role = (await this.users.count()) === 0 ? Role.ADMIN : Role.USER;

    const user = new User({
      id: randomUUID(),
      email,
      passwordHash: await this.hasher.hash(password),
      role,
      displayName,
      createdAt: new Date(now).toISOString(),
      updatedAt: new Date(now).toISOString(),
      passwordChangedAt: new Date(now).toISOString(),
    });

    // Duplicate registration surfaces as a CONFLICT from the repository, where
    // the unique index is. There is no check-then-insert here, because two
    // simultaneous registrations both pass a check.
    const saved = await this.users.save(user);

    await this.#audit("auth.register", "success", { actorId: saved.id, context });
    this.metrics?.increment("nova_auth_events_total", { event: "register", outcome: "success" });

    const tokens = await this.tokens.issue(saved, { clientHash: clientHash(context) });
    return { user: saved, tokens };
  }

  /* --------------------------------- login ----------------------------- */

  async login({ email: rawEmail, password, context = {} }) {
    const email = normaliseEmail(rawEmail);
    const now = this.clock.now();
    const user = await this.users.findByEmail(email);

    if (!user || user.isDisabled) {
      // Verify against a decoy anyway. Returning early for an unknown address
      // makes the response measurably faster than for a known one, which is an
      // enumeration oracle that no amount of identical wording fixes.
      await this.hasher.verify(await this.#decoyHash(), String(password ?? ""));
      await this.#audit("auth.login", "failure", { context, metadata: { reason: "unknown" } });
      this.metrics?.increment("nova_auth_events_total", { event: "login", outcome: "failure" });
      throw invalidCredentials();
    }

    if (user.isLocked(now)) {
      await this.#audit("auth.login", "denied", {
        actorId: user.id,
        context,
        metadata: { reason: "locked" },
      });
      this.metrics?.increment("nova_auth_events_total", { event: "login", outcome: "locked" });
      throw new AppError(
        "Too many failed attempts. Try again shortly.",
        ErrorKind.RATE_LIMITED,
        {
          expected: true,
          details: { retryAfterSeconds: Math.ceil(user.lockRemainingMs(now) / 1000) },
        }
      );
    }

    const matches = await this.hasher.verify(user.passwordHash, String(password ?? ""));
    if (!matches) {
      const failed = user.withFailedLogin(now, this.lockoutPolicy);
      await this.users.save(failed);
      await this.#audit("auth.login", "failure", {
        actorId: user.id,
        context,
        metadata: { reason: "password", failures: failed.failedLoginCount },
      });
      this.metrics?.increment("nova_auth_events_total", { event: "login", outcome: "failure" });
      throw invalidCredentials();
    }

    // Rehash on a successful login when the parameters have been raised. This
    // is the only moment the plaintext is available, so it is the only chance
    // to upgrade a stored hash without asking the user to change anything.
    const passwordHash = this.hasher.needsRehash(user.passwordHash)
      ? await this.hasher.hash(String(password))
      : user.passwordHash;

    const authenticated = await this.users.save(
      new User({ ...user.withSuccessfulLogin(now).toJSON(), passwordHash })
    );

    await this.#audit("auth.login", "success", { actorId: authenticated.id, context });
    this.metrics?.increment("nova_auth_events_total", { event: "login", outcome: "success" });

    const tokens = await this.tokens.issue(authenticated, { clientHash: clientHash(context) });
    return { user: authenticated, tokens };
  }

  /* -------------------------------- refresh ---------------------------- */

  async refresh({ refreshToken, context = {} }) {
    if (!refreshToken) throw sessionExpired();

    const result = await this.tokens.rotate(refreshToken, {
      users: this.users,
      clientHash: clientHash(context),
    });

    if (!result.ok) {
      if (result.reason === "reuse_detected") {
        // The one auth event that is a genuine security incident rather than an
        // expected end-of-session, so it is recorded as its own action.
        await this.#audit("auth.refresh_reuse", "denied", {
          actorId: result.userId ?? null,
          context,
        });
        this.metrics?.increment("nova_auth_events_total", { event: "refresh", outcome: "reuse" });
        throw new AppError(
          "This session was ended for security reasons. Sign in again.",
          ErrorKind.UNAUTHENTICATED,
          { expected: true }
        );
      }
      await this.#audit("auth.refresh", "failure", {
        context,
        metadata: { reason: result.reason },
      });
      this.metrics?.increment("nova_auth_events_total", { event: "refresh", outcome: "failure" });
      throw sessionExpired();
    }

    await this.#audit("auth.refresh", "success", { actorId: result.user.id, context });
    this.metrics?.increment("nova_auth_events_total", { event: "refresh", outcome: "success" });
    return result;
  }

  /* --------------------------------- logout ---------------------------- */

  async logout({ principal, claims = null, everywhere = false, context = {} }) {
    if (!principal?.isAuthenticated) return { loggedOut: true };

    if (everywhere) {
      await this.tokens.revokeAllForUser(principal.id);
    } else {
      await this.tokens.revoke({
        tokenId: principal.tokenId,
        expiresAtMs: claims?.exp ? claims.exp * 1000 : this.clock.now() + 60_000,
        familyId: principal.sessionId,
      });
    }

    await this.#audit(everywhere ? "auth.logout_all" : "auth.logout", "success", {
      actorId: principal.id,
      context,
    });
    return { loggedOut: true };
  }

  /* ---------------------------- change password ------------------------ */

  /**
   * Changing a password ends every other session.
   *
   * A user changing their password is almost always trying to evict someone.
   * Leaving other sessions alive makes the action cosmetic — and the refresh
   * token in the thief's cookie would outlive the change by 30 days.
   */
  async changePassword({ principal, currentPassword, newPassword, context = {} }) {
    const user = await this.users.findById(principal.id);
    if (!user) throw new AppError("Account not found.", ErrorKind.NOT_FOUND);

    const matches = await this.hasher.verify(user.passwordHash, String(currentPassword ?? ""));
    if (!matches) {
      await this.#audit("auth.password_change", "failure", { actorId: user.id, context });
      throw new AppError("That is not your current password.", ErrorKind.UNAUTHENTICATED, {
        field: "currentPassword",
        expected: true,
      });
    }

    const password = assertPassword(newPassword, this.passwordPolicy);
    const now = this.clock.now();
    const updated = await this.users.save(
      user.withPassword(await this.hasher.hash(password), now)
    );

    await this.tokens.revokeAllForUser(user.id);
    await this.#audit("auth.password_change", "success", { actorId: user.id, context });

    const tokens = await this.tokens.issue(updated, { clientHash: clientHash(context) });
    return { user: updated, tokens };
  }

  async me(principal) {
    const user = await this.users.findById(principal.id);
    if (!user) throw new AppError("Account not found.", ErrorKind.NOT_FOUND);
    return user;
  }

  /**
   * A real hash of a value nobody knows, computed once and reused.
   *
   * It has to be produced by the configured hasher: a hard-coded string with
   * the wrong parameters — or one the hasher rejects as malformed — returns
   * immediately, which is the timing difference this exists to remove.
   */
  #decoyHash() {
    this.decoy ??= this.hasher.hash(randomUUID() + randomUUID());
    return this.decoy;
  }

  async #audit(action, outcome, { actorId = null, context = {}, metadata = null } = {}) {
    await this.audit.append({
      action,
      outcome,
      actorId,
      actorIp: context.ip ?? null,
      resourceType: "user",
      resourceId: actorId,
      traceId: context.traceId ?? null,
      metadata,
    });
  }
}

/**
 * One message for every credential failure.
 *
 * "No such account" and "wrong password" are the same answer here on purpose:
 * distinguishing them hands an attacker a validated address list for free.
 */
const invalidCredentials = () =>
  new AppError("Email or password is incorrect.", ErrorKind.UNAUTHENTICATED, { expected: true });

const sessionExpired = () =>
  new AppError("Your session has expired. Sign in again.", ErrorKind.UNAUTHENTICATED, {
    expected: true,
  });

/**
 * A coarse client fingerprint for the audit trail. Hashed, because a user agent
 * plus an IP address is personal data and the audit log is not the place to
 * keep it in the clear (docs/backend/10-security.md#audit-logging).
 */
function clientHash({ ip = null, userAgent = null } = {}) {
  if (!ip && !userAgent) return null;
  return createHash("sha256").update(`${ip ?? ""}|${userAgent ?? ""}`).digest("base64url").slice(0, 22);
}
