export function formatTokens(n, { estimated = false } = {}) {
  if (n === null || n === undefined) return 'n/a';
  const prefix = estimated ? '~' : '';
  return `${prefix}${n.toLocaleString()}`;
}

export function formatCost(cost) {
  if (!cost) return 'pricing not set';
  if (cost.known === false) return 'pricing not set';
  const amount = cost.total ?? 0;
  const decimals = amount < 0.01 ? 6 : 4;
  return `$${amount.toFixed(decimals)}`;
}

export function formatRelativeTime(iso) {
  if (!iso) return '';
  const then = new Date(iso).getTime();
  const now = Date.now();
  const diffSec = Math.round((now - then) / 1000);
  if (diffSec < 5) return 'just now';
  if (diffSec < 60) return `${diffSec}s ago`;
  const diffMin = Math.round(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.round(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.round(diffHr / 24);
  if (diffDay < 30) return `${diffDay}d ago`;
  return new Date(iso).toLocaleDateString();
}

export function formatLatency(ms) {
  if (ms === null || ms === undefined) return '';
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}
