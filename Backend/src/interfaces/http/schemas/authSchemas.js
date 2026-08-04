import { z } from "zod";

/**
 * Auth request validation.
 *
 * `.strict()` like every other schema, and `z.string()` everywhere a string is
 * expected — never a permissive type. That second point is the NoSQL injection
 * defence (T10): `{"email": {"$ne": null}}` is a valid JSON body, and a schema
 * that accepted an object would hand that operator straight to a Mongo query
 * (docs/backend/10-security.md#input-validation).
 *
 * Length limits are here rather than only in the domain because they bound work
 * done *before* the domain sees the request — Argon2id spends 64 MB per call,
 * and an unbounded password field is a memory-exhaustion vector that needs no
 * account.
 */

const email = z.string().min(3).max(254);
const password = z.string().min(1).max(256);

export const registerSchema = z
  .object({
    email,
    password,
    displayName: z.string().min(1).max(80).optional(),
  })
  .strict();

export const loginSchema = z.object({ email, password }).strict();

/**
 * The refresh token normally arrives in an httpOnly cookie. The optional body
 * field exists for non-browser clients, which have no cookie jar — it is not a
 * fallback the browser flow ever uses.
 */
export const refreshSchema = z
  .object({ refreshToken: z.string().min(16).max(4096).optional() })
  .strict();

export const logoutSchema = z.object({ everywhere: z.boolean().optional() }).strict();

export const changePasswordSchema = z
  .object({ currentPassword: password, newPassword: password })
  .strict();
