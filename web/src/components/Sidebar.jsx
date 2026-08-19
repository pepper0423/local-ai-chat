import ConversationList from './ConversationList.jsx';
import * as api from '../api/client.js';

const PROVIDER_PRIORITY = ['anthropic', 'openai', 'gemini', 'custom'];

export default function Sidebar({ conversations, loading, selectedId, onSelect, create, rename, remove, onOpenSettings }) {
  async function handleNewChat() {
    // Pick the first provider the user has actually configured a key for, so a new
    // chat is usable immediately instead of always defaulting to Anthropic with no key.
    const cfg = await api.getConfig().catch(() => null);
    const provider = (cfg && PROVIDER_PRIORITY.find((id) => cfg[id]?.set)) || 'anthropic';
    const convo = await create({ provider, model: '' });
    onSelect(convo.id);
  }

  return (
    <div className="flex h-full min-h-0 flex-col border-r border-neutral-800/80 bg-neutral-950">
      <div className="flex items-center gap-2 px-4 pb-2 pt-4">
        <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-violet-500 to-blue-500 text-xs font-bold text-white">
          AI
        </div>
        <div className="truncate text-sm font-semibold text-neutral-200">Local AI Chat</div>
      </div>

      <div className="px-3 pb-3 pt-1">
        <button
          onClick={handleNewChat}
          className="flex w-full items-center gap-2 rounded-xl border border-neutral-800 px-3 py-2 text-left text-sm font-medium text-neutral-200 transition-colors hover:border-neutral-700 hover:bg-neutral-900"
        >
          <span className="text-base leading-none">＋</span> New chat
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {loading ? (
          <div className="p-3 text-sm text-neutral-500">Loading…</div>
        ) : (
          <ConversationList
            conversations={conversations}
            selectedId={selectedId}
            onSelect={onSelect}
            onRename={rename}
            onDelete={remove}
          />
        )}
      </div>

      <div className="border-t border-neutral-800/80 p-3">
        <button
          onClick={onOpenSettings}
          className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm text-neutral-400 transition-colors hover:bg-neutral-900 hover:text-neutral-100"
        >
          <span aria-hidden>⚙</span> Settings
        </button>
      </div>
    </div>
  );
}
