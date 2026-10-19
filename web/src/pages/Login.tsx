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
    <main className="flex min-h-dvh flex-col bg-ground md:flex-row">
      {/* The rail colour in both themes: the gold logo is drawn for a dark background. */}
      <section className="flex flex-col justify-between gap-10 bg-rail p-8 text-nav-on md:w-[46%] md:p-14">
        <img src="/logo-mark.png" alt="" className="size-16" />
        <div className="max-w-md">
          <p className="mb-3 text-xs font-semibold tracking-widest text-[#d9ae5a] uppercase">Atendimento</p>
          <p className="text-3xl leading-tight font-semibold tracking-tight">Todas as conversas do escritório em um só lugar.</p>
          <p className="mt-4 text-rail-fg">WhatsApp, setores, notas internas e chatbot, com o histórico de cada cliente à mão.</p>
        </div>
        <p className="text-xs text-rail-fg">Uso restrito à equipe. Dados de clientes protegidos pela LGPD.</p>
      </section>
      <div className="flex flex-1 items-center justify-center px-6 py-12">
        <form onSubmit={onSubmit} className="w-full max-w-sm space-y-5">
          <div>
            <h1 className="text-[26px] font-semibold tracking-tight">Entrar</h1>
            <p className="mt-1 text-sm text-muted">Use o e-mail cadastrado pelo administrador.</p>
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
            <p role="alert" className="rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger">
              {login.error.message}
            </p>
          )}
          <button
            type="submit"
            disabled={login.isPending}
            className="w-full rounded-lg bg-primary py-3 font-semibold text-white transition-colors hover:bg-primary-hover disabled:opacity-60"
          >
            {login.isPending ? 'Entrando…' : 'Entrar'}
          </button>
        </form>
      </div>
    </main>
  );
}
