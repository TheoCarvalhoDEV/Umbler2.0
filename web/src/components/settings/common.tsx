import { useMutation, useQueryClient, type QueryKey } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { request } from '../../lib/api';
import { button, field as fieldBox, fieldHint, pageTitle } from '../ui';

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

export const btn = button('secondary', 'sm'); // dense toolbars (bot editor)
export const btnSecondary = button('secondary');
export const btnPrimary = button('primary');
export const btnDanger = button('danger');
export const field = `mt-1.5 ${fieldBox}`;

/** Sunken block inside the page card: inline forms, QR code, read-only data. */
export const block = 'rounded-block bg-sunken p-4';
/** A row of a settings list: thin divider between rows, none after the last. */
export const listRow = 'flex flex-wrap items-center gap-3 border-b border-border px-1 py-3 last:border-b-0';
/** Help text under a control. */
export const hint = fieldHint;
export const okText = 'text-[13px] font-semibold text-success';

/** wide: for a table that needs more than the board's 800px (Chatbots). */
export function Section({ title, action, wide, children }: { title: string; action?: ReactNode; wide?: boolean; children: ReactNode }) {
  return (
    <section className={wide ? 'max-w-5xl' : 'max-w-[800px]'}>
      <header className="mb-5 flex flex-wrap items-center justify-between gap-4">
        <h1 className={pageTitle}>{title}</h1>
        {action}
      </header>
      {children}
    </section>
  );
}

export function ErrorText({ error, className = '' }: { error: unknown; className?: string }) {
  if (!error) return null;
  return (
    <p role="alert" className={`my-2 text-[13px] font-semibold text-danger ${className}`}>
      {error instanceof Error ? error.message : 'Não foi possível concluir. Tente de novo.'}
    </p>
  );
}

export function Loading({ error }: { error: unknown }) {
  return error ? <ErrorText error={error} /> : <p className="text-sm text-muted">Carregando…</p>;
}
