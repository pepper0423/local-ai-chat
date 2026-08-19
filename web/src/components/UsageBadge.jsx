import { formatTokens, formatLatency } from '../lib/format.js';

export default function UsageBadge({ usage, cost, model, latencyMs }) {
  if (!usage) return null;

  const estimated = usage.source === 'estimated' || usage.source === 'live';
  const unavailable = usage.source === 'unavailable';

  const tokenPart = unavailable
    ? 'tokens n/a'
    : `${formatTokens(usage.inputTokens, { estimated })} in · ${formatTokens(usage.outputTokens, { estimated })} out`;

  const costPart = cost && cost.known === false ? (
    <span className="text-amber-500" title="No rate configured for this model">pricing not set</span>
  ) : (
    <span>{cost ? `$${cost.total.toFixed(cost.total < 0.01 ? 6 : 4)}` : ''}</span>
  );

  const tooltip = [
    usage.cachedInputTokens ? `cache read: ${usage.cachedInputTokens}` : null,
    usage.cacheWriteTokens ? `cache write: ${usage.cacheWriteTokens}` : null,
    usage.reasoningTokens ? `reasoning: ${usage.reasoningTokens} (${usage.reasoningInOutput ? 'inside output tokens' : 'additional'})` : null,
  ].filter(Boolean).join(' · ');

  return (
    <div className="flex flex-wrap items-center gap-1 text-xs text-neutral-500" title={tooltip || undefined}>
      <span>{tokenPart}</span>
      <span>·</span>
      {costPart}
      {model && (
        <>
          <span>·</span>
          <span>{model}</span>
        </>
      )}
      {latencyMs !== undefined && latencyMs !== null && (
        <>
          <span>·</span>
          <span>{formatLatency(latencyMs)}</span>
        </>
      )}
    </div>
  );
}
