import { AppError, ErrorKind } from "../errors/index.js";

/**
 * Rules about what an email and a password may be.
 *
 * Pure and dependency-free so the same rules apply at registration, at a
 * password change, and anywhere a future entry point appears — a policy that
 * lives in a controller only holds for the controllers that remembered it.
 */

/**
 * Normalisation, applied before storage and before every lookup.
 *
 * Case folding matters more than it looks: without it `Alice@x.com` and
 * `alice@x.com` are two accounts, one of which the user cannot log into and
 * neither of which they can tell apart.
 */
export function normaliseEmail(value) {
  return String(value ?? "").trim().toLowerCase();
}

/**
 * Deliberately permissive. Strict email regexes reject valid addresses and
 * teach users that the product is broken; the real proof that an address exists
 * is delivery, not a pattern.
 */
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function assertEmail(value) {
  const email = normaliseEmail(value);
  if (!EMAIL.test(email) || email.length > 254) {
    throw new AppError("That does not look like an email address.", ErrorKind.VALIDATION, {
      field: "email",
    });
  }
  return email;
}

/**
 * A small breach list.
 *
 * Not a substitute for a real corpus (Have I Been Pwned's k-anonymity API is
 * the eventual answer). It is here because the top handful of passwords account
 * for a wildly disproportionate share of successful credential stuffing, and
 * rejecting them costs one comparison (T9).
 */
const COMMON = new Set([
  "password",
  "password1",
  "password123",
  "123456",
  "1234567",
  "12345678",
  "123456789",
  "1234567890",
  "qwerty",
  "qwerty123",
  "letmein",
  "welcome",
  "welcome1",
  "iloveyou",
  "admin",
  "admin123",
  "abc123",
  "monkey",
  "dragon",
  "football",
  "changeme",
  "passw0rd",
  "novagpt",
]);

/**
 * Length over composition rules.
 *
 * Character-class requirements produce `Passw0rd!` — predictable, and weaker
 * than a longer passphrase. Length is the property that actually costs an
 * attacker work, so that is the property enforced.
 */
export function assertPassword(value, { minLength = 12, maxLength = 256 } = {}) {
  const password = String(value ?? "");

  if (password.length < minLength) {
    throw new AppError(
      `A password must be at least ${minLength} characters.`,
      ErrorKind.VALIDATION,
      { field: "password" }
    );
  }
  // Argon2id hashes whatever it is given, but an unbounded password is an
  // unbounded amount of memory-hard work per login request — a denial of
  // service with a valid-looking request body.
  if (password.length > maxLength) {
    throw new AppError(
      `A password may be at most ${maxLength} characters.`,
      ErrorKind.VALIDATION,
      { field: "password" }
    );
  }
  if (COMMON.has(password.toLowerCase())) {
    throw new AppError(
      "That password appears in known breach lists. Choose another.",
      ErrorKind.VALIDATION,
      { field: "password" }
    );
  }
  return password;
}
