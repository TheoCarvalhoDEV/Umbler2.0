import { Navigate, type RouteObject } from 'react-router';
import AppLayout from './components/layout/AppLayout';
import { RequireAuth } from './lib/auth';
import { ContactNewPage } from './pages/ContactNew';
import { ContactsPage } from './pages/Contacts';
import ConversationPage from './pages/Conversation';
import { Inbox } from './pages/Inbox';
import Login from './pages/Login';
import { SettingsPage } from './pages/settings/SettingsPage';
import { BotEditorPage } from './pages/settings/bots/BotEditorPage';

function NotFound() {
  return <div className="flex h-full items-center justify-center text-muted">Página não encontrada.</div>;
}

export const routes: RouteObject[] = [
  { path: '/login', element: <Login /> },
  {
    path: '/configuracoes/chatbots/:id',
    element: (
      <RequireAuth>
        <BotEditorPage />
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
          { index: true, element: <p className="grid h-full place-items-center text-sm text-muted">Selecione uma conversa</p> },
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
