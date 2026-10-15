import { MutationCache, QueryCache, QueryClient, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router';
import type { Me } from '@talk/shared';
import { api, ApiError, qk } from './api';

/** One QueryClient for the app: any 401 logs the user out locally; client errors are not retried. */
export function createQueryClient(): QueryClient {
  const onError = (err: Error) => {
    if (err instanceof ApiError && err.status === 401) qc.setQueryData(qk.me, null);
  };
  const qc: QueryClient = new QueryClient({
    queryCache: new QueryCache({ onError }),
    mutationCache: new MutationCache({ onError }),
    defaultOptions: {
      queries: {
        refetchOnWindowFocus: false,
        retry: (count, err) => count < 2 && !(err instanceof ApiError && err.status >= 400 && err.status < 500),
      },
      mutations: { retry: false },
    },
  });
  return qc;
}

/** Current user; `null` = not logged in, `undefined` = still loading or server unreachable. */
export function useMe() {
  return useQuery<Me | null>({
    queryKey: qk.me,
    queryFn: async () => {
      try {
        return await api.auth.me();
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) return null;
        throw e;
      }
    },
    staleTime: Infinity,
  });
}

/** Only valid below <RequireAuth>. */
export function useCurrentUser(): Me {
  const { data } = useMe();
  if (!data) throw new Error('useCurrentUser usado fora de RequireAuth');
  return data;
}

export function useLogin() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { email: string; password: string }) => api.auth.login(v.email, v.password),
    onSuccess: (me) => qc.setQueryData(qk.me, me),
  });
}

export function useLogout() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.auth.logout(),
    onSettled: () => {
      qc.setQueryData(qk.me, null);
      qc.removeQueries({ predicate: (q) => q.queryKey[0] !== 'me' });
    },
  });
}

export function RequireAuth({ children }: { children: ReactNode }) {
  const me = useMe();
  const location = useLocation();
  if (me.data) return children;
  if (me.data === null) return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />;
  if (me.isPending) {
    return <div className="flex h-dvh items-center justify-center text-muted">Carregando…</div>;
  }
  return (
    <div className="flex h-dvh flex-col items-center justify-center gap-3 text-muted">
      <p>Não foi possível conectar ao servidor.</p>
      <button
        type="button"
        onClick={() => void me.refetch()}
        className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-hover"
      >
        Tentar novamente
      </button>
    </div>
  );
}
