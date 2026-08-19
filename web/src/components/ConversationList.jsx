import { useState } from 'react';
import { formatRelativeTime } from '../lib/format.js';

export default function ConversationList({ conversations, selectedId, onSelect, onRename, onDelete }) {
  const [editingId, setEditingId] = useState(null);
  const [editValue, setEditValue] = useState('');

  function startRename(c) {
    setEditingId(c.id);
    setEditValue(c.title);
  }

  async function commitRename(id) {
    const title = editValue.trim();
    setEditingId(null);
    if (title) await onRename(id, title);
  }

  if (conversations.length === 0) {
    return <div className="p-3 text-sm text-neutral-500">No conversations yet.</div>;
  }

  return (
    <ul className="space-y-0.5">
      {conversations.map((c) => {
        const active = selectedId === c.id;
        return (
          <li key={c.id}>
            <div
              className={`group relative flex cursor-pointer items-center justify-between rounded-xl px-3 py-2.5 text-sm transition-colors ${
                active ? 'bg-neutral-800 text-neutral-100' : 'text-neutral-400 hover:bg-neutral-900/80'
              }`}
              onClick={() => onSelect(c.id)}
            >
              {active && <span className="absolute left-0 top-1/2 h-4 w-0.5 -translate-y-1/2 rounded-full bg-blue-500" />}
              <div className="min-w-0 flex-1 pr-2">
                {editingId === c.id ? (
                  <input
                    autoFocus
                    className="w-full rounded bg-neutral-700 px-1 py-0.5 text-sm text-neutral-100 outline-none"
                    value={editValue}
                    onChange={(e) => setEditValue(e.target.value)}
                    onClick={(e) => e.stopPropagation()}
                    onBlur={() => commitRename(c.id)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') commitRename(c.id);
                      if (e.key === 'Escape') setEditingId(null);
                    }}
                  />
                ) : (
                  <div className="truncate">{c.title}</div>
                )}
                <div className="truncate text-xs text-neutral-600">{formatRelativeTime(c.updated_at)}</div>
              </div>
              <div className="hidden shrink-0 gap-1 group-hover:flex">
                <button
                  title="Rename"
                  className="rounded px-1.5 py-0.5 text-neutral-500 hover:bg-neutral-700 hover:text-neutral-100"
                  onClick={(e) => { e.stopPropagation(); startRename(c); }}
                >
                  ✎
                </button>
                <button
                  title="Delete"
                  className="rounded px-1.5 py-0.5 text-neutral-500 hover:bg-neutral-700 hover:text-red-400"
                  onClick={(e) => { e.stopPropagation(); if (confirm(`Delete "${c.title}"?`)) onDelete(c.id); }}
                >
                  🗑
                </button>
              </div>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
