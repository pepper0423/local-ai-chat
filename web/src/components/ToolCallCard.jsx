import { useState } from 'react';
import { openToolCallFile, openToolCallFolder } from '../api/client.js';

function formatBytes(n) {
  if (n === null || n === undefined) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function endpointHost(baseUrl) {
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl || 'unknown endpoint';
  }
}

/**
 * Renders one write_file proposal — pending (with Approve/Reject) or resolved
 * (approved/rejected/failed). Path and file content are ALWAYS rendered as plain escaped
 * text inside <pre>/<code>, never through ReactMarkdown — this is untrusted model output
 * and must never be able to render as markup or inject links (Security notes).
 */
export default function ToolCallCard({ toolCall, provider, customBaseUrl, onApprove, onReject, disabled }) {
  const [expanded, setExpanded] = useState(false);
  const [confirmArmed, setConfirmArmed] = useState(false);
  const [showReasonInput, setShowReasonInput] = useState(false);
  const [reason, setReason] = useState('');
  const [openError, setOpenError] = useState(null);

  const { status, input, meta } = toolCall;
  const path = input?.path || '(no path)';
  const content = typeof input?.content === 'string' ? input.content : '';
  const contentBytes = meta?.contentBytes ?? (typeof content === 'string' ? new Blob([content]).size : null);

  function handleApproveClick() {
    if (meta?.exists && !confirmArmed) {
      setConfirmArmed(true);
      return;
    }
    onApprove(toolCall.id, { confirmOverwrite: Boolean(meta?.exists) });
  }

  function handleRejectConfirm() {
    onReject(toolCall.id, showReasonInput ? reason : undefined);
    setShowReasonInput(false);
    setReason('');
  }

  async function handleOpen(kind) {
    setOpenError(null);
    try {
      const fn = kind === 'file' ? openToolCallFile : openToolCallFolder;
      await fn(toolCall.id);
    } catch (err) {
      setOpenError(err.message || `failed to open ${kind}`);
    }
  }

  return (
    <div className="mt-2 max-w-xl rounded-2xl border border-amber-700/50 bg-amber-950/20 p-3 text-[13px]">
      <div className="flex items-center gap-2 text-amber-200">
        <span>📝</span>
        <span className="font-medium">Write file</span>
        <span className="truncate font-mono text-[13px] text-amber-100">{path}</span>
      </div>

      {provider === 'custom' && (
        <div className="mt-2 rounded-lg border border-red-800/60 bg-red-950/40 px-2 py-1 text-xs text-red-300">
          ⚠ Proposed by a custom endpoint ({endpointHost(customBaseUrl)}) — a misconfigured or
          hostile endpoint is effectively an arbitrary third party proposing this write.
        </div>
      )}

      {status === 'pending' && (
        <>
          <div className="mt-1 text-xs text-amber-400/80">
            {contentBytes !== null && <span>{formatBytes(contentBytes)}</span>}
            {meta?.resolvedPath && (
              <span className="ml-2 break-all font-mono text-[11px] text-amber-500/70">→ {meta.resolvedPath}</span>
            )}
          </div>

          {meta?.exists && (
            <div className="mt-1 rounded-lg border border-red-800/60 bg-red-950/40 px-2 py-1 text-xs text-red-300">
              ⚠ This will overwrite an existing file ({formatBytes(meta.existingBytes)}).
            </div>
          )}

          {meta?.valid === false && (
            <div className="mt-1 rounded-lg border border-red-800/60 bg-red-950/40 px-2 py-1 text-xs text-red-300">
              ✕ Invalid path — this write can't be approved: {meta.reason}
            </div>
          )}

          <div className={`mt-2 overflow-hidden rounded-lg bg-black/30 ${expanded ? '' : 'max-h-48'}`}>
            <pre className="whitespace-pre-wrap break-all p-2 font-mono text-[12px] text-amber-100/90">
              <code>{content}</code>
            </pre>
          </div>
          {content.length > 300 && (
            <button onClick={() => setExpanded((e) => !e)} className="mt-1 text-xs text-amber-500 hover:text-amber-300">
              {expanded ? 'Show less' : 'Show more'}
            </button>
          )}

          <div className="mt-2 flex items-center gap-2">
            {meta?.valid !== false && (
              <button
                onClick={handleApproveClick}
                disabled={disabled}
                className="rounded-full bg-emerald-700 px-3 py-1 text-xs font-medium text-white hover:bg-emerald-600 disabled:opacity-40"
              >
                {confirmArmed ? 'Confirm overwrite?' : meta?.exists ? 'Overwrite' : 'Approve'}
              </button>
            )}
            {!showReasonInput ? (
              <button
                onClick={() => setShowReasonInput(true)}
                disabled={disabled}
                className="rounded-full bg-neutral-800 px-3 py-1 text-xs text-neutral-300 hover:bg-neutral-700 disabled:opacity-40"
              >
                Reject
              </button>
            ) : (
              <div className="flex flex-1 items-center gap-1">
                <input
                  autoFocus
                  placeholder="Reason (optional)"
                  className="min-w-0 flex-1 rounded bg-neutral-800 px-2 py-1 text-xs text-neutral-100 placeholder-neutral-500"
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') handleRejectConfirm(); }}
                />
                <button onClick={handleRejectConfirm} disabled={disabled} className="rounded-full bg-neutral-700 px-2 py-1 text-xs text-neutral-200 hover:bg-neutral-600">
                  Decline
                </button>
              </div>
            )}
            {confirmArmed && (
              <button onClick={() => setConfirmArmed(false)} className="text-xs text-neutral-500 hover:text-neutral-300">
                cancel
              </button>
            )}
          </div>
        </>
      )}

      {status === 'approved' && (
        <div className="mt-1">
          <div className="text-emerald-400">✓ Wrote {path} {toolCall.bytesWritten !== null && toolCall.bytesWritten !== undefined ? `(${formatBytes(toolCall.bytesWritten)})` : ''}</div>
          <div className="mt-1.5 flex items-center gap-2">
            <button onClick={() => handleOpen('file')} className="rounded-full bg-neutral-800 px-2.5 py-0.5 text-xs text-neutral-300 hover:bg-neutral-700">
              Open file
            </button>
            <button onClick={() => handleOpen('folder')} className="rounded-full bg-neutral-800 px-2.5 py-0.5 text-xs text-neutral-300 hover:bg-neutral-700">
              Open folder
            </button>
          </div>
          {openError && <div className="mt-1 text-xs text-red-400">{openError}</div>}
        </div>
      )}

      {status === 'rejected' && <div className="mt-1 text-neutral-400">✕ Declined{toolCall.resultText ? ` — ${toolCall.resultText.replace(/^The user declined this write:?\s*/, '')}` : ''}</div>}

      {status === 'failed' && <div className="mt-1 text-red-400">⚠ {toolCall.resultText || 'Write failed'}</div>}
    </div>
  );
}
