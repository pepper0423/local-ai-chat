/** Same crude chars/4 estimator as server/src/tokenEstimate.js — used client-side only to
 * warn before sending a very large message, not for anything billed. */
export function estimateTokensClient(text) {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}
