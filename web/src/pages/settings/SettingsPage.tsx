import { useState, type ComponentType } from 'react';
import {
  BuildingsIcon, CalendarStarIcon, ChatsCircleIcon, CloudArrowDownIcon, FunnelIcon, LightningIcon, MagnifyingGlassIcon, RobotIcon,
  SlidersHorizontalIcon, TagIcon, TextAaIcon, TimerIcon, UserCircleIcon, UsersThreeIcon, WhatsappLogoIcon, type Icon,
} from '@phosphor-icons/react';
import { NavLink, Navigate, useParams } from 'react-router';
import { useCurrentUser } from '../../lib/auth';
import { ProfileSettings } from './ProfileSettings';
import { PreferencesSettings } from './PreferencesSettings';
import { ChannelsSettings } from './ChannelsSettings';
import { UsersSettings } from './UsersSettings';
import { SectorsSettings } from './SectorsSettings';
import { TagsSettings } from './TagsSettings';
import { CustomFieldsSettings } from './CustomFieldsSettings';
import { QuickAnswersSettings } from './QuickAnswersSettings';
import { TriageSettings } from './TriageSettings';
import { ChatSettings } from './ChatSettings';
import { AutoRulesSettings } from './AutoRulesSettings';
import { AppointmentSettings } from './AppointmentSettings';
import { BotsSettings } from './bots/BotsSettings';
import { UmblerImportSettings } from './UmblerImportSettings';
import { card, pageTitle, searchInput, searchPill } from '../../components/ui';

const GROUPS = ['Você', 'Atendimento', 'Equipe e cadastros'] as const;

type Item = { path: string; label: string; icon: Icon; group: (typeof GROUPS)[number]; adminOnly: boolean; page: ComponentType };
const SECTIONS: Item[] = [
  { path: 'perfil', label: 'Perfil', icon: UserCircleIcon, group: 'Você', adminOnly: false, page: ProfileSettings },
  { path: 'preferencias', label: 'Preferências', icon: SlidersHorizontalIcon, group: 'Você', adminOnly: false, page: PreferencesSettings },
  { path: 'respostas-rapidas', label: 'Respostas rápidas', icon: LightningIcon, group: 'Você', adminOnly: false, page: QuickAnswersSettings },
  { path: 'canais', label: 'Canais', icon: WhatsappLogoIcon, group: 'Atendimento', adminOnly: true, page: ChannelsSettings },
  { path: 'setores', label: 'Setores', icon: BuildingsIcon, group: 'Atendimento', adminOnly: true, page: SectorsSettings },
  { path: 'triagem', label: 'Triagem', icon: FunnelIcon, group: 'Atendimento', adminOnly: true, page: TriageSettings },
  { path: 'chatbots', label: 'Chatbots', icon: RobotIcon, group: 'Atendimento', adminOnly: true, page: BotsSettings },
  { path: 'conversas', label: 'Conversas', icon: ChatsCircleIcon, group: 'Atendimento', adminOnly: true, page: ChatSettings },
  { path: 'regras', label: 'Regras automáticas', icon: TimerIcon, group: 'Atendimento', adminOnly: true, page: AutoRulesSettings },
  { path: 'compromissos', label: 'Compromissos', icon: CalendarStarIcon, group: 'Atendimento', adminOnly: true, page: AppointmentSettings },
  { path: 'atendentes', label: 'Atendentes', icon: UsersThreeIcon, group: 'Equipe e cadastros', adminOnly: true, page: UsersSettings },
  { path: 'etiquetas', label: 'Etiquetas', icon: TagIcon, group: 'Equipe e cadastros', adminOnly: true, page: TagsSettings },
  { path: 'campos', label: 'Campos personalizados', icon: TextAaIcon, group: 'Equipe e cadastros', adminOnly: true, page: CustomFieldsSettings },
  { path: 'importar-umbler', label: 'Importar do Umbler', icon: CloudArrowDownIcon, group: 'Equipe e cadastros', adminOnly: true, page: UmblerImportSettings },
];

/** For the search: "preferencias" finds Preferências. */
const fold = (text: string) => text.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();

export function SettingsPage() {
  const me = useCurrentUser();
  const { section } = useParams();
  const [query, setQuery] = useState('');
  const visible = SECTIONS.filter((s) => !s.adminOnly || me.role === 'admin');
  const current = visible.find((s) => s.path === section);
  // unknown section, or an admin-only section opened by an agent → Perfil (the server answers 403 anyway)
  if (!current) return <Navigate to="/configuracoes/perfil" replace />;
  const Page = current.page;
  const found = visible.filter((s) => fold(s.label).includes(fold(query.trim())));

  return (
    <div className="flex h-full min-h-0 gap-3">
      {/* "Configurações": the name the Chatbots tests (and the /configuracoes URL) know this nav by */}
      <nav aria-label="Configurações" className={`${card} flex w-[248px] shrink-0 flex-col gap-5 overflow-y-auto px-3 pt-5 pb-[22px]`}>
        <div className="flex flex-col gap-3.5 px-1">
          <h2 className={pageTitle}>Ajustes</h2>
          <label className={searchPill}>
            <MagnifyingGlassIcon size={16} aria-hidden className="shrink-0" />
            <input
              type="search"
              aria-label="Buscar ajuste"
              placeholder="Buscar ajuste"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className={searchInput}
            />
          </label>
        </div>
        {found.length === 0 && <p className="px-3 text-sm text-muted">Nenhum ajuste encontrado</p>}
        {GROUPS.map((group) => {
          const items = found.filter((s) => s.group === group);
          if (items.length === 0) return null;
          return (
            <div key={group} className="flex flex-col gap-1.5">
              <h3 className="px-3 text-xs leading-4 font-semibold text-muted">{group}</h3>
              <ul className="flex flex-col gap-0.5">
                {items.map(({ icon: ItemIcon, ...s }) => (
                  <li key={s.path}>
                    <NavLink
                      to={`/configuracoes/${s.path}`}
                      className={({ isActive }) =>
                        `flex h-10 items-center gap-3 rounded-block px-3 text-sm transition-colors ${
                          isActive ? 'bg-sidebar-active font-bold text-accent-ink' : 'font-medium text-fg-2 hover:bg-sidebar-hover hover:text-fg'
                        }`
                      }
                    >
                      <ItemIcon size={20} aria-hidden className="shrink-0" />
                      {s.label}
                    </NavLink>
                  </li>
                ))}
              </ul>
            </div>
          );
        })}
      </nav>
      <main className={`${card} min-w-0 flex-1 overflow-y-auto`}>
        <div className="max-w-[880px] px-4 py-6 sm:px-6">
          <Page />
        </div>
      </main>
    </div>
  );
}
