import { useEffect, useRef } from 'react';
import MessageBubble from './MessageBubble.jsx';

const NEAR_BOTTOM_PX = 120;

export default function MessageList({ messages, onDeleteMessage, onRetryMessage, onApproveToolCall, onRejectToolCall, isStreaming, customBaseUrl }) {
  const containerRef = useRef(null);
  const stickToBottomRef = useRef(true);

  useEffect(() => {
    const el = containerRef.current;
    if (!el || !stickToBottomRef.current) return;
    // Instant, not smooth — smooth-scrolling on every ~50ms streaming tick fights its
    // own animation and is what reads as janky/stuttery while a reply is typing out.
    el.scrollTop = el.scrollHeight;
  }, [messages.length, messages[messages.length - 1]?.content]);

  function handleScroll() {
    const el = containerRef.current;
    if (!el) return;
    stickToBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_PX;
  }

  if (messages.length === 0) return null;

  return (
    <div ref={containerRef} onScroll={handleScroll} className="min-h-0 flex-1 overflow-y-auto">
      <div className="w-full space-y-8 px-8 py-6 lg:px-16">
        {messages.map((m) => (
          <MessageBubble
            key={m.id}
            message={m}
            onDelete={onDeleteMessage}
            onRetry={onRetryMessage}
            retryDisabled={isStreaming}
            onApproveToolCall={onApproveToolCall}
            onRejectToolCall={onRejectToolCall}
            toolCallsDisabled={isStreaming}
            customBaseUrl={customBaseUrl}
          />
        ))}
      </div>
    </div>
  );
}
