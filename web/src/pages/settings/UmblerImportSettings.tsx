import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  UMBLER_IMPORT_ERRORS, UMBLER_IMPORT_PHASES, UMBLER_PHASE_LABELS, formatOfficeDateTime,
  type ChannelDto, type UmblerAnalysisDto, type UmblerCountsDto, type UmblerImportDto, type UmblerMappingDto,
} from '@talk/shared';
import { api, qk } from '../../lib/api';
import { confirmDialog } from '../../lib/confirm';
import { formatPhone } from '../../lib/format';
import { fieldSelect } from '../../components/ui';
import { ErrorText, Loading, PageHeader, SettingRow, SettingsSection, block, btnPrimary, btnSecondary } from '../../components/settings/common';

// Spec 2026-10-21 importar-umbler §6: Ajustes › Importar do Umbler (admins only; the server answers 403 to anyone else).

const POLL_MS = 3_000;
const n = (x: number) => x.toLocaleString('pt-BR');
const day = (iso: string) => new Date(iso).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' });
const gb = (bytes: number) => (bytes / 1024 ** 3).toLocaleString('pt-BR', { maximumFractionDigits: 1 });
const list = (names: string[]) => names.join(', ');

/** "(duração 2 h 15 min)" */
export function durationText(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  const h = Math.floor(minutes / 60);
  return h ? `${h} h ${minutes % 60} min` : `${minutes} min`;
}

/** The counters while it runs (§6.1). */
export function progressLines(p: UmblerCountsDto): string[] {
  return [
    `Contatos: ${n(p.contacts.created + p.contacts.completed + p.contacts.lidOnly)}`,
    `Conversas: ${n(p.chats.openCreated + p.chats.openMerged + p.chats.closed)}`,
    `Mensagens: ${n(p.messages.total)} (notas internas: ${n(p.messages.notes)})`,
    `Observações: ${n(p.notes)}`,
    `Arquivos: ${n(p.files.saved)} baixados, ${n(p.files.expired)} indisponíveis`,
    `Casadas com o histórico do WhatsApp: ${n(p.messages.matched)}`,
  ];
}

/** The final report (§6.4): created / already here / left out, per item. */
export function reportLines(r: UmblerCountsDto): string[] {
  const lines = [
    `Setores: ${n(r.sectors.created)} criados, ${n(r.sectors.existing)} já existiam`,
    `Etiquetas: ${n(r.tags.created)} criadas, ${n(r.tags.existing)} já existiam`,
    `Campos personalizados: ${n(r.customFields.created)} criados, ${n(r.customFields.existing)} já existiam` +
      (r.customFields.unsupported.length ? `; não suportados: ${list(r.customFields.unsupported)}` : ''),
    `Atendentes: ${n(r.members.linked)} vinculados, ${n(r.members.createdInactive)} criados inativos, ${n(r.members.none)} sem atendente`,
    `Respostas rápidas: ${n(r.quickAnswers.created)} criadas, ${n(r.quickAnswers.existing)} já existiam` +
      (r.quickAnswers.unmappedVariables.length ? `; variáveis não convertidas em: ${list(r.quickAnswers.unmappedVariables)}` : '') +
      (r.quickAnswers.attachmentErrors.length ? `; anexos que falharam em: ${list(r.quickAnswers.attachmentErrors)}` : ''),
    `Contatos: ${n(r.contacts.created)} criados, ${n(r.contacts.completed)} completados, ${n(r.contacts.lidOnly)} só com LID, ` +
      `${n(r.contacts.skipped)} ignorados sem telefone nem LID`,
    `Observações: ${n(r.notes)}`,
    `Conversas abertas: ${n(r.chats.openCreated)} criadas, ${n(r.chats.openMerged)} juntadas a uma conversa aberta daqui`,
    `Conversas finalizadas: ${n(r.chats.closed)}`,
    `Conversas ignoradas: ${n(r.chats.skippedChannel)} de canal “Não importar”, ${n(r.chats.skippedEmpty)} sem mensagens, ` +
      `${n(r.chats.skippedDeleted)} apagadas aqui, ${n(r.chats.skippedNoAddress)} sem telefone nem LID`,
    `Mensagens: ${n(r.messages.total)} (notas ${n(r.messages.notes)}, de chatbot ${n(r.messages.bot)}, ` +
      `de atendente desconhecido ${n(r.messages.unknownAuthor)}, sem conteúdo para o token ${n(r.messages.redacted)})`,
    `Casadas com o histórico do WhatsApp: ${n(r.messages.matched)} (maior diferença: ` +
      `${(r.messages.maxMatchDiffMs / 1000).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} s)`,
    `Arquivos: ${n(r.files.saved)} baixados (${gb(r.files.bytes)} GB), ${n(r.files.expired)} indisponíveis`,
  ];
  if (r.gone) lines.push(`Apagados no Umbler durante a cópia: ${n(r.gone)}`);
  if (r.planLimited) lines.push('O plano do Umbler escondeu mensagens antigas; elas não vieram.');
  return lines;
}

