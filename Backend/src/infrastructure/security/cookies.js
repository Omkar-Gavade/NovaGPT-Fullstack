/**
 * Cookie reading and writing for the refresh token.
 *
 * Hand-written rather than `cookie-parser`, for the same reason the JWT codec
 * is: this is thirty lines of well-specified string handling, and every
 * dependency is code we ship and cannot audit (T14). It also parses **only**
 * what this application sets, so a malformed third-party cookie cannot make
 * request handling throw.
 *
 * The refresh token is the high-value credential, and it lives in an httpOnly
 * cookie precisely so JavaScript cannot read it: an XSS bug then steals a
 * 15-minute access token instead of 30 days of account access (T6). The access
 * token is *not* a cookie — it is held in client memory, so it is never sent
 * ambiently and CSRF is not a concern for the API
 * (docs/backend/10-security.md#authentication).
 */

export function parseCookies(header) {
  const out = {};
  if (typeof header !== "string" || header.length === 0) return out;

  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index < 1) continue;
    const name = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (!name) continue;
    try {
      out[name] = decodeURIComponent(value);
    } catch {
      // A cookie we did not set, encoded in a way we do not understand. Skip it
      // rather than failing a request that has nothing to do with it.
      out[name] = value;
    }
  }
  return out;
}

/**
 * @param {object} options
 * @param {string} options.name
 * @param {string} options.value
 * @param {number} options.maxAgeMs
 * @param {boolean} options.secure    `false` only for plain-HTTP local development
 * @param {string} [options.path]
 * @param {string} [options.domain]
 */
export function serializeCookie({ name, value, maxAgeMs, secure, path = "/", domain }) {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    `Path=${path}`,
    `Max-Age=${Math.floor(maxAgeMs / 1000)}`,
    "HttpOnly",
    // Strict rather than Lax: this cookie authorises minting new access tokens,
    // so there is no cross-site navigation that should ever carry it.
    "SameSite=Strict",
  ];
  if (secure) parts.push("Secure");
  if (domain) parts.push(`Domain=${domain}`);
  return parts.join("; ");
}

/** Expire a cookie. Must repeat Path and Domain, or the browser keeps the original. */
export function clearCookie({ name, secure, path = "/", domain }) {
  const parts = [`${name}=`, `Path=${path}`, "Max-Age=0", "HttpOnly", "SameSite=Strict"];
  if (secure) parts.push("Secure");
  if (domain) parts.push(`Domain=${domain}`);
  return parts.join("; ");
}
