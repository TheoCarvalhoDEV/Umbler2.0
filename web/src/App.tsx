import { Navigate, type RouteObject } from 'react-router';
import AppLayout from './components/layout/AppLayout';
import { RequireAuth } from './lib/auth';
import { Inbox } from './pages/Inbox';
import Login from './pages/Login';

function NotFound() {
  return <div className="flex h-full items-center justify-center text-muted">Página não encontrada.</div>;
}

export const routes: RouteObject[] = [
  { path: '/login', element: <Login /> },
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
          // Task 17 replaces this element with the conversation view
          { path: ':id', element: <p className="grid h-full place-items-center text-sm text-muted">Carregando conversa…</p> },
        ],
      },
      // Tasks 18 and 19 insert `contacts` and `configuracoes/:section?` here, above the catch-all.
      { path: '*', element: <NotFound /> },
    ],
  },
];
