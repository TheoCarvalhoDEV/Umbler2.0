import { useState, type FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { SectorDto, SettingsDto, TriageMenuDto } from '@talk/shared';
import { api, qk } from '../../lib/api';
import { TriageOptionsEditor } from '../../components/settings/TriageOptionsEditor';
import { checkbox, fieldArea, fieldLabel } from '../../components/ui';
import { ErrorText, Loading, Section, block, btnPrimary, hint, okText, send, useSend } from '../../components/settings/common';

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
  const save = useSend(qk.settings);
  const issue = problem(menu);
  const set = (patch: Partial<TriageMenuDto>) => setMenu((cur) => ({ ...cur, ...patch }));
  // same layout Task 11 sends to the contact
  const preview = [menu.welcomeText.trim(), menu.options.map((o) => `${o.key} - ${o.label}`).join('\n')]
    .filter(Boolean)
    .join('\n\n');

  function submit(e: FormEvent) {
    e.preventDefault();
    if (issue) return;
    const triageMenu = { ...menu, options: menu.options.map((o) => ({ ...o, label: o.label.trim() })) };
    save.mutate(() => send('/api/settings', 'PUT', { ...settings, triageMenu }));
  }

  return (
    <Section title="Triagem">
      <form onSubmit={submit} className="space-y-5">
        <label className="flex cursor-pointer items-center gap-3 text-sm font-bold">
          <input type="checkbox" checked={menu.enabled} onChange={(e) => set({ enabled: e.target.checked })} className={checkbox} />
          Enviar menu de triagem quando um contato começa uma conversa
        </label>
        <label className="block">
          <span className={fieldLabel}>Mensagem de boas-vindas</span>
          <textarea rows={3} value={menu.welcomeText} onChange={(e) => set({ welcomeText: e.target.value })} className={fieldArea} />
        </label>
        <div>
          <span className="block text-[13px] leading-[18px] font-semibold">Opções</span>
          <p className="mb-2 text-[13px] leading-[18px] text-muted">O contato responde com o número ou com o nome do setor.</p>
          <TriageOptionsEditor options={menu.options} sectors={sectors} onChange={(options) => set({ options })} />
        </div>
        <label className="block">
          <span className={fieldLabel}>Mensagem para resposta inválida</span>
          <textarea rows={2} value={menu.invalidText} onChange={(e) => set({ invalidText: e.target.value })} className={fieldArea} />
          <span className={hint}>
            Enviada uma única vez. Depois disso, a conversa fica no setor padrão.
          </span>
        </label>
        {preview && (
          <div>
            <span className={fieldLabel}>Como o contato recebe</span>
            <pre className={`${block} font-sans text-sm whitespace-pre-wrap`}>{preview}</pre>
          </div>
        )}
        {issue && <p className="text-[13px] font-semibold text-danger">{issue}</p>}
        <ErrorText error={save.error} />
        {save.isSuccess && <p className={okText}>Triagem salva.</p>}
        <button type="submit" disabled={!!issue || save.isPending} className={btnPrimary}>
          Salvar
        </button>
      </form>
    </Section>
  );
}
