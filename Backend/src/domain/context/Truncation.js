/**
 * Middle-out message truncation.
 *
 * Shared by the trimming pipeline's stage 4 and by pinned-message capping,
 * because both need the same guarantee and getting it subtly different in two
 * places is how one of them ends up unmarked.
 *
 * **Cut the middle, never the end.** The beginning carries the setup and the
 * end carries the conclusion; the middle is the most compressible region
 * (docs/backend/06-context-engine.md#why-this-order).
 *
 * **The marker is mandatory.** An unmarked truncation makes the model
 * confidently reason about content it never received — the worst kind of
 * context bug, because the output looks authoritative and is wrong.
 */

/** Below this, a truncated message is too mangled to be worth keeping. */
const MIN_KEEP_PER_SIDE = 50;

/**
 * @param {object} message
 * @param {number} targetTokens          what the message must fit into
 * @param {import("./TokenEstimator.js").TokenEstimator} estimator
 * @returns {{message: object, omittedTokens: number}|null} null when it cannot
 *          be truncated usefully — the caller then has to drop or fail.
 */
export function truncateToFit(message, targetTokens, estimator) {
  const content = typeof message?.content === "string" ? message.content : "";
  if (!content) return null;

  const current = estimator.estimateMessage(message);
  if (current <= targetTokens) return { message, omittedTokens: 0 };

  // Convert the token target back into characters. The ratio is the estimator's
  // own, so a script-heavy message converts correctly rather than being cut on
  // an English assumption.
  const ratio = content.length / Math.max(1, current);
  const targetChars = Math.floor(targetTokens * ratio);
  const keepEachSide = Math.floor((targetChars - MARKER_ALLOWANCE) / 2);

  if (keepEachSide < MIN_KEEP_PER_SIDE) return null;

  const head = content.slice(0, keepEachSide);
  const tail = content.slice(content.length - keepEachSide);
  const omittedTokens = estimator.estimateText(
    content.slice(keepEachSide, content.length - keepEachSide)
  );

  return {
    message: {
      ...message,
      content: `${head}\n\n[... ${omittedTokens.toLocaleString()} tokens omitted ...]\n\n${tail}`,
      // The cached estimate described the original; keeping it would make every
      // later calculation read a stale number.
      tokenEstimate: undefined,
      wasTruncated: true,
    },
    omittedTokens,
  };
}

/** Characters the marker itself consumes, reserved so the result still fits. */
const MARKER_ALLOWANCE = 60;
