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

const GROUPS = ['Você', 'Atendimento', 'Equipe e cadastros'] as const;

const SECTIONS: Array<{ path: string; label: string; group: (typeof GROUPS)[number]; adminOnly: boolean; page: ComponentType }> = [
  { path: 'perfil', label: 'Perfil', group: 'Você', adminOnly: false, page: ProfileSettings },
  { path: 'respostas-rapidas', label: 'Respostas rápidas', group: 'Você', adminOnly: false, page: QuickAnswersSettings },
  { path: 'canais', label: 'Canais', group: 'Atendimento', adminOnly: true, page: ChannelsSettings },
  { path: 'setores', label: 'Setores', group: 'Atendimento', adminOnly: true, page: SectorsSettings },
  { path: 'triagem', label: 'Triagem', group: 'Atendimento', adminOnly: true, page: TriageSettings },
  { path: 'chatbots', label: 'Chatbots', group: 'Atendimento', adminOnly: true, page: BotsSettings },
  { path: 'conversas', label: 'Conversas', group: 'Atendimento', adminOnly: true, page: ChatSettings },
  { path: 'atendentes', label: 'Atendentes', group: 'Equipe e cadastros', adminOnly: true, page: UsersSettings },
  { path: 'etiquetas', label: 'Etiquetas', group: 'Equipe e cadastros', adminOnly: true, page: TagsSettings },
  { path: 'campos', label: 'Campos personalizados', group: 'Equipe e cadastros', adminOnly: true, page: CustomFieldsSettings },
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
      <nav aria-label="Configurações" className="w-60 shrink-0 overflow-y-auto border-r border-border bg-surface px-3.5 py-7">
        <h2 className="mb-5 px-2.5 text-xl font-semibold tracking-tight">Configurações</h2>
        {GROUPS.map((group) => {
          const items = visible.filter((s) => s.group === group);
          if (items.length === 0) return null;
          return (
            <div key={group} className="mb-5">
              <h3 className="mb-1.5 px-2.5 text-[11px] font-semibold tracking-wider text-muted uppercase">{group}</h3>
              <ul className="space-y-0.5">
                {items.map((s) => (
                  <li key={s.path}>
                    <NavLink
                      to={`/configuracoes/${s.path}`}
                      className={({ isActive }) =>
                        `flex h-9 items-center rounded-lg px-2.5 text-sm ${
                          isActive ? 'bg-sidebar-active font-semibold text-link' : 'font-medium text-muted hover:bg-sidebar-hover hover:text-fg'
                        }`
                      }
                    >
                      {s.label}
                    </NavLink>
                  </li>
                ))}
              </ul>
            </div>
          );
        })}
      </nav>
      <main className="min-w-0 flex-1 overflow-y-auto px-10 py-8">
        <Page />
      </main>
    </div>
  );
}
