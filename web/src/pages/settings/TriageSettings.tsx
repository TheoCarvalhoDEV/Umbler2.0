import { useId, useState, type FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { SectorDto, SettingsDto, TriageMenuDto } from '@talk/shared';
import { api, qk } from '../../lib/api';
import { TriageOptionsEditor } from '../../components/settings/TriageOptionsEditor';
import { fieldArea } from '../../components/ui';
import { Loading, PageHeader, SaveBar, SentBubble, SettingRow, SettingsSection, Switch, send, useSend } from '../../components/settings/common';

export function TriageSettings() {
  const settings = useQuery({ queryKey: qk.settings, queryFn: api.settings.get });
  const sectors = useQuery({ queryKey: qk.sectors, queryFn: api.sectors.list });
  if (!settings.data || !sectors.data) return <Loading error={settings.error ?? sectors.error} />;
  return <TriageForm settings={settings.data} sectors={[...sectors.data].sort((a, b) => a.position - b.position)} />;
}

function problem(menu: TriageMenuDto): string | null {
  if (menu.options.some((o) => !o.key || !o.label.trim() || !o.sectorId)) return 'Preencha número, texto e setor de cada opção.';
  if (new Set(menu.options.map((o) => o.key)).size !== menu.options.length) return 'Os números das opções não podem se repetir.';
  if (menu.enabled && !menu.welcomeText.trim()) return 'Escreva a mensagem de boas-vindas.';
  if (menu.enabled && menu.options.length === 0) return 'Adicione ao menos uma opção.';
  return null;
}

function TriageForm({ settings, sectors }: { settings: SettingsDto; sectors: SectorDto[] }) {
  const [menu, setMenu] = useState<TriageMenuDto>(settings.triageMenu);
  const welcomeId = useId();
  const invalidId = useId();
  const save = useSend(qk.settings);
  const issue = problem(menu);
  const set = (patch: Partial<TriageMenuDto>) => setMenu((cur) => ({ ...cur, ...patch }));
  // what is sent: the option texts trimmed. Compared with the saved menu, it tells whether there is anything to save.
  const triageMenu = { ...menu, options: menu.options.map((o) => ({ ...o, label: o.label.trim() })) };
  const dirty = JSON.stringify(triageMenu) !== JSON.stringify(settings.triageMenu);
  // same layout Task 11 sends to the contact
  const preview = [menu.welcomeText.trim(), menu.options.map((o) => `${o.key} - ${o.label}`).join('\n')]
    .filter(Boolean)
    .join('\n\n');

  function submit(e: FormEvent) {
    e.preventDefault();
    if (issue) return;
    save.mutate(() => send('/api/settings', 'PUT', { ...settings, triageMenu }));
  }

  function discard() {
    setMenu(settings.triageMenu);
    save.reset();
  }

  return (
    <>
      <PageHeader title="Triagem" description="Um menu automático para o contato escolher o setor assim que começa uma conversa." />
      <form onSubmit={submit}>
        <SettingsSection title="Menu de entrada">
          <SettingRow
            label="Enviar menu de triagem"
            description="Vale quando um contato começa uma conversa."
            control={
              <Switch
                label="Enviar menu de triagem quando um contato começa uma conversa"
                checked={menu.enabled}
                onChange={(enabled) => set({ enabled })}
              />
            }
          />
          <SettingRow
            wide
            label="Mensagem de boas-vindas"
            htmlFor={welcomeId}
            description="Vai antes da lista de opções."
            control={<textarea id={welcomeId} rows={3} value={menu.welcomeText} onChange={(e) => set({ welcomeText: e.target.value })} className={fieldArea} />}
          />
        </SettingsSection>
        <SettingsSection title="Opções" description="O contato responde com o número ou com o nome do setor.">
          <TriageOptionsEditor options={menu.options} sectors={sectors} onChange={(options) => set({ options })} />
        </SettingsSection>
        <SettingsSection title="Resposta inválida">
          <SettingRow
            wide
            label="Mensagem para resposta inválida"
            htmlFor={invalidId}
            description="Enviada uma única vez. Depois disso, a conversa fica no setor padrão."
            control={<textarea id={invalidId} rows={2} value={menu.invalidText} onChange={(e) => set({ invalidText: e.target.value })} className={fieldArea} />}
          />
        </SettingsSection>
        {preview && (
          <SettingsSection title="Como o contato recebe">
            <SentBubble>
              <p className="break-words whitespace-pre-wrap">{preview}</p>
            </SentBubble>
          </SettingsSection>
        )}
        <SaveBar dirty={dirty} saving={save.isPending} onDiscard={discard} error={issue ? new Error(issue) : save.error} saved={save.isSuccess} disabled={!!issue} />
      </form>
    </>
  );
}
