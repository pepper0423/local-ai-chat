/** Sums the per-conversation `totals` that GET /api/conversations already returns for
 * every conversation, into one all-chats figure. No new backend route needed. */
export function computeGlobalTotals(conversations) {
  let inputTokens = 0;
  let outputTokens = 0;
  let cost = 0;
  let known = true;

  for (const c of conversations || []) {
    const t = c.totals;
    if (!t) continue;
    inputTokens += t.inputTokens || 0;
    outputTokens += t.outputTokens || 0;
    if (t.cost) {
      cost += t.cost.total || 0;
      if (!t.cost.known) known = false;
    }
  }

  return { inputTokens, outputTokens, cost: { total: cost, known, currency: 'USD' } };
}
