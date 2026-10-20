import { useMutation, useQueryClient, type QueryKey } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { request } from '../../lib/api';
import { button, field as fieldBox, pageTitle } from '../ui';

export type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'; // GET: the Canais page polls the channel QR

// Task 15's request() with the path first, which reads better in the settings screens.
export function send<T = unknown>(path: string, method: Method, body?: unknown): Promise<T> {
  return request<T>(method, path, body);
}

// Runs the given thunk (one or several requests) and then refetches the listed qk.* keys.
export function useSend(...refresh: QueryKey[]) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (run: () => Promise<unknown>) => run(),
    onSuccess: () => Promise.all(refresh.map((queryKey) => qc.invalidateQueries({ queryKey }))),
  });
}

export const btn = button('secondary', 'sm');
export const btnPrimary = button('primary');
export const field = `mt-1.5 ${fieldBox}`;

export function Section({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="max-w-3xl">
      <header className="mb-6 flex items-center justify-between gap-4">
        <h1 className={pageTitle}>{title}</h1>
        {action}
      </header>
      {children}
    </section>
  );
}

export function ErrorText({ error }: { error: unknown }) {
  if (!error) return null;
  return (
    <p role="alert" className="my-2 text-sm text-danger">
      {error instanceof Error ? error.message : 'Não foi possível concluir. Tente de novo.'}
    </p>
  );
}

export function Loading({ error }: { error: unknown }) {
  return error ? <ErrorText error={error} /> : <p className="text-sm text-muted">Carregando…</p>;
}
