import { useRef, useState } from 'react';
import { estimateTokensClient } from '../lib/tokenEstimateClient.js';
import * as api from '../api/client.js';

const WARN_THRESHOLD_TOKENS = 8000;
// Rough, not a real tokenizer — labeled as "rough" in the UI. Vision providers charge
// per-image based on resolution/tiling, which we have no visibility into client-side.
const IMAGE_TOKEN_ESTIMATE = 1100;

let localIdCounter = 0;
function nextLocalId() {
  localIdCounter += 1;
  return `att-${Date.now()}-${localIdCounter}`;
}

function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export default function Composer({ onSend, isStreaming, onStop, disabled, imagesEnabled = true }) {
  const [value, setValue] = useState('');
  // Each entry: {localId, file, status:'uploading'|'ready'|'error', previewUrl, name, kind, serverId, mediaType, bytes, error}
  const [attachments, setAttachments] = useState([]);
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef(null);

  const readyAttachments = attachments.filter((a) => a.status === 'ready');
  const anyUploading = attachments.some((a) => a.status === 'uploading');

  const textAttachmentBytes = readyAttachments.filter((a) => a.kind === 'text').reduce((sum, a) => sum + (a.bytes || 0), 0);
  const imageAttachmentCount = readyAttachments.filter((a) => a.kind === 'image').length;
  const estTokens = estimateTokensClient(value) + Math.ceil(textAttachmentBytes / 4) + imageAttachmentCount * IMAGE_TOKEN_ESTIMATE;
  const overThreshold = estTokens > WARN_THRESHOLD_TOKENS;

  function addFiles(fileList) {
    const files = Array.from(fileList || []);
    for (const file of files) {
      const isImage = file.type.startsWith('image/');
      // Affordance is hidden, not error-surfaced: a provider without image support
      // just silently doesn't pick up dropped/pasted images rather than failing at send.
      if (isImage && !imagesEnabled) continue;

      const localId = nextLocalId();
      const previewUrl = isImage ? URL.createObjectURL(file) : null;
      setAttachments((prev) => [...prev, { localId, file, status: 'uploading', previewUrl, name: file.name }]);

      api
        .uploadAttachment(file)
        .then((res) => {
          setAttachments((prev) =>
            prev.map((a) =>
              a.localId === localId
                ? { ...a, status: 'ready', serverId: res.id, kind: res.kind, name: res.name, mediaType: res.mediaType, bytes: res.bytes }
                : a
            )
          );
        })
        .catch((err) => {
          setAttachments((prev) => prev.map((a) => (a.localId === localId ? { ...a, status: 'error', error: err.message } : a)));
        });
    }
  }

  function removeAttachment(localId) {
    setAttachments((prev) => {
      const target = prev.find((a) => a.localId === localId);
      if (target?.previewUrl) URL.revokeObjectURL(target.previewUrl);
      if (target?.serverId) api.deleteAttachment(target.serverId).catch(() => {});
      return prev.filter((a) => a.localId !== localId);
    });
  }

  function submit() {
    const text = value.trim();
    if (isStreaming || disabled || anyUploading) return;
    if (!text && readyAttachments.length === 0) return;
    onSend({
      content: text,
      attachmentIds: readyAttachments.map((a) => a.serverId),
      attachments: readyAttachments.map((a) => ({ id: a.serverId, kind: a.kind, name: a.name, mediaType: a.mediaType, bytes: a.bytes })),
    });
    setValue('');
    attachments.forEach((a) => {
      if (a.previewUrl) URL.revokeObjectURL(a.previewUrl);
    });
    setAttachments([]);
  }

  function handlePaste(e) {
    const items = Array.from(e.clipboardData?.items || []);
    const files = items.filter((it) => it.kind === 'file').map((it) => it.getAsFile()).filter(Boolean);
    if (files.length) {
      e.preventDefault();
      addFiles(files);
    }
  }

  return (
    <div
      onDragOver={(e) => {
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragOver(false);
        addFiles(e.dataTransfer?.files);
      }}
    >
      {overThreshold && (
        <div className="mb-2 px-1 text-xs text-amber-500">
          ~{estTokens.toLocaleString()} estimated input tokens (rough, includes attachments) — this is a large message.
        </div>
      )}

      {attachments.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-2 px-1">
          {attachments.map((a) => (
            <div
              key={a.localId}
              className="group relative flex items-center gap-1.5 rounded-full border border-neutral-700 bg-neutral-800/70 px-2.5 py-1 text-xs text-neutral-200"
            >
              {a.previewUrl ? (
                <img src={a.previewUrl} alt={a.name} className="h-10 w-10 rounded object-cover" />
              ) : (
                <span>📄</span>
              )}
              <span className="max-w-[10rem] truncate">{a.name}</span>
              {a.status === 'uploading' && <span className="text-neutral-500">uploading…</span>}
              {a.status === 'error' && <span className="text-red-400" title={a.error}>failed</span>}
              {a.status === 'ready' && a.bytes !== undefined && <span className="text-neutral-500">{formatBytes(a.bytes)}</span>}
              <button onClick={() => removeAttachment(a.localId)} className="ml-1 text-neutral-500 hover:text-red-400">
                ×
              </button>
            </div>
          ))}
        </div>
      )}

      <div
        className={`flex items-end gap-2 rounded-3xl border px-3 py-2 shadow-lg transition-colors ${
          dragOver ? 'border-blue-500 bg-blue-950/20' : 'border-neutral-700 bg-neutral-800/70 focus-within:border-neutral-500'
        }`}
      >
        <input
          ref={fileInputRef}
          type="file"
          multiple
          className="hidden"
          onChange={(e) => {
            addFiles(e.target.files);
            e.target.value = '';
          }}
        />
        <button
          onClick={() => fileInputRef.current?.click()}
          disabled={disabled}
          title={imagesEnabled ? 'Attach files' : 'Attach files (images not supported by this provider)'}
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-neutral-400 transition-colors hover:bg-neutral-700 hover:text-neutral-200 disabled:opacity-30"
        >
          📎
        </button>
        <textarea
          rows={1}
          className="max-h-40 min-h-[1.75rem] flex-1 resize-none bg-transparent px-2 py-1.5 text-sm text-neutral-100 outline-none placeholder-neutral-500"
          placeholder={disabled ? 'Pick a provider and model to start' : 'Message…'}
          value={value}
          disabled={disabled}
          onChange={(e) => setValue(e.target.value)}
          onPaste={handlePaste}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
        />
        {isStreaming ? (
          <button
            onClick={onStop}
            title="Stop"
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-red-700 text-white transition-colors hover:bg-red-600"
          >
            ■
          </button>
        ) : (
          <button
            onClick={submit}
            disabled={disabled || (!value.trim() && readyAttachments.length === 0) || anyUploading}
            title="Send"
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-neutral-100 text-neutral-900 transition-colors hover:bg-white disabled:opacity-30"
          >
            ↑
          </button>
        )}
      </div>
      <div className="mt-1.5 px-1 text-center text-[10px] text-neutral-600">
        Enter to send · Shift+Enter for newline{imagesEnabled ? '' : ' · images not supported by this provider'}
      </div>
    </div>
  );
}
