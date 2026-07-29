import { AppError, ErrorKind } from "../../../domain/errors/index.js";

/**
 * Terminal middleware for unmatched routes.
 *
 * Routed through the normal error handler so a 404 carries the same envelope
 * and the same trace id as every other error. Express's built-in HTML 404 would
 * break the API contract at exactly the moment a client is already confused
 * about what it asked for.
 *
 * The message does not echo the requested path: reflecting user input into a
 * response body is a needless XSS surface for any client that renders errors.
 */
export function notFound() {
  return function notFoundMiddleware(req, res, next) {
    next(new AppError("The requested endpoint does not exist.", ErrorKind.NOT_FOUND));
  };
}
