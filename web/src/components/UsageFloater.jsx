import { useState } from 'react';
import { formatTokens, formatCost } from '../lib/format.js';

function Row({ totals }) {
  if (!totals) return <div className="text-xs text-neutral-600">—</div>;
  return (
    <div className="flex items-center justify-between gap-3 text-xs text-neutral-300">
      <span>{formatTokens(totals.inputTokens)} in · {formatTokens(totals.outputTokens)} out</span>
      <span className="font-medium text-neutral-100">{formatCost(totals.cost)}</span>
    </div>
  );
}

/** Fixed floating summary card — the one place that shows running token/cost sums,
 * so they're always visible without hunting through headers or sidebar rows. */
export default function UsageFloater({ global, current, currentTitle }) {
  const [open, setOpen] = useState(false);
  const hasGlobal = global && (global.inputTokens > 0 || global.outputTokens > 0);
  if (!hasGlobal && !current) return null;

  return (
    <div className="fixed bottom-5 right-5 z-40 select-none">
      {open && (
        <div className="mb-2 w-64 rounded-2xl border border-neutral-800 bg-neutral-900/95 p-3 shadow-2xl backdrop-blur">
          {current && (
            <div className="mb-2 border-b border-neutral-800 pb-2">
              <div className="mb-1 truncate text-[10px] font-medium uppercase tracking-wide text-neutral-500">
                {currentTitle || 'This chat'}
              </div>
              <Row totals={current} />
            </div>
          )}
          <div>
            <div className="mb-1 text-[10px] font-medium uppercase tracking-wide text-neutral-500">All chats</div>
            <Row totals={global} />
          </div>
        </div>
      )}
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-2 rounded-full border border-neutral-800 bg-neutral-900/95 px-3.5 py-2 text-xs font-medium text-neutral-200 shadow-2xl backdrop-blur transition-colors hover:border-neutral-600"
      >
        <span aria-hidden>💲</span>
        <span>{formatCost(global?.cost)}</span>
        <span className="text-neutral-600">·</span>
        <span className="text-neutral-400">{formatTokens((global?.inputTokens || 0) + (global?.outputTokens || 0))} tok</span>
        <span className="text-neutral-600">{open ? '▾' : '▸'}</span>
      </button>
    </div>
  );
}
