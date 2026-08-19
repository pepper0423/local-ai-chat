import { useCallback, useEffect, useRef, useState } from 'react';
import * as api from '../api/client.js';
import { estimateTokensClient } from '../lib/tokenEstimateClient.js';
import { computeCostClient } from '../lib/costEstimate.js';

const FLUSH_INTERVAL_MS = 50;

export function useChatStream(conversationId) {
  const [messages, setMessages] = useState([]);
  const [totals, setTotals] = useState(null);
  const [isStreaming, setIsStreaming] = useState(false);
  const [streamError, setStreamError] = useState(null);
  const [loading, setLoading] = useState(true);

  const abortRef = useRef(null);
  const pendingDeltaRef = useRef('');
  const flushTimerRef = useRef(null);
  const streamingIndexRef = useRef(null);

  // Live tracking while a response streams: real input-token count arrives early
  // (e.g. Anthropic's message_start) via onUsage, output tokens are estimated
  // client-side from accumulated text until the real `done` usage replaces it.
  const fullContentRef = useRef('');
  const liveInputRef = useRef(null);
  const liveCachedRef = useRef(0);
  const pricingRef = useRef(null);
  const providerModelRef = useRef({ provider: null, model: null });

  const loadConversation = useCallback(async () => {
    if (!conversationId) return;
    setLoading(true);
    try {
      const { messages: msgs, totals: t } = await api.getConversation(conversationId);
      setMessages(msgs);
      setTotals(t);
    } finally {
      setLoading(false);
    }
  }, [conversationId]);

  useEffect(() => {
    loadConversation();
  }, [loadConversation]);

  useEffect(() => () => {
    if (flushTimerRef.current) clearInterval(flushTimerRef.current);
    abortRef.current?.abort();
  }, []);

  const liveUsageForContent = useCallback(() => {
    const { provider, model } = providerModelRef.current;
    const outputTokens = estimateTokensClient(fullContentRef.current);
    const inputTokens = liveInputRef.current;
    const usage = {
      inputTokens,
      outputTokens,
      cachedInputTokens: liveCachedRef.current || 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      reasoningInOutput: true,
      source: 'live',
    };
    const cost = inputTokens !== null
      ? computeCostClient(pricingRef.current, { provider, model, inputTokens, outputTokens, cachedInputTokens: usage.cachedInputTokens })
      : null;
    return { usage, cost };
  }, []);

  const applyLiveUsage = useCallback(() => {
    const { usage, cost } = liveUsageForContent();
    setMessages((prev) => {
      const idx = streamingIndexRef.current;
      if (idx === null || idx === undefined || !prev[idx]) return prev;
      const next = [...prev];
      next[idx] = { ...next[idx], usage, cost };
      return next;
    });
  }, [liveUsageForContent]);

  const flushPendingDelta = useCallback(() => {
    if (!pendingDeltaRef.current) return;
    const toAppend = pendingDeltaRef.current;
    pendingDeltaRef.current = '';
    setMessages((prev) => {
      const idx = streamingIndexRef.current;
      if (idx === null || idx === undefined || !prev[idx]) return prev;
      const next = [...prev];
      next[idx] = { ...next[idx], content: next[idx].content + toAppend };
      return next;
    });
    applyLiveUsage();
  }, [applyLiveUsage]);

  // Drives any streaming call (fresh send or retry) once the placeholder assistant
  // message is already in `messages` and streamingIndexRef points at it.
  const runStream = useCallback(async (startCall, { provider, model }) => {
    setStreamError(null);
    fullContentRef.current = '';
    liveInputRef.current = null;
    liveCachedRef.current = 0;
    providerModelRef.current = { provider, model };
    // Fetched fresh per call (not cached) so a rate just saved in Settings applies
    // to the very next message's live estimate, not the one after.
    api.getPricing().then((p) => { pricingRef.current = p; }).catch(() => { pricingRef.current = null; });

    const controller = new AbortController();
    abortRef.current = controller;
    setIsStreaming(true);

    flushTimerRef.current = setInterval(flushPendingDelta, FLUSH_INTERVAL_MS);

    await startCall(controller.signal, {
      onDelta: ({ text }) => {
        pendingDeltaRef.current += text;
        fullContentRef.current += text;
      },
      onToolCall: (proposal) => {
        // Normalize the live SSE shape ({toolCallId,name,input,meta}) into the same
        // {id,name,input,status,resultText,isError,resolvedPath,bytesWritten,meta} shape
        // GET /conversations returns after a reload, so ToolCallCard has one prop contract
        // regardless of whether it's rendering a fresh proposal or persisted history.
        setMessages((prev) => {
          const idx = streamingIndexRef.current;
          if (idx === null || idx === undefined || !prev[idx]) return prev;
          const next = [...prev];
          const existing = next[idx].toolCalls || [];
          next[idx] = {
            ...next[idx],
            toolCalls: [
              ...existing,
              {
                id: proposal.toolCallId,
                name: proposal.name,
                input: proposal.input,
                status: 'pending',
                resultText: null,
                isError: false,
                resolvedPath: proposal.meta?.resolvedPath ?? null,
                bytesWritten: null,
                meta: proposal.meta,
              },
            ],
          };
          return next;
        });
      },
      onUsage: (usage) => {
        // Partial real usage arriving mid-stream (e.g. Anthropic reports input
        // tokens at message_start, before any output text). Output tokens stay
        // estimated (source stays 'live') until the final `done` usage lands.
        if (usage.inputTokens !== undefined && usage.inputTokens !== null) {
          liveInputRef.current = usage.inputTokens;
        }
        if (usage.cachedInputTokens) {
          liveCachedRef.current = usage.cachedInputTokens;
        }
        applyLiveUsage();
      },
      onDone: ({ usage, cost, finishReason, latencyMs, messageId }) => {
        flushPendingDelta();
        setMessages((prev) => {
          const idx = streamingIndexRef.current;
          if (idx === null || !prev[idx]) return prev;
          const next = [...prev];
          next[idx] = { ...next[idx], id: messageId, usage, cost, finishReason, latencyMs, streaming: false, error: null };
          return next;
        });
        setTotals((prev) => bumpTotals(prev, usage, cost));
      },
      onError: (err) => {
        flushPendingDelta();
        setStreamError(err.message || 'stream error');
        setMessages((prev) => {
          const idx = streamingIndexRef.current;
          if (idx === null || !prev[idx]) return prev;
          const next = [...prev];
          next[idx] = { ...next[idx], streaming: false, finishReason: 'error', error: err.message };
          return next;
        });
      },
    });

    clearInterval(flushTimerRef.current);
    flushTimerRef.current = null;
    setIsStreaming(false);
    streamingIndexRef.current = null;
  }, [flushPendingDelta, applyLiveUsage]);

  const sendMessage = useCallback(async ({ content, provider, model, systemPrompt, params, attachmentIds = [], attachments = [] }) => {
    // Optimistic user message. `attachments` carries full metadata (name/kind/bytes) from
    // the Composer's own upload responses so chips render immediately — the optimistic
    // message only has ids from the server otherwise, and reload() would leave a visible
    // flash of empty chips until the round trip completes.
    setMessages((prev) => [
      ...prev,
      { id: `local-user-${Date.now()}`, role: 'user', content, attachments, createdAt: new Date().toISOString(), usage: null, cost: null },
    ]);

    // Placeholder assistant message that deltas get appended into.
    setMessages((prev) => {
      streamingIndexRef.current = prev.length;
      return [...prev, { id: `local-assistant-${Date.now()}`, role: 'assistant', content: '', provider, model, createdAt: new Date().toISOString(), usage: null, cost: null, streaming: true }];
    });

    await runStream(
      (signal, handlers) => api.streamMessage(conversationId, { content, provider, model, stream: true, systemPrompt, params, attachmentIds }, handlers, signal),
      { provider, model }
    );
  }, [conversationId, runStream]);

  const retryMessage = useCallback(async (messageId) => {
    if (isStreaming) return;
    const idx = messages.findIndex((m) => m.id === messageId);
    if (idx === -1 || messages[idx].role !== 'assistant') return;
    const { provider, model } = messages[idx];

    streamingIndexRef.current = idx;
    setMessages((prev) => {
      const next = [...prev];
      next[idx] = { ...next[idx], content: '', usage: null, cost: null, streaming: true, error: null, finishReason: null };
      return next;
    });

    await runStream(
      (signal, handlers) => api.retryMessage(conversationId, messageId, handlers, signal),
      { provider, model }
    );
  }, [conversationId, messages, runStream]);

  // Approve reuses runStream exactly like retry: a NEW assistant placeholder is appended
  // for the model's continuation (the write result itself isn't streamed text — it's what
  // the model says after being told the write succeeded/failed). The tool call's own
  // resolved state (bytesWritten/resultText) only exists server-side after the write, so
  // ChatPane reloads the conversation once this settles, same pattern as send/retry.
  const approveToolCall = useCallback(async (toolCallId, { confirmOverwrite } = {}) => {
    if (isStreaming) return;
    const msgIdx = messages.findIndex((m) => (m.toolCalls || []).some((tc) => tc.id === toolCallId));
    if (msgIdx === -1) return;
    const { provider, model } = messages[msgIdx];

    setMessages((prev) => {
      streamingIndexRef.current = prev.length;
      return [
        ...prev,
        { id: `local-assistant-${Date.now()}`, role: 'assistant', content: '', provider, model, createdAt: new Date().toISOString(), usage: null, cost: null, streaming: true },
      ];
    });

    await runStream(
      (signal, handlers) => api.approveToolCall(conversationId, toolCallId, { confirmOverwrite }, handlers, signal),
      { provider, model }
    );
  }, [conversationId, isStreaming, messages, runStream]);

  // Plain JSON, not SSE — reject never invokes the model. Caller (ChatPane) reloads
  // afterward so the card picks up the persisted "✕ Declined" state.
  const rejectToolCall = useCallback(async (toolCallId, reason) => {
    await api.rejectToolCall(conversationId, toolCallId, reason);
  }, [conversationId]);

  const stop = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  return { messages, totals, isStreaming, streamError, loading, sendMessage, retryMessage, approveToolCall, rejectToolCall, stop, reload: loadConversation };
}

function bumpTotals(prev, usage, cost) {
  const base = prev || { inputTokens: 0, outputTokens: 0, cost: { total: 0, known: true, currency: 'USD' } };
  if (!usage) return base;
  return {
    inputTokens: base.inputTokens + (usage.inputTokens || 0),
    outputTokens: base.outputTokens + (usage.outputTokens || 0),
    cost: {
      total: base.cost.total + (cost?.known ? cost.total : 0),
      known: base.cost.known && Boolean(cost?.known),
      currency: base.cost.currency || 'USD',
    },
  };
}