type ChannelRow = UmblerAnalysisDto['channels'][number];

/** §6.2/§6.3 under a channel's selector: what its destination means. */
export function channelHint(ch: ChannelRow, target: string, ours: ChannelDto[]): string | null {
  if (target === 'none') return ch.chats === 1 ? '1 conversa deste canal não vem.' : `${n(ch.chats)} conversas deste canal não vêm.`;
  const to = ours.find((c) => c.id === target);
  if (!to || !ch.phone || to.phone === ch.phone) return null;
  if (target === ch.proposal) {
    return `As conversas do número ${formatPhone(ch.phone)} entram no canal ${to.name}; respostas a elas saem do número oficial.`;
  }
  return to.phone ? `Respostas nessas conversas sairão do número ${formatPhone(to.phone)}.` : null;
}

function Lines({ lines }: { lines: string[] }) {
  return (
    <ul className="mt-2 space-y-1.5 text-sm text-fg-2">
      {lines.map((line, i) => (
        <li key={i}>{line}</li>
      ))}
    </ul>
  );
}

function Blocks({ blocks }: { blocks: string[] }) {
  return blocks.map((b) => (
    <p key={b} role="alert" className={`${block} mt-3 text-sm font-semibold text-danger`}>
      {b}
    </p>
  ));
}

