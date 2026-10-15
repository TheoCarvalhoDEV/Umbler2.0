import { useEffect } from 'react';
import { Link, NavLink, Outlet } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AddressBookIcon,
  ChatCircleDotsIcon,
  ChatsCircleIcon,
  GearSixIcon,
  SignOutIcon,
  WarningCircleIcon,
  type Icon,
} from '@phosphor-icons/react';
import { api, qk } from '../../lib/api';
import { useCurrentUser, useLogout } from '../../lib/auth';
import { initials } from '../../lib/format';
import { connectWs } from '../../lib/ws';

function NavItem({ to, label, icon: IconCmp }: { to: string; label: string; icon: Icon }) {
  return (
    <NavLink
      to={to}
      title={label}
      aria-label={label}
      className={({ isActive }) =>
        `relative flex size-11 items-center justify-center rounded-xl transition-colors ${
          isActive
            ? 'bg-sidebar-active text-white before:absolute before:-left-2.5 before:h-6 before:w-1 before:rounded-r before:bg-primary'
            : 'text-muted hover:bg-sidebar-hover hover:text-fg'
        }`
      }
    >
      {({ isActive }) => <IconCmp size={24} weight={isActive ? 'fill' : 'regular'} />}
    </NavLink>
  );
}

function UserMenu() {
  const me = useCurrentUser();
  const logout = useLogout();
  return (
    <>
      <button
        type="button"
        popoverTarget="user-menu"
        title={me.name}
        aria-label="Menu do usuário"
        className="flex size-10 items-center justify-center rounded-full bg-primary text-sm font-semibold text-white hover:ring-2 hover:ring-primary/40"
      >
        {initials(me.name)}
      </button>
      <div
        id="user-menu"
        popover="auto"
        className="inset-auto bottom-3 left-18 m-0 w-60 rounded-xl border border-border bg-panel p-2 text-fg shadow-2xl"
      >
        <div className="px-3 py-2">
          <p className="truncate text-sm font-medium">{me.name}</p>
          <p className="truncate text-xs text-muted">{me.email}</p>
        </div>
        <button
          type="button"
          onClick={() => logout.mutate()}
          className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm hover:bg-sidebar-hover"
        >
          <SignOutIcon size={18} /> Sair
        </button>
      </div>
    </>
  );
}

function ChannelBanner() {
  const me = useCurrentUser();
  const { data } = useQuery({ queryKey: qk.channels, queryFn: api.channels.list });
  const down = (data ?? []).filter((c) => c.status !== 'connected');
  if (down.length === 0) return null;
  return (
    <div role="alert" className="flex items-center gap-2 bg-danger px-4 py-2 text-sm font-medium text-white">
      <WarningCircleIcon size={18} weight="fill" />
      <span>WhatsApp desconectado: {down.map((c) => c.name).join(', ')}.</span>
      {me.role === 'admin' && (
        <Link to="/configuracoes/canais" className="underline underline-offset-2">
          Reconectar
        </Link>
      )}
    </div>
  );
}

export default function AppLayout() {
  const qc = useQueryClient();
  useEffect(() => connectWs(qc), [qc]);

  return (
    <div className="flex h-dvh bg-surface text-fg">
      <nav className="flex w-16 shrink-0 flex-col items-center gap-1 bg-sidebar py-3" aria-label="Menu principal">
        <ChatsCircleIcon size={32} weight="fill" className="mb-4 text-primary" aria-hidden />
        <NavItem to="/chats" label="Conversas" icon={ChatCircleDotsIcon} />
        <NavItem to="/contacts" label="Contatos" icon={AddressBookIcon} />
        <NavItem to="/configuracoes" label="Configurações" icon={GearSixIcon} />
        <div className="flex-1" />
        <UserMenu />
      </nav>
      <div className="flex min-w-0 flex-1 flex-col">
        <ChannelBanner />
        <main className="min-h-0 flex-1">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
