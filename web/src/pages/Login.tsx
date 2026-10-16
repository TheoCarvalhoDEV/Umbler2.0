import type { FormEvent } from 'react';
import { Navigate, useLocation } from 'react-router';
import { useLogin, useMe, useSessionSync } from '../lib/auth';

const inputClass =
  'w-full rounded-lg border border-field bg-surface px-3 py-2.5 text-fg outline-none placeholder:text-muted focus:border-primary focus:ring-2 focus:ring-primary/30';

export default function Login() {
  const me = useMe();
  const login = useLogin();
  useSessionSync();
  const location = useLocation();
  const from = (location.state as { from?: string } | null)?.from ?? '/chats';

  if (me.data) return <Navigate to={from} replace />;
  if (me.isPending) return null;

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    login.mutate({ email: String(form.get('email')).trim(), password: String(form.get('password')) });
  }

  return (
    <main className="flex min-h-dvh items-center justify-center bg-sidebar px-4">
      <form
        onSubmit={onSubmit}
        className="w-full max-w-sm space-y-5 rounded-2xl border border-border bg-panel p-8 shadow-2xl"
      >
        <div className="flex flex-col items-center gap-2 text-center">
          <img src="/logo.png" alt="" className="brand-logo size-28" />
          <h1 className="text-xl font-semibold">Atendimento</h1>
          <p className="text-sm text-muted">Entre com seu e-mail e senha.</p>
        </div>
        <div className="space-y-1.5">
          <label htmlFor="login-email" className="block text-sm font-medium">
            E-mail
          </label>
          <input id="login-email" name="email" type="email" required autoComplete="username" autoFocus className={inputClass} />
        </div>
        <div className="space-y-1.5">
          <label htmlFor="login-password" className="block text-sm font-medium">
            Senha
          </label>
          <input
            id="login-password"
            name="password"
            type="password"
            required
            autoComplete="current-password"
            className={inputClass}
          />
        </div>
        {login.error && (
          <p role="alert" className="rounded-lg bg-danger/15 px-3 py-2 text-sm text-danger">
            {login.error.message}
          </p>
        )}
        <button
          type="submit"
          disabled={login.isPending}
          className="w-full rounded-lg bg-primary py-2.5 font-medium text-white transition-colors hover:bg-primary-hover disabled:opacity-60"
        >
          {login.isPending ? 'Entrando…' : 'Entrar'}
        </button>
      </form>
    </main>
  );
}
