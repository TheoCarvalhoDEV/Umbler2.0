import { useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { ConversationView } from '../components/conversation/ConversationView';

export default function ConversationPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [contactPanelOpen, setContactPanelOpen] = useState(false); // survives switching chats
  if (!id) return null;
  return (
    <div className="flex h-full min-w-0">
      <ConversationView
        chatId={id}
        contactPanelOpen={contactPanelOpen}
        onToggleContactPanel={() => setContactPanelOpen((o) => !o)}
        // sibling route, relative to the inbox path (works whatever prefix Task 16 registered)
        onOpenChat={(chatId) => navigate(`../${chatId}`, { relative: 'path' })}
      />
    </div>
  );
}
