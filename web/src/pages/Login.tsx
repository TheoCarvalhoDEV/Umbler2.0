import type { FormEvent } from 'react';
import { Navigate, useLocation } from 'react-router';
import { LockSimpleIcon } from '@phosphor-icons/react';
import { button, card, field, fieldLabel, pageTitle } from '../components/ui';
import { useLogin, useMe, useSessionSync } from '../lib/auth';

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
    <main className="flex min-h-dvh flex-wrap gap-3 bg-ground p-3">
      {/* The rail colour in both themes: the gold logo is drawn for a dark background. */}
      <section className="flex max-w-full min-h-[300px] flex-[1_1_560px] flex-col justify-between gap-10 rounded-card bg-rail px-8 py-10 text-rail-fg md:px-12">
        <img src="/logo-mark-animado.svg" alt="" className="size-10" />
        <div className="flex max-w-[460px] flex-col gap-3">
          <p className="text-[13px] leading-[18px] font-semibold text-rail-badge">Atendimento</p>
          <p className="text-[30px] leading-[38px] font-bold tracking-[-0.02em] text-nav-on">Todas as conversas do escritório em um só lugar.</p>
          <p className="mt-1">WhatsApp, setores, notas internas e chatbot, com o histórico de cada cliente à mão.</p>
        </div>
        <p className="flex items-center gap-2 text-xs">
          <LockSimpleIcon size={16} aria-hidden className="shrink-0" />
          Uso restrito à equipe. Dados de clientes protegidos pela LGPD.
        </p>
      </section>
      <div className={`${card} flex min-h-[560px] min-w-0 flex-[1_1_460px] items-center justify-center px-[22px] py-12`}>
        <form onSubmit={onSubmit} className="flex w-[380px] max-w-full flex-col gap-5">
          <div>
            <h1 className={pageTitle}>Entrar</h1>
            <p className="mt-1 text-muted">Use o e-mail cadastrado pelo administrador.</p>
          </div>
          <div>
            <label htmlFor="login-email" className={fieldLabel}>
              E-mail
            </label>
            <input id="login-email" name="email" type="email" required autoComplete="username" autoFocus className={field} />
          </div>
          <div>
            <label htmlFor="login-password" className={fieldLabel}>
              Senha
            </label>
            <input id="login-password" name="password" type="password" required autoComplete="current-password" className={field} />
          </div>
          {login.error && (
            <p role="alert" className="rounded-block bg-danger-soft px-3.5 py-2.5 text-sm font-semibold text-danger">
              {login.error.message}
            </p>
          )}
          <button type="submit" disabled={login.isPending} className={`${button('primary')} w-full`}>
            {login.isPending ? 'Entrando…' : 'Entrar'}
          </button>
        </form>
      </div>
    </main>
  );
}
