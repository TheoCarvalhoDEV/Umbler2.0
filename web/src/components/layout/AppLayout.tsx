import { useEffect, useState } from 'react';
import { NavLink, Outlet } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import {
  AddressBookIcon,
  ChatCircleDotsIcon,
  GearSixIcon,
  SignOutIcon,
  type Icon,
} from '@phosphor-icons/react';
import { useCurrentUser, useLogout } from '../../lib/auth';
import { Avatar } from '../Avatar';
import { connectWs } from '../../lib/ws';
import { NotificationPermissionButton, useMessageNotifications } from '../../lib/notify';
import { ChannelBanner } from './ChannelBanner';
import { NotificationToasts } from './NotificationToasts';
import { readThemePref, setThemePref, type ThemePref } from '../../lib/theme';

function NavItem({ to, label, icon: IconCmp }: { to: string; label: string; icon: Icon }) {
  return (
    <NavLink
      to={to}
      className={({ isActive }) =>
        `relative flex h-14 w-[72px] flex-col items-center justify-center gap-1 rounded-xl text-[10.5px] font-medium transition-colors ${
          isActive
            ? 'bg-rail-active text-nav-on before:absolute before:-left-1 before:h-6 before:w-[3px] before:rounded-r before:bg-brass'
            : 'text-rail-fg hover:bg-rail-active hover:text-nav-on'
        }`
      }
    >
      {({ isActive }) => (
        <>
          <IconCmp size={22} weight={isActive ? 'fill' : 'regular'} aria-hidden />
          {label}
        </>
      )}
    </NavLink>
  );
}

const THEMES: Array<[ThemePref, string]> = [
  ['system', 'Sistema'],
  ['light', 'Claro'],
  ['dark', 'Escuro'],
];

function ThemePicker() {
  const [pref, setPref] = useState(readThemePref);
  return (
    <fieldset className="px-3 py-2">
      <legend className="mb-1 text-xs text-muted">Tema</legend>
      <div className="flex rounded-lg bg-panel p-0.5">
        {THEMES.map(([value, label]) => (
          <button
            key={value}
            type="button"
            aria-pressed={pref === value}
            onClick={() => {
              setThemePref(value);
              setPref(value);
            }}
            className={`flex-1 rounded-md py-1 text-sm ${pref === value ? 'bg-surface font-medium text-fg shadow-sm' : 'text-muted hover:text-fg'}`}
          >
            {label}
          </button>
        ))}
      </div>
    </fieldset>
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
        className="rounded-full ring-2 ring-rail-active hover:ring-brass/60"
      >
        <Avatar name={me.name} src={me.avatarUrl} className="size-10 text-sm bg-primary text-white" />
      </button>
      <div
        id="user-menu"
        popover="auto"
        className="inset-auto bottom-3 left-22 m-0 w-60 rounded-xl border border-border bg-surface p-2 text-fg shadow-2xl"
      >
        <div className="px-3 py-2">
          <p className="truncate text-sm font-medium">{me.name}</p>
          <p className="truncate text-xs text-muted">{me.email}</p>
        </div>
        <ThemePicker />
        <NotificationPermissionButton />
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

export default function AppLayout() {
  const qc = useQueryClient();
  useEffect(() => connectWs(qc), [qc]);
  useMessageNotifications();

  return (
    <div className="flex h-dvh bg-ground text-fg">
      <nav className="flex w-20 shrink-0 flex-col items-center gap-1 bg-rail py-4" aria-label="Menu principal">
        <img src="/logo-mark.svg" alt="" className="mb-4 size-10" />
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
      <NotificationToasts />
    </div>
  );
}
