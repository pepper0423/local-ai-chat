import { useState } from 'react';
import Sidebar from './components/Sidebar.jsx';
import ChatPane from './components/ChatPane.jsx';
import SettingsDialog from './components/SettingsDialog.jsx';
import UsageFloater from './components/UsageFloater.jsx';
import { useConversations } from './hooks/useConversations.js';
import { computeGlobalTotals } from './lib/totals.js';

export default function App() {
  const conversationsApi = useConversations();
  const [selectedId, setSelectedId] = useState(null);
  const [settingsOpen, setSettingsOpen] = useState(false);

  const currentConversation = conversationsApi.conversations.find((c) => c.id === selectedId);

  return (
    <div className="grid h-full min-h-0 overflow-hidden" style={{ gridTemplateColumns: '260px 1fr' }}>
      <Sidebar
        {...conversationsApi}
        selectedId={selectedId}
        onSelect={setSelectedId}
        onOpenSettings={() => setSettingsOpen(true)}
      />
      <ChatPane
        conversationId={selectedId}
        conversations={conversationsApi.conversations}
        onConversationPatched={conversationsApi.refresh}
      />
      {settingsOpen && <SettingsDialog onClose={() => setSettingsOpen(false)} />}
      <UsageFloater
        global={computeGlobalTotals(conversationsApi.conversations)}
        current={currentConversation?.totals}
        currentTitle={currentConversation?.title}
      />
    </div>
  );
}
