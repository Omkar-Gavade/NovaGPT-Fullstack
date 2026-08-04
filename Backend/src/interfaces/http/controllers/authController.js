import { Router } from "express";
import { validate } from "../middleware/validate.js";
import { requireAuth } from "../middleware/authenticate.js";
import { rateLimit } from "../middleware/rateLimit.js";
import { parseCookies, serializeCookie, clearCookie } from "../../../infrastructure/security/cookies.js";
import {
  registerSchema,
  loginSchema,
  refreshSchema,
  logoutSchema,
  changePasswordSchema,
} from "../schemas/authSchemas.js";

/**
 * Authentication endpoints.
 *
 * The response shape is the same for every successful flow: the account, and an
 * access token with its lifetime. The refresh token is **never in the body** —
 * it goes out as an httpOnly cookie, unreachable from JavaScript, so an XSS bug
 * steals a 15-minute credential rather than 30 days of account access (T6).
 *
 * Every route here is rate limited per IP and fails **closed** when the counter
 * store is unavailable: the thing being protected is credentials, and refusing
 * logins for a few minutes beats permitting unlimited credential stuffing (T9).
 */
export function authController({ authService, limiter, rules, config, metrics }) {
  const router = Router();
  const guard = rateLimit({ limiter, rules: rules.auth, subject: "ip", metrics });
  const cookie = config.auth.cookie;

  const context = (req) => ({
    ip: req.ip ?? req.socket?.remoteAddress ?? null,
    userAgent: req.get("user-agent") ?? null,
    traceId: req.context?.traceId ?? null,
  });

  /** Set the refresh cookie and return the body every auth flow shares. */
  const respond = (res, { user, tokens }, status = 200) => {
    res.append(
      "Set-Cookie",
      serializeCookie({
        name: cookie.name,
        value: tokens.refreshToken,
        maxAgeMs: config.auth.refreshTtlMs,
        secure: cookie.secure,
        domain: cookie.domain,
      })
    );
    res.status(status).json({
      data: {
        user: user.toPublicJSON(),
        accessToken: tokens.accessToken,
        expiresIn: tokens.expiresIn,
        tokenType: "Bearer",
      },
    });
  };

  router.post("/auth/register", guard, validate(registerSchema), async (req, res) => {
    const result = await authService.register({
      email: req.body.email,
      password: req.body.password,
      displayName: req.body.displayName ?? null,
      context: context(req),
    });
    respond(res, result, 201);
  });

  router.post("/auth/login", guard, validate(loginSchema), async (req, res) => {
    const result = await authService.login({
      email: req.body.email,
      password: req.body.password,
      context: context(req),
    });
    respond(res, result);
  });

  /**
   * Exchange the refresh cookie for a new pair.
   *
   * Deliberately not `requireAuth`: the access token is expected to be expired
   * by the time a client calls this, which is the entire point of the endpoint.
   */
  router.post("/auth/refresh", guard, validate(refreshSchema), async (req, res) => {
    const cookies = parseCookies(req.get("cookie"));
    const result = await authService.refresh({
      refreshToken: cookies[cookie.name] ?? req.body.refreshToken ?? null,
      context: context(req),
    });
    respond(res, result);
  });

  router.post("/auth/logout", validate(logoutSchema), async (req, res) => {
    await authService.logout({
      principal: req.principal,
      claims: req.tokenClaims,
      everywhere: req.body.everywhere === true,
      context: context(req),
    });

    // Cleared unconditionally, including for a caller who was never signed in.
    // A logout that leaves the cookie in place is a logout that did not happen.
    res.append("Set-Cookie", clearCookie({ name: cookie.name, secure: cookie.secure, domain: cookie.domain }));
    res.json({ data: { loggedOut: true } });
  });

  router.get("/auth/me", requireAuth({ metrics }), async (req, res) => {
    const user = await authService.me(req.principal);
    res.json({ data: user.toPublicJSON() });
  });

  router.post(
    "/auth/password",
    guard,
    requireAuth({ metrics }),
    validate(changePasswordSchema),
    async (req, res) => {
      // Every other session ends, and the caller is handed a fresh pair so the
      // tab they changed it in is not signed out along with the thief.
      const result = await authService.changePassword({
        principal: req.principal,
        currentPassword: req.body.currentPassword,
        newPassword: req.body.newPassword,
        context: context(req),
      });
      respond(res, result);
    }
  );

  return router;
}
