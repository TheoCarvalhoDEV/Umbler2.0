import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import type { BotDto, OfficeTemplateDestination, OfficeTemplateInput, SectorDto } from '@talk/shared';
import { Actions, Modal } from '../../../components/conversation/ChatDialogs';
import { Loading, field } from '../../../components/settings/common';
import { api, qk } from '../../../lib/api';

type DestKey = keyof OfficeTemplateInput['destinations'];
interface Picked { sectorId: string; userId: string }

const DESTS: Record<DestKey, { label: string; match: string[] }> = {
  atendimento: { label: 'Atendimento', match: ['atendimento'] },
  financeiro: { label: 'Financeiro', match: ['financeiro'] },
  processos: { label: 'Processos', match: ['processos', 'juridico'] },
};
const KEYS = Object.keys(DESTS) as DestKey[];
const input = `${field} bg-surface text-fg`;

const fold = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

/** First sector whose name contains one of the words (accents ignored), else the default sector. */
function guessSector(sectors: SectorDto[], words: string[]): string {
  const hit = sectors.find((s) => words.some((w) => fold(s.name).includes(w)));
  return (hit ?? sectors.find((s) => s.isDefault) ?? sectors[0])?.id ?? '';
}

/** "Criar a partir do modelo": channel + three destinations → POST /api/bots/from-template (created paused). */
export function OfficeTemplateDialog({ onCancel, onCreated }: { onCancel: () => void; onCreated: (bot: BotDto) => void }) {
  const channels = useQuery({ queryKey: qk.channels, queryFn: api.channels.list });
  const sectors = useQuery({ queryKey: qk.sectors, queryFn: api.sectors.list });
  const users = useQuery({ queryKey: qk.users, queryFn: api.users.list });
  const [name, setName] = useState('Fluxo do escritório');
  const [companyName, setCompanyName] = useState('');
  const [channelId, setChannelId] = useState('');
  const [picked, setPicked] = useState<Partial<Record<DestKey, Picked>>>({});
  const [error, setError] = useState<string | null>(null);
  const create = useMutation({
    mutationFn: api.bots.fromTemplate,
    onSuccess: (bot) => onCreated(bot),
    onError: (e) => setError(e.message),
  });

  const ready = channels.data && sectors.data && users.data
    ? { channels: channels.data, sectors: sectors.data, users: users.data }
    : null;
  const channel = channelId || ready?.channels[0]?.id || '';
  const current = (k: DestKey): Picked =>
    picked[k] ?? { sectorId: guessSector(ready?.sectors ?? [], DESTS[k].match), userId: '' };
  const destination = (k: DestKey): OfficeTemplateDestination => {
    const v = current(k);
    return { sectorId: v.sectorId, userId: v.userId || null };
  };

  function submit() {
    const company = companyName.trim();
    if (!company) {
      setError('Informe o nome do escritório.');
      return;
    }
    if (!channel) {
      setError('Cadastre um canal antes de criar o fluxo.');
      return;
    }
    setError(null);
    create.mutate({
      ...(name.trim() ? { name: name.trim() } : {}),
      companyName: company,
      channelId: channel,
      destinations: {
        atendimento: destination('atendimento'),
        financeiro: destination('financeiro'),
        processos: destination('processos'),
      },
    });
  }

  return (
    <Modal title="Criar a partir do modelo" onCancel={onCancel}>
      {!ready ? (
        <Loading error={channels.error ?? sectors.error ?? users.error} />
      ) : (
        <div className="space-y-3 text-sm">
          <p className="text-xs text-muted">
            Recria o fluxo do escritório: horário de atendimento, boas-vindas, menu, comunicado, CPF e transferência. Textos e
            horários podem ser editados depois no editor. O chatbot é criado pausado.
          </p>
          <label className="block">
            Nome do chatbot
            <input value={name} maxLength={80} onChange={(e) => setName(e.target.value)} className={input} />
          </label>
          <label className="block">
            Nome do escritório
            <input
              value={companyName}
              maxLength={80}
              placeholder="Aparece na mensagem de boas-vindas"
              onChange={(e) => setCompanyName(e.target.value)}
              className={input}
            />
          </label>
          <label className="block">
            Canal
            <select value={channel} onChange={(e) => setChannelId(e.target.value)} className={input}>
              {ready.channels.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
          {KEYS.map((k) => {
            const v = current(k);
            const agents = ready.users.filter((u) => u.active && u.sectorIds.includes(v.sectorId));
            return (
              <fieldset key={k} className="rounded border border-border p-2">
                <legend className="px-1 text-xs font-medium">{DESTS[k].label}</legend>
                <div className="grid grid-cols-2 gap-2">
                  <label className="block">
                    Setor
                    <select
                      value={v.sectorId}
                      onChange={(e) => setPicked((p) => ({ ...p, [k]: { sectorId: e.target.value, userId: '' } }))}
                      className={input}
                    >
                      {ready.sectors.map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="block">
                    Atendente
                    <select
                      value={v.userId}
                      onChange={(e) => setPicked((p) => ({ ...p, [k]: { ...v, userId: e.target.value } }))}
                      className={input}
                    >
                      <option value="">Nenhum (fila do setor)</option>
                      {agents.map((u) => (
                        <option key={u.id} value={u.id}>
                          {u.name}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
              </fieldset>
            );
          })}
        </div>
      )}
      <Actions busy={create.isPending || !ready} error={error} confirmLabel="Criar" onCancel={onCancel} onConfirm={submit} />
    </Modal>
  );
}
