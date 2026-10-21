import { lazy, Suspense } from 'react';
import { Navigate, type RouteObject } from 'react-router';
import { ChatCircleDotsIcon } from '@phosphor-icons/react';
import AppLayout from './components/layout/AppLayout';
import { card } from './components/ui';
import { RequireAuth } from './lib/auth';
import { ContactNewPage } from './pages/ContactNew';
import { ContactsPage } from './pages/Contacts';
import ConversationPage from './pages/Conversation';
import { Inbox } from './pages/Inbox';
import Login from './pages/Login';
import { SettingsPage } from './pages/settings/SettingsPage';

// React Flow, dagre and the block cards load only when an admin opens the editor.
const BotEditorPage = lazy(() => import('./pages/settings/bots/BotEditorPage').then((m) => ({ default: m.BotEditorPage })));

function NotFound() {
  return <div className={`${card} grid h-full place-items-center p-6 text-muted`}>Página não encontrada.</div>;
}

/** The conversation area before a chat is picked: a card like the conversation it stands in for. */
function NoChatSelected() {
  return (
    <div className={`${card} flex h-full flex-col items-center justify-center gap-3 p-6`}>
      <span aria-hidden className="grid size-14 place-items-center rounded-full bg-primary-soft text-accent-ink">
        <ChatCircleDotsIcon size={28} />
      </span>
      <p className="text-sm text-muted">Selecione uma conversa</p>
    </div>
  );
}

export const routes: RouteObject[] = [
  { path: '/login', element: <Login /> },
  {
    path: '/configuracoes/chatbots/:id',
    element: (
      <RequireAuth>
        <Suspense fallback={null}>
          <BotEditorPage />
        </Suspense>
      </RequireAuth>
    ),
  },
  {
    path: '/',
    element: (
      <RequireAuth>
        <AppLayout />
      </RequireAuth>
    ),
    children: [
      { index: true, element: <Navigate to="/chats" replace /> },
      {
        path: 'chats',
        element: <Inbox />,
        children: [
          { index: true, element: <NoChatSelected /> },
          { path: ':id', element: <ConversationPage /> },
        ],
      },
      { path: 'contacts', element: <ContactsPage /> },
      { path: 'contacts/new', element: <ContactNewPage /> },
      { path: 'configuracoes/:section?', element: <SettingsPage /> },
      { path: '*', element: <NotFound /> },
    ],
  },
];
