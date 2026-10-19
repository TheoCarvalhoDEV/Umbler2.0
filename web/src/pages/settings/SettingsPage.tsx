import type { ComponentType } from 'react';
import { NavLink, Navigate, useParams } from 'react-router';
import { useCurrentUser } from '../../lib/auth';
import { ProfileSettings } from './ProfileSettings';
import { ChannelsSettings } from './ChannelsSettings';
import { UsersSettings } from './UsersSettings';
import { SectorsSettings } from './SectorsSettings';
import { TagsSettings } from './TagsSettings';
import { CustomFieldsSettings } from './CustomFieldsSettings';
import { QuickAnswersSettings } from './QuickAnswersSettings';
import { TriageSettings } from './TriageSettings';
import { ChatSettings } from './ChatSettings';
import { BotsSettings } from './bots/BotsSettings';

const SECTIONS: Array<{ path: string; label: string; adminOnly: boolean; page: ComponentType }> = [
  { path: 'perfil', label: 'Perfil', adminOnly: false, page: ProfileSettings },
  { path: 'canais', label: 'Canais', adminOnly: true, page: ChannelsSettings },
  { path: 'atendentes', label: 'Atendentes', adminOnly: true, page: UsersSettings },
  { path: 'setores', label: 'Setores', adminOnly: true, page: SectorsSettings },
  { path: 'etiquetas', label: 'Etiquetas', adminOnly: true, page: TagsSettings },
  { path: 'campos', label: 'Campos personalizados', adminOnly: true, page: CustomFieldsSettings },
  { path: 'respostas-rapidas', label: 'Respostas rápidas', adminOnly: false, page: QuickAnswersSettings },
  { path: 'triagem', label: 'Triagem', adminOnly: true, page: TriageSettings },
  { path: 'chatbots', label: 'Chatbots', adminOnly: true, page: BotsSettings },
  { path: 'conversas', label: 'Conversas', adminOnly: true, page: ChatSettings },
];

export function SettingsPage() {
  const me = useCurrentUser();
  const { section } = useParams();
  const visible = SECTIONS.filter((s) => !s.adminOnly || me.role === 'admin');
  const current = visible.find((s) => s.path === section);
  // unknown section, or an admin-only section opened by an agent → Perfil (the server answers 403 anyway)
  if (!current) return <Navigate to="/configuracoes/perfil" replace />;
  const Page = current.page;

  return (
    <div className="flex h-full min-h-0">
      <nav aria-label="Configurações" className="w-56 shrink-0 overflow-y-auto border-r border-border p-3">
        <h2 className="mb-2 px-2 text-xs font-semibold uppercase tracking-wide text-muted">Configurações</h2>
        <ul className="space-y-1">
          {visible.map((s) => (
            <li key={s.path}>
              <NavLink
                to={`/configuracoes/${s.path}`}
                className={({ isActive }) =>
                  `block rounded px-2 py-1.5 text-sm ${isActive ? 'bg-sidebar-active font-medium text-fg' : 'hover:bg-sidebar-hover'}`
                }
              >
                {s.label}
              </NavLink>
            </li>
          ))}
        </ul>
      </nav>
      <main className="min-w-0 flex-1 overflow-y-auto p-6">
        <Page />
      </main>
    </div>
  );
}