function Analysis({ imp, analysis: a, onStart, pending, tokenConfigured, error }: {
  imp: UmblerImportDto;
  analysis: UmblerAnalysisDto;
  onStart: (mapping: UmblerMappingDto) => void;
  pending: boolean;
  tokenConfigured: boolean;
  error: unknown;
}) {
  const channels = useQuery({ queryKey: qk.channels, queryFn: api.channels.list });
  const sectors = useQuery({ queryKey: qk.sectors, queryFn: api.sectors.list });
  const users = useQuery({ queryKey: qk.users, queryFn: api.users.list });
  const [mapping, setMapping] = useState<UmblerMappingDto>(() => ({
    channels: Object.fromEntries(a.channels.map((c) => [c.id, c.proposal])),
    sectors: Object.fromEntries(a.sectors.map((s) => [s.id, s.proposal])),
    members: Object.fromEntries(a.members.map((m) => [m.id, m.proposal])),
  }));
  if (!channels.data || !sectors.data || !users.data) return <Loading error={channels.error ?? sectors.error ?? users.error} />;
  const set = (group: keyof UmblerMappingDto, id: string, value: string) =>
    setMapping((m) => ({ ...m, [group]: { ...m[group], [id]: value } }));
  const contactsToImport = a.contacts.total - a.contacts.withoutAddress;
  const chatsToImport = a.chats.open + a.chats.closed - a.channels.reduce((sum, ch) => sum + (mapping.channels[ch.id] === 'none' ? ch.chats : 0), 0);

  async function confirmStart() {
    const ok = await confirmDialog({
      title: `Importar ${n(contactsToImport)} contatos e ${n(chatsToImport)} conversas do Umbler?`,
      body: 'A cópia roda em segundo plano e pode levar algumas horas.',
      confirmLabel: 'Importar',
      danger: false,
    });
    if (ok) onStart(mapping);
  }

  return (
    <>
      <SettingsSection title="O que foi encontrado" description={`Organização ${a.organization} no Umbler Talk.`}>
        <Lines
          lines={[
            `Contatos: ${n(contactsToImport - a.contacts.existing)} novos, ${n(a.contacts.existing)} já existem aqui, ` +
              `${n(a.contacts.withoutAddress)} sem telefone nem LID (não vêm)`,
            `Conversas abertas: ${n(a.chats.open)} (das quais ${n(a.chats.waiting)} esperando)`,
            `Conversas finalizadas: ${n(a.chats.closed)}`,
            ...(a.chats.from && a.chats.to ? [`Período: de ${day(a.chats.from)} a ${day(a.chats.to)}`] : []),
            `Setores: ${n(a.sectors.length)} · Atendentes: ${n(a.members.length)}`,
            `Etiquetas: ${n(a.tags.new)} novas, ${n(a.tags.existing)} já existem`,
            `Campos: ${n(a.customFields.new)} novos, ${n(a.customFields.existing)} já existem` +
              (a.customFields.unsupported.length ? `; não suportados: ${list(a.customFields.unsupported)}` : ''),
            `Respostas rápidas: ${n(a.quickAnswers.new)} novas, ${n(a.quickAnswers.existing)} já existem`,
          ]}
        />
      </SettingsSection>

      <SettingsSection title="Canais">
        {a.channels.map((ch) => {
          const id = `umbler-channel-${ch.id}`;
          const hint = channelHint(ch, mapping.channels[ch.id] ?? 'none', channels.data);
          return (
            <SettingRow
              key={ch.id}
              label={ch.name}
              htmlFor={id}
              description={
                <>
                  {`${ch.whatsapp ? 'WhatsApp' : 'Não é WhatsApp'}${ch.phone ? ` · ${formatPhone(ch.phone)}` : ''} · ${n(ch.chats)} conversas`}
                  {hint && <span className="block text-fg-2">{hint}</span>}
                </>
              }
              control={
                <select
                  id={id}
                  value={mapping.channels[ch.id]}
                  disabled={!ch.whatsapp}
                  onChange={(e) => set('channels', ch.id, e.target.value)}
                  className={`${fieldSelect} w-64`}
                >
                  {ch.whatsapp &&
                    channels.data.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.phone ? `${c.name} (${formatPhone(c.phone)})` : c.name}
                      </option>
                    ))}
                  <option value="none">Não importar</option>
                </select>
              }
            />
          );
        })}
      </SettingsSection>

      <SettingsSection title="Setores">
        {a.sectors.map((s) => {
          const id = `umbler-sector-${s.id}`;
          return (
            <SettingRow
              key={s.id}
              label={s.name}
              htmlFor={id}
              control={
                <select id={id} value={mapping.sectors[s.id]} onChange={(e) => set('sectors', s.id, e.target.value)} className={`${fieldSelect} w-64`}>
                  {sectors.data.map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.name}
                    </option>
                  ))}
                  <option value="create">{`Criar setor “${s.name}”`}</option>
                </select>
              }
            />
          );
        })}
      </SettingsSection>

      <SettingsSection title="Atendentes">
        {a.members.map((m) => {
          const id = `umbler-member-${m.id}`;
          return (
            <SettingRow
              key={m.id}
              label={m.name}
              htmlFor={id}
              description={`${m.email} · ${m.active ? 'ativo' : 'inativo'} no Umbler · ${n(m.chats)} conversas`}
              control={
                <select id={id} value={mapping.members[m.id]} onChange={(e) => set('members', m.id, e.target.value)} className={`${fieldSelect} w-64`}>
                  {users.data.map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.active ? u.name : `${u.name} (inativo)`}
                    </option>
                  ))}
                  <option value="create">Criar usuário inativo</option>
                  <option value="none">Sem atendente</option>
                </select>
              }
            />
          );
        })}
      </SettingsSection>

      <SettingsSection title="Avisos">
        <Blocks blocks={imp.blocks} />
        <Lines lines={a.warnings} />
      </SettingsSection>

      <div className="mt-7 flex flex-wrap items-center gap-x-3 gap-y-1">
        <button
          type="button"
          disabled={pending || !tokenConfigured || imp.blocks.length > 0}
          onClick={() => void confirmStart()}
          className={btnPrimary}
        >
          Importar
        </button>
        <ErrorText error={error} />
      </div>
    </>
  );
}

function Running({ imp }: { imp: UmblerImportDto }) {
  const phase = imp.phase ?? 'catalog';
  const p = imp.progress;
  // the office may close chats in Umbler after "Analisar": the list then brings more than the analysis counted
  const of = p && p.total > 0 ? ` — ${n(p.done)} de ${n(Math.max(p.total, p.done))}` : '';
  return (
    <SettingsSection title="Importando">
      <p role="status" className="text-sm font-semibold">
        {`Etapa ${UMBLER_IMPORT_PHASES.indexOf(phase) + 1} de ${UMBLER_IMPORT_PHASES.length}: ${UMBLER_PHASE_LABELS[phase]}${of}`}
      </p>
      {p && <Lines lines={progressLines(p)} />}
      <p className="mt-3 text-[13px] leading-[18px] text-muted">
        Pode fechar esta tela: a importação continua no servidor e retoma sozinha se o sistema reiniciar.
      </p>
    </SettingsSection>
  );
}

