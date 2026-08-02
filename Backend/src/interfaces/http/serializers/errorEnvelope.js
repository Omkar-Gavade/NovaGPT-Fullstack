/**
 * The wire shape of an error (docs/backend/09-api-design.md#error-format).
 *
 * Built field by field. A serialiser that spreads the error object would
 * eventually ship `cause`, and `cause` is where upstream response bodies,
 * connection strings, and stack traces live — this is the exact shape of the
 * leak that T1 in the threat model describes
 * (docs/backend/10-security.md#structural-defences-against-leakage-t1).
 *
 * `kind` is the stable contract clients branch on; `message` is copy that may
 * be reworded or localised freely. A client matching on message text breaks the
 * first time someone improves the wording.
 */
export function errorEnvelope(error, traceId) {
  return {
    error: {
      kind: error.kind,
      message: error.message,
      field: error.field ?? null,
      details: error.details ?? null,
      // Always present, including on 4xx. It turns "it said something went
      // wrong" into a single log query, which is the cheapest support tool in
      // the system.
      traceId: traceId ?? null,
    },
  };
}
