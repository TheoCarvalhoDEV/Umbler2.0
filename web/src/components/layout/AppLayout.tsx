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
import { menu, menuItem } from '../ui';

function NavItem({ to, label, icon: IconCmp }: { to: string; label: string; icon: Icon }) {
  return (
    <NavLink
      to={to}
      className={({ isActive }) =>
        `flex w-[60px] flex-col items-center gap-1 rounded-block py-2 text-[11px] leading-[14px] transition-colors ${
          isActive ? 'bg-rail-active font-semibold text-nav-on' : 'font-medium text-rail-fg hover:bg-rail-active/60 hover:text-nav-on'
        }`
      }
    >
      {({ isActive }) => (
        <>
          <IconCmp size={20} weight={isActive ? 'fill' : 'regular'} aria-hidden />
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
      <div className="flex gap-0.5 rounded-full bg-panel p-0.5">
        {THEMES.map(([value, label]) => (
          <button
            key={value}
            type="button"
            aria-pressed={pref === value}
            onClick={() => {
              setThemePref(value);
              setPref(value);
            }}
            className={`h-8 flex-1 rounded-full text-[13px] font-semibold ${pref === value ? 'bg-chip-on text-chip-on-fg' : 'text-fg-2 hover:bg-border'}`}
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
        className="relative rounded-full ring-2 ring-transparent hover:ring-rail-badge/60"
      >
        <Avatar name={me.name} src={me.avatarUrl} className="size-10 text-[13px]" />
        <span aria-hidden className="absolute -right-px -bottom-px size-3 rounded-full bg-online ring-2 ring-rail" />
      </button>
      <div
        id="user-menu"
        popover="auto"
        className={`${menu} inset-auto bottom-3 left-[100px] m-0 w-64 p-2`}
      >
        <div className="px-3 py-2">
          <p className="truncate text-sm font-bold">{me.name}</p>
          <p className="truncate text-xs text-muted">{me.email}</p>
        </div>
        <ThemePicker />
        <NotificationPermissionButton />
        <button
          type="button"
          onClick={() => logout.mutate()}
          className={menuItem}
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
    <div className="flex h-dvh gap-3 bg-ground p-3 text-fg">
      <nav className="flex w-[76px] shrink-0 flex-col items-center gap-1.5 overflow-y-auto rounded-card bg-rail px-2 py-3.5" aria-label="Menu principal">
        <img src="/logo-mark.svg" alt="" className="mb-3.5 size-10" />
        <NavItem to="/chats" label="Conversas" icon={ChatCircleDotsIcon} />
        <NavItem to="/contacts" label="Contatos" icon={AddressBookIcon} />
        <NavItem to="/configuracoes" label="Ajustes" icon={GearSixIcon} />
        <div className="flex-1" />
        <UserMenu />
      </nav>
      <div className="flex min-w-0 flex-1 flex-col gap-3">
        <ChannelBanner />
        <main className="min-h-0 flex-1">
          <Outlet />
        </main>
      </div>
      <NotificationToasts />
    </div>
  );
}