function Failed({ imp, onResume, pending, tokenConfigured, error }: {
  imp: UmblerImportDto;
  onResume: () => void;
  pending: boolean;
  tokenConfigured: boolean;
  error: unknown;
}) {
  const reason = UMBLER_IMPORT_ERRORS[imp.error ?? 'unexpected'].replace(/\.$/, '');
  if (!imp.startedAt) {
    // an analysis that stopped: there is no "Continuar", "Analisar de novo" starts another one
    return (
      <p role="alert" className={`${block} mt-5 text-sm font-semibold text-danger`}>
        {`A análise parou: ${reason.replace('Clique em Continuar', 'Clique em Analisar de novo')}.`}
      </p>
    );
  }
  return (
    <SettingsSection title="Importação">
      <p role="alert" className="text-sm font-semibold text-danger">{`A importação parou: ${reason}. O que já entrou fica.`}</p>
      <Blocks blocks={imp.blocks} />
      {imp.progress && <Lines lines={progressLines(imp.progress)} />}
      <div className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-1">
        <button type="button" disabled={pending || !tokenConfigured || imp.blocks.length > 0} onClick={onResume} className={btnPrimary}>
          Continuar
        </button>
        <ErrorText error={error} />
      </div>
    </SettingsSection>
  );
}

function Done({ imp }: { imp: UmblerImportDto }) {
  const r = imp.report;
  return (
    <SettingsSection title="Relatório">
      <p role="status" className="text-sm font-semibold">
        {`Importação concluída em ${imp.finishedAt ? formatOfficeDateTime(imp.finishedAt) : ''} (duração ${durationText(r?.durationMs ?? 0)}).`}
      </p>
      {r && <Lines lines={reportLines(r)} />}
    </SettingsSection>
  );
}

export function UmblerImportSettings() {
  const qc = useQueryClient();
  const status = useQuery({
    queryKey: qk.umblerImport,
    queryFn: api.umblerImport.get,
    // §6: polls while it analyzes or imports (no WS event)
    refetchInterval: (q) => {
      const state = q.state.data?.current?.state;
      return state === 'analyzing' || state === 'running' ? POLL_MS : false;
    },
  });
  // `near`: where its error shows, by "Analisar" or by the Importar / Continuar button
  const act = useMutation({
    mutationFn: (v: { near: 'analyze' | 'go'; run: () => Promise<unknown> }) => v.run(),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.umblerImport }),
  });
  const errorNear = (near: 'analyze' | 'go') => (act.variables?.near === near ? act.error : null);
  if (!status.data) return <Loading error={status.error} />;
  const { tokenConfigured, current } = status.data;
  const active = current?.state === 'analyzing' || current?.state === 'running';

  async function analyze() {
    // a new analysis resets every choice below to its proposals
    if (current?.state === 'analyzed') {
      const ok = await confirmDialog({
        title: 'Analisar o Umbler de novo?',
        body: 'Os destinos escolhidos abaixo voltam às sugestões da nova análise.',
        confirmLabel: 'Analisar de novo',
        danger: false,
      });
      if (!ok) return;
    }
    act.mutate({ near: 'analyze', run: () => api.umblerImport.analyze() });
  }

  return (
    <>
      <PageHeader
        title="Importar do Umbler"
        description="Traz do Umbler Talk os contatos, os cadastros, os atendentes e todas as conversas, abertas e finalizadas."
      />
      <SettingsSection title="Token de acesso">
        <SettingRow
          label="Token do Umbler"
          description={
            tokenConfigured ? (
              'Token do Umbler configurado.'
            ) : (
              <>
                Token do Umbler não configurado. Coloque <code>UMBLER_TOKEN</code> no arquivo <code>.env</code> do servidor e reinicie o
                sistema.
              </>
            )
          }
          control={
            !active && (
              <button
                type="button"
                disabled={!tokenConfigured || act.isPending}
                onClick={() => void analyze()}
                className={current ? btnSecondary : btnPrimary}
              >
                {current ? 'Analisar de novo' : 'Analisar'}
              </button>
            )
          }
        />
      </SettingsSection>
      <ErrorText error={errorNear('analyze')} />

      {current?.state === 'analyzing' && (
        <p role="status" className={`${block} mt-5 text-sm font-semibold`}>
          {`Analisando o Umbler… ${n(current.progress?.chatsRead ?? 0)} conversas lidas`}
        </p>
      )}
      {current?.state === 'analyzed' && current.analysis && (
        <Analysis
          key={current.id}
          imp={current}
          analysis={current.analysis}
          pending={act.isPending}
          tokenConfigured={tokenConfigured}
          error={errorNear('go')}
          onStart={(mapping) => act.mutate({ near: 'go', run: () => api.umblerImport.start(current.id, mapping) })}
        />
      )}
      {current?.state === 'running' && <Running imp={current} />}
      {current?.state === 'failed' && (
        <Failed
          imp={current}
          pending={act.isPending}
          tokenConfigured={tokenConfigured}
          error={errorNear('go')}
          onResume={() => act.mutate({ near: 'go', run: () => api.umblerImport.resume(current.id) })}
        />
      )}
      {current?.state === 'done' && <Done imp={current} />}
    </>
  );
}
