import { Principal } from "../../../domain/identity/Principal.js";
import { AppError, ErrorKind } from "../../../domain/errors/index.js";
import { routeLabel } from "../routeLabel.js";
import { enrichContext } from "../../../infrastructure/telemetry/traceContext.js";

/**
 * Establish `req.principal` for every request.
 *
 * Runs on *all* routes and never refuses one. A request with no token gets the
 * anonymous principal, a request with a bad token gets the anonymous principal
 * and a recorded reason. Refusing is the job of `requireAuth`, further down the
 * chain and per route.
 *
 * The split matters. If this middleware also enforced, then every public route
 * would need to be exempted from it, and the failure mode of an exemption list
 * is a *forgotten* entry — which fails open for the route someone forgot
 * (docs/backend/10-security.md#authorization).
 *
 * `req.principal` is always set, so no downstream code has a null check that
 * could be missed, and there is no call site where "no principal" quietly
 * becomes "no owner scope".
 */
export function authenticate({ tokenService, users, logger }) {
  return async function authenticateMiddleware(req, res, next) {
    req.principal = Principal.anonymous();

    const token = bearerToken(req.get("authorization"));
    if (!token) return next();

    try {
      const result = await tokenService.authenticate(token, { users });
      if (result.ok) {
        req.principal = result.principal;
        req.tokenClaims = result.claims;
        // Every log line, span and usage record from here on carries the user
        // id without a single function signature mentioning it
        // (docs/backend/11-observability.md#correlation).
        enrichContext({ userId: result.principal.id });
      } else {
        // Recorded, not refused: a route that does not need authentication
        // should still serve a client holding an expired token, and the client
        // learns it is expired from the first route that does need one.
        req.authFailure = result.reason;
        logger?.debug?.("auth.token_rejected", { reason: result.reason });
      }
      return next();
    } catch (error) {
      return next(error);
    }
  };
}

/**
 * Refuse anything that is not an authenticated caller.
 *
 * Applied per route. `WWW-Authenticate` is set so a client can tell a missing
 * token from an expired one without parsing prose.
 */
export function requireAuth({ metrics } = {}) {
  return function requireAuthMiddleware(req, res, next) {
    if (req.principal?.isAuthenticated) return next();

    metrics?.increment("nova_authz_denied_total", {
      route: routeLabel(req),
      reason: req.authFailure ?? "missing_token",
    });

    res.set("WWW-Authenticate", 'Bearer realm="novagpt"');
    return next(
      new AppError("Sign in to continue.", ErrorKind.UNAUTHENTICATED, {
        expected: true,
        details: { reason: req.authFailure ?? "missing_token" },
      })
    );
  };
}

/**
 * Require a permission.
 *
 * Permission-based rather than role-based at the call site: a route that says
 * `requirePermission(ADMIN_METRICS)` keeps working when a fourth role appears,
 * while `requireRole("admin")` has to be found and edited
 * (docs/backend/10-security.md#roles).
 */
export function requirePermission(permission, { metrics } = {}) {
  return function requirePermissionMiddleware(req, res, next) {
    if (req.principal?.can(permission)) return next();

    metrics?.increment("nova_authz_denied_total", {
      route: routeLabel(req),
      reason: "permission",
    });

    // 403 here, unlike the 404 used for another user's *resource*. Nothing is
    // being disclosed: the route is public knowledge, and the caller genuinely
    // needs to know that more privilege is required rather than retrying.
    return next(
      new AppError("You do not have access to this.", ErrorKind.FORBIDDEN, {
        expected: true,
      })
    );
  };
}

/** `Authorization: Bearer <token>`, case-insensitive scheme, nothing else. */
function bearerToken(header) {
  if (typeof header !== "string") return null;
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  return match ? match[1] : null;
}
