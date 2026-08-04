import { AppError, ErrorKind } from "../../../domain/errors/index.js";

/**
 * Validate a request against a schema before any use case runs.
 *
 * Nothing unvalidated reaches the application layer, so no downstream code
 * needs defensive parsing. The parsed value **replaces** the raw one, which is
 * what stops a later handler reading an unvalidated field by accident
 * (docs/backend/10-security.md#input-validation).
 */
export function validate(schema, source = "body") {
  return function validateMiddleware(req, res, next) {
    const result = schema.safeParse(req[source]);

    if (!result.success) {
      const issue = result.error.issues[0];
      return next(
        new AppError(
          `${issue.path.join(".") || source}: ${issue.message}`,
          ErrorKind.VALIDATION,
          {
            field: issue.path.join(".") || null,
            // Every issue, not just the first: fixing one field per round trip
            // is a miserable client experience.
            details: {
              issues: result.error.issues.map((i) => ({
                field: i.path.join("."),
                message: i.message,
              })),
            },
          }
        )
      );
    }

    // Query strings are getters on newer Express; assigning to a separate
    // property avoids fighting that while still giving handlers parsed values.
    if (source === "query") req.validatedQuery = result.data;
    else req[source] = result.data;

    next();
  };
}
