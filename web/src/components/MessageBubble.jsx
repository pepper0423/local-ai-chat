import { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import UsageBadge from './UsageBadge.jsx';
import ToolCallCard from './ToolCallCard.jsx';
import { attachmentUrl } from '../api/client.js';

function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** Text-attachment chip that lazy-fetches its content on first expand. Rendered as plain
 * escaped text in a <pre> — never through ReactMarkdown — untrusted file content must
 * not be able to render as markup or inject links. */
function TextAttachmentChip({ attachment }) {
  const [expanded, setExpanded] = useState(false);
  const [content, setContent] = useState(null);
  const [loading, setLoading] = useState(false);

  async function toggle() {
    if (!expanded && content === null) {
      setLoading(true);
      try {
        const res = await fetch(attachmentUrl(attachment.id));
        setContent(await res.text());
      } catch {
        setContent('(failed to load)');
      } finally {
        setLoading(false);
      }
    }
    setExpanded((e) => !e);
  }

  return (
    <div>
      <button
        onClick={toggle}
        className="inline-flex items-center gap-1.5 rounded-full bg-blue-800/60 px-2.5 py-1 text-xs text-blue-50 hover:bg-blue-800"
      >
        📄 {attachment.name} · {formatBytes(attachment.bytes)}
      </button>
      {expanded && (
        <pre className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap rounded-xl bg-blue-950/40 p-2 text-xs text-blue-50">
          {loading ? 'Loading…' : content}
        </pre>
      )}
    </div>
  );
}

function CodeBlock({ className, children, ...props }) {
  const [copied, setCopied] = useState(false);
  const text = String(children).replace(/\n$/, '');

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable — ignore */
    }
  }

  return (
    <div className="group relative">
      <button
        onClick={copy}
        className="absolute right-2 top-2 rounded bg-neutral-700 px-2 py-0.5 text-xs text-neutral-200 opacity-0 group-hover:opacity-100"
      >
        {copied ? 'Copied' : 'Copy'}
      </button>
      <pre className={className}>
        <code {...props}>{children}</code>
      </pre>
    </div>
  );
}

export default function MessageBubble({ message, onDelete, onRetry, retryDisabled, onApproveToolCall, onRejectToolCall, toolCallsDisabled, customBaseUrl }) {
  const isUser = message.role === 'user';
  const canDelete = onDelete && typeof message.id === 'number' && !message.streaming;
  const canRetry = onRetry && typeof message.id === 'number' && !message.streaming;

  function handleDelete() {
    if (confirm('Delete this message?')) onDelete(message.id);
  }

  if (isUser) {
    const attachments = message.attachments || [];
    const textAttachments = attachments.filter((a) => a.kind === 'text');
    const imageAttachments = attachments.filter((a) => a.kind === 'image');

    return (
      <div className="group flex items-center justify-end gap-2">
        {canDelete && (
          <button
            onClick={handleDelete}
            title="Delete message"
            className="cursor-pointer rounded px-1 text-neutral-600 opacity-0 transition-opacity hover:text-red-400 group-hover:opacity-100"
          >
            🗑
          </button>
        )}
        <div className="max-w-[70%] rounded-3xl bg-blue-600 px-4 py-2.5 text-[15px] leading-relaxed text-white shadow-sm">
          {imageAttachments.length > 0 && (
            <div className="mb-2 flex flex-wrap gap-2">
              {imageAttachments.map((a) => (
                <img key={a.id} src={attachmentUrl(a.id)} alt={a.name} className="max-h-64 rounded-2xl" />
              ))}
            </div>
          )}
          {textAttachments.length > 0 && (
            <div className="mb-2 flex flex-col gap-1">
              {textAttachments.map((a) => (
                <TextAttachmentChip key={a.id} attachment={a} />
              ))}
            </div>
          )}
          {message.content && <div className="whitespace-pre-wrap">{message.content}</div>}
        </div>
      </div>
    );
  }

  return (
    <div className="group flex items-start gap-3">
      <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-violet-500 to-blue-500 text-[11px] font-semibold text-white">
        AI
      </div>
      <div className="min-w-0 flex-1">
        <div className="chat-markdown prose prose-invert prose-sm max-w-none leading-relaxed">
          {message.content ? (
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              rehypePlugins={[rehypeHighlight]}
              components={{ pre: CodeBlock }}
            >
              {message.content}
            </ReactMarkdown>
          ) : message.streaming ? (
            <span className="inline-flex animate-pulse gap-1 text-neutral-500">● ● ●</span>
          ) : message.error ? (
            <span className="text-red-400">{message.error}</span>
          ) : null}
        </div>
        {(message.toolCalls || []).map((tc) => (
          <ToolCallCard
            key={tc.id}
            toolCall={tc}
            provider={message.provider}
            customBaseUrl={customBaseUrl}
            onApprove={onApproveToolCall}
            onReject={onRejectToolCall}
            disabled={toolCallsDisabled}
          />
        ))}
        <div className="mt-1.5 flex items-center gap-2">
          <UsageBadge
            usage={message.usage}
            cost={message.cost}
            model={message.model}
            latencyMs={message.latencyMs}
          />
          {canRetry && (
            <button
              onClick={() => onRetry(message.id)}
              disabled={retryDisabled}
              title="Retry — regenerate this reply"
              className="cursor-pointer rounded px-1 text-xs text-neutral-600 opacity-0 transition-opacity hover:text-blue-400 group-hover:opacity-100 disabled:cursor-not-allowed disabled:opacity-0"
            >
              🔄
            </button>
          )}
          {canDelete && (
            <button
              onClick={handleDelete}
              title="Delete message"
              className="cursor-pointer rounded px-1 text-xs text-neutral-600 opacity-0 transition-opacity hover:text-red-400 group-hover:opacity-100"
            >
              🗑
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
