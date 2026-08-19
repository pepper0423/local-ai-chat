import { useEffect, useState } from 'react';
import MessageList from './MessageList.jsx';
import Composer from './Composer.jsx';
import ModelPicker from './ModelPicker.jsx';
import { useChatStream } from '../hooks/useChatStream.js';
import * as api from '../api/client.js';

export default function ChatPane({ conversationId, conversations, onConversationPatched }) {
  const conversation = conversations.find((c) => c.id === conversationId);
  const { messages, isStreaming, streamError, sendMessage, retryMessage, approveToolCall, rejectToolCall, stop, reload } = useChatStream(conversationId);
  const [localProviderModel, setLocalProviderModel] = useState(null);
  const [providers, setProviders] = useState([]);
  const [config, setConfig] = useState(null);

  useEffect(() => {
    setLocalProviderModel(null); // reset picker override when switching conversations
  }, [conversationId]);

  useEffect(() => {
    api.getProviders().then(setProviders).catch(() => {});
    api.getConfig().then(setConfig).catch(() => {});
  }, []);

  if (!conversationId) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 text-center text-neutral-600">
        <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-gradient-to-br from-violet-500 to-blue-500 text-sm font-bold text-white">
          AI
        </div>
        <div className="mt-2 text-lg font-medium text-neutral-300">Local AI Chat</div>
        <div className="text-sm text-neutral-600">Select a conversation, or start a new one.</div>
      </div>
    );
  }

  if (!conversation) {
    return <div className="flex h-full items-center justify-center text-neutral-600">Loading…</div>;
  }

  const provider = localProviderModel?.provider ?? conversation.provider;
  const model = localProviderModel?.model ?? conversation.model;
  const imagesEnabled = Boolean(providers.find((p) => p.id === provider)?.capabilities?.images);
  const hasPendingToolCall = messages.some((m) => (m.toolCalls || []).some((tc) => tc.status === 'pending'));
  const workspace = config?.workspace;

  async function handleModelChange(next) {
    setLocalProviderModel(next);
    if (next.provider && next.model) {
      await api.patchConversation(conversationId, { provider: next.provider, model: next.model });
      onConversationPatched();
    } else if (next.provider !== conversation.provider) {
      await api.patchConversation(conversationId, { provider: next.provider });
      onConversationPatched();
    }
  }

  async function handleSend({ content, attachmentIds, attachments }) {
    if (!model) return;
    await sendMessage({ content, provider, model, systemPrompt: conversation.system_prompt, attachmentIds, attachments });
    onConversationPatched();
    reload();
  }

  async function handleDeleteMessage(messageId) {
    await api.deleteMessage(conversationId, messageId);
    await reload();
    onConversationPatched();
  }

  async function handleRetryMessage(messageId) {
    await retryMessage(messageId);
    onConversationPatched();
    reload();
  }

  async function handleApproveToolCall(toolCallId, opts) {
    await approveToolCall(toolCallId, opts);
    onConversationPatched();
    reload();
  }

  async function handleRejectToolCall(toolCallId, reason) {
    await rejectToolCall(toolCallId, reason);
    await reload();
  }

  const empty = messages.length === 0;

  return (
    <div className="flex h-full min-h-0 flex-col bg-neutral-950">
      <div className="flex items-center justify-between gap-4 border-b border-neutral-800/80 px-4 py-2.5">
        <ModelPicker key={conversationId} provider={provider} model={model} onChange={handleModelChange} disabled={isStreaming} />
        {workspace?.enabled && workspace?.root && (
          <div
            title={workspace.writable ? 'AI file-write workspace' : 'Workspace configured but not currently writable'}
            className={`shrink-0 truncate rounded-full px-2.5 py-1 text-xs ${workspace.writable ? 'bg-neutral-800 text-neutral-400' : 'bg-red-950/50 text-red-300'}`}
          >
            📁 {workspace.root}
          </div>
        )}
      </div>

      {streamError && (
        <div className="border-b border-red-900 bg-red-950/50 px-4 py-2 text-sm text-red-300">
          {streamError}
        </div>
      )}

      {hasPendingToolCall && (
        <div className="border-b border-amber-900 bg-amber-950/40 px-4 py-2 text-sm text-amber-300">
          A file write is waiting for your approval above — approve or reject it before sending another message.
        </div>
      )}

      {empty ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-6 px-4">
          <div className="text-center text-2xl font-semibold text-neutral-100">What can I help with?</div>
          <div className="w-full max-w-3xl">
            <Composer onSend={handleSend} isStreaming={isStreaming} onStop={stop} disabled={!model} imagesEnabled={imagesEnabled} />
          </div>
        </div>
      ) : (
        <>
          <MessageList
            messages={messages}
            onDeleteMessage={handleDeleteMessage}
            onRetryMessage={handleRetryMessage}
            onApproveToolCall={handleApproveToolCall}
            onRejectToolCall={handleRejectToolCall}
            isStreaming={isStreaming}
            customBaseUrl={config?.custom?.baseUrl}
          />
          <div className="w-full px-8 pb-4 pt-2 lg:px-16">
            <Composer onSend={handleSend} isStreaming={isStreaming} onStop={stop} disabled={!model || hasPendingToolCall} imagesEnabled={imagesEnabled} />
          </div>
        </>
      )}
    </div>
  );
}
