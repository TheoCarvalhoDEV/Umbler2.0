import { Navigate, type RouteObject } from 'react-router';
import AppLayout from './components/layout/AppLayout';
import { RequireAuth } from './lib/auth';
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
      // Tasks 16, 18 and 19 insert `chats`, `contacts` and `configuracoes/:section?` here, above the catch-all.
      { path: '*', element: <NotFound /> },
    ],
  },
];
