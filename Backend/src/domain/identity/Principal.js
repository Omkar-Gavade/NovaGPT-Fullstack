import { Role, roleGrants } from "./Role.js";

/**
 * Who is making this request.
 *
 * Every request has one — an unauthenticated request carries the anonymous
 * principal rather than `null`. That is the whole point: `req.principal.id`
 * is always safe to read, so there is no call site where a forgotten null
 * check turns into "no owner", and "no owner" is exactly the value that used
 * to mean "see everything" (docs/backend/10-security.md#authorization).
 */
export class Principal {
  /**
   * @param {object} raw
   * @param {string|null} raw.id
   * @param {string} raw.role
   * @param {string|null} [raw.email]
   * @param {string|null} [raw.tokenId] the access token's `jti`, for revocation
   * @param {string|null} [raw.sessionId] the refresh family this token belongs to
   */
  constructor({ id = null, role = Role.ANONYMOUS, email = null, tokenId = null, sessionId = null } = {}) {
    this.id = id;
    this.role = role;
    this.email = email;
    this.tokenId = tokenId;
    this.sessionId = sessionId;
    Object.freeze(this);
  }

  static anonymous() {
    return ANONYMOUS;
  }

  get isAuthenticated() {
    return this.id !== null && this.role !== Role.ANONYMOUS;
  }

  get isAdmin() {
    return this.role === Role.ADMIN;
  }

  can(permission) {
    return roleGrants(this.role, permission);
  }

  /**
   * The owner key used to scope every repository query.
   *
   * Anonymous callers scope to `null`, which is a real scope and not a wildcard:
   * they see threads with no owner and nothing else.
   */
  get ownerId() {
    return this.id;
  }

  /** Safe to log. Contains no token and no email — an email is personal data. */
  toLogFields() {
    return { userId: this.id, role: this.role };
  }
}

const ANONYMOUS = new Principal({ id: null, role: Role.ANONYMOUS });
