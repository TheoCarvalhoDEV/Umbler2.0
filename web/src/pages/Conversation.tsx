import { useState, useSyncExternalStore } from 'react';
import { useNavigate, useParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { ConversationView } from '../components/conversation/ConversationView';
import { ContactPanel } from '../components/contacts/ContactPanel';
import { api, qk } from '../lib/api';

// Wide enough for list + conversation + a 340px contact column.
const WIDE = '(min-width: 1280px)';
const wideNow = () => window.matchMedia?.(WIDE).matches ?? false; // jsdom has no matchMedia
function subscribeWide(onChange: () => void) {
  const mq = window.matchMedia?.(WIDE);
  mq?.addEventListener('change', onChange);
  return () => mq?.removeEventListener('change', onChange);
}

export default function ConversationPage() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const wide = useSyncExternalStore(subscribeWide, wideNow);
  const [contactPanelOpen, setContactPanelOpen] = useState(wideNow); // survives switching chats
  const chat = useQuery({ queryKey: qk.chat(id), queryFn: () => api.chats.get(id), enabled: !!id });
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
      {contactPanelOpen && chat.data && (
        <ContactPanel contactId={chat.data.contact.id} chatId={id} docked={wide} onClose={() => setContactPanelOpen(false)} />
      )}
    </div>
  );
}
