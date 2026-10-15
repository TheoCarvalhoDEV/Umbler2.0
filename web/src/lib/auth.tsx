import { MutationCache, QueryCache, QueryClient, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, type ReactNode } from 'react';
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

const SESSION_KEY = 'talk:session';

/** Tell the other tabs who is logged in now ('none' after logout). */
export function markSession(userId: string | null): void {
  try {
    localStorage.setItem(SESSION_KEY, `${userId ?? 'none'}:${Date.now()}`);
  } catch {
    // storage unavailable: other tabs just won't be told
  }
}

/** True when a `storage` event says another tab switched to a different user than this tab's. */
export function sessionChanged(e: Pick<StorageEvent, 'key' | 'newValue'>, currentUserId: string | null): boolean {
  if (e.key !== SESSION_KEY || !e.newValue) return false;
  return e.newValue.slice(0, e.newValue.lastIndexOf(':')) !== (currentUserId ?? 'none');
}

/** Reload this tab when another tab logs in as someone else or logs out. */
export function useSessionSync(): void {
  const { data } = useMe();
  const userId = data === undefined ? undefined : (data?.id ?? null);
  useEffect(() => {
    if (userId === undefined) return;
    const onStorage = (e: StorageEvent) => {
      if (sessionChanged(e, userId)) location.reload();
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [userId]);
}

export function useLogin() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { email: string; password: string }) => api.auth.login(v.email, v.password),
    onSuccess: (me) => {
      qc.setQueryData(qk.me, me);
      markSession(me.id);
    },
  });
}

export function useLogout() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.auth.logout(),
    onSuccess: () => markSession(null),
    onSettled: () => {
      qc.setQueryData(qk.me, null);
      qc.removeQueries({ predicate: (q) => q.queryKey[0] !== 'me' });
    },
  });
}

export function RequireAuth({ children }: { children: ReactNode }) {
  const me = useMe();
  const location = useLocation();
  useSessionSync();
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
