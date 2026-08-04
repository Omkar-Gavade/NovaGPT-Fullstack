import { AppError, ErrorKind } from "../../../domain/errors/index.js";

/**
 * Apply rate-limit rules to a route.
 *
 * The subject is derived here because only the HTTP layer knows what an "IP" is
 * — behind a proxy `req.ip` is only trustworthy when `trust proxy` is set, and
 * it is set for production only (see `createApp`). Getting that wrong limits
 * the load balancer rather than the caller, which means one abusive client
 * throttles everyone.
 *
 * Headers follow the draft `RateLimit-*` convention plus `Retry-After`, so a
 * well-behaved client can back off without guessing.
 */
export function rateLimit({ limiter, rules, subject = "ip", metrics }) {
  const list = Array.isArray(rules) ? rules : [rules];

  return async function rateLimitMiddleware(req, res, next) {
    try {
      const key = subjectFor(subject, req);
      const decision = await limiter.checkAll(list.map((rule) => ({ rule, subject: key })));

      if (!decision) return next();

      res.set("RateLimit-Limit", String(decision.limit));
      res.set("RateLimit-Remaining", "0");
      res.set("Retry-After", String(decision.retryAfterSeconds));

      return next(
        new AppError(
          decision.degraded
            ? "Sign-in is temporarily throttled. Try again shortly."
            : "Too many requests. Slow down.",
          ErrorKind.RATE_LIMITED,
          {
            // Expected under load, so it does not drown the error log at a
            // level reserved for things a human must look at.
            expected: true,
            details: { retryAfterSeconds: decision.retryAfterSeconds, rule: decision.rule },
          }
        )
      );
    } catch (error) {
      // A limiter defect must not take down the route it was protecting. It is
      // logged by the limiter itself; here the request proceeds.
      metrics?.increment("nova_rate_limited_total", { rule: "error", degraded: "true" });
      return next();
    }
  };
}

function subjectFor(subject, req) {
  if (subject === "user") {
    // Anonymous callers share the per-IP bucket rather than a single global
    // "anonymous" bucket — one shared counter would let any anonymous caller
    // exhaust the limit for every other one.
    return req.principal?.id ?? `ip:${clientIp(req)}`;
  }
  if (subject === "global") return "global";
  return clientIp(req);
}

const clientIp = (req) => req.ip ?? req.socket?.remoteAddress ?? "unknown";
