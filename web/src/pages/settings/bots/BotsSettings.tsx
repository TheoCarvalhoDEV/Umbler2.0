import { useState, type ChangeEvent, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { PlusIcon, RobotIcon } from '@phosphor-icons/react';
import type { BotDto } from '@talk/shared';
import { Actions, Modal } from '../../../components/conversation/ChatDialogs';
import { EmptyState, ListRow, Loading, PageHeader, RowMenu, btnPrimary, btnSecondary, useSend } from '../../../components/settings/common';
import { badge, badgeTone, field, fieldLabel } from '../../../components/ui';
import { api, ApiError, qk, readBotExport } from '../../../lib/api';
import { confirmDialog } from '../../../lib/confirm';
import { OfficeTemplateDialog } from './OfficeTemplateDialog';

const editorPath = (id: string) => `/configuracoes/chatbots/${id}`;

function statusLabel(b: BotDto): string {
  if (b.status === 'active') return 'Ativo';
  return b.publishedVersionId ? 'Pausado' : 'Rascunho';
}

function runsLabel(b: BotDto): string {
  const runs = b.runCount === 1 ? '1 execução' : `${b.runCount} execuções`;
  return b.activeRunCount > 0 ? `${runs} (${b.activeRunCount} em andamento)` : runs;
}

function channelsLabel(b: BotDto, names: Map<string, string>): string {
  const list = b.startChannelIds.map((id) => names.get(id) ?? 'Canal removido');
  if (b.manualStart) list.push('Início manual');
  return list.join(', ') || 'Nenhum canal';
}

/** Names from the DELETE 409 `{ usedBy: [{ id, name }] }`; [] for any other error. */
function usedByNames(e: unknown): string[] {
  if (!(e instanceof ApiError)) return [];
  const list = (e.data as { usedBy?: unknown } | null | undefined)?.usedBy;
  return Array.isArray(list) ? list.map((b) => String((b as { name?: unknown }).name ?? '')) : [];
}

export function BotsSettings() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const bots = useQuery({ queryKey: qk.bots, queryFn: api.bots.list });
  const channels = useQuery({ queryKey: qk.channels, queryFn: api.channels.list });
  const save = useSend(qk.bots);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [template, setTemplate] = useState(false);

  if (!bots.data) return <Loading error={bots.error} />;
  const channelNames = new Map((channels.data ?? []).map((c) => [c.id, c.name]));
  const used = usedByNames(save.error);

  function create(e?: FormEvent) {
    e?.preventDefault();
    if (!name.trim() || save.isPending) return;
    save.mutate(async () => {
      const bot = await api.bots.create({ name: name.trim() });
      navigate(editorPath(bot.id));
    });
  }

  function importFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ''; // lets the same file be picked again
    if (file) save.mutate(async () => api.bots.importBot(await readBotExport(file)));
  }

  function toggle(b: BotDto) {
    save.mutate(() => api.bots.setStatus(b.id, b.status === 'active' ? 'paused' : 'active'));
  }

  async function remove(b: BotDto) {
    const body = 'As versões e o histórico de execuções também serão apagados.';
    if (await confirmDialog({ title: `Excluir o chatbot "${b.name}"?`, body, confirmLabel: 'Excluir chatbot' })) {
      save.mutate(() => api.bots.remove(b.id));
    }
  }

  return (
    <>
      <PageHeader
        title="Chatbots"
        description="Fluxos automáticos que atendem pelo WhatsApp antes de passar a conversa para um setor."
        action={
          <>
            <label className={`${btnSecondary} cursor-pointer focus-within:ring-2 focus-within:ring-primary`}>
              Importar
              <input type="file" accept=".json,application/json" onChange={importFile} className="sr-only" />
            </label>
            <button type="button" onClick={() => setTemplate(true)} className={btnSecondary}>
              Criar a partir do modelo
            </button>
            <button
              type="button"
              onClick={() => {
                save.reset();
                setName('');
                setCreating(true);
              }}
              className={btnPrimary}
            >
              <PlusIcon size={16} weight="bold" aria-hidden />
              Novo chatbot
            </button>
          </>
        }
      />
      {template && (
        <OfficeTemplateDialog
          onCancel={() => setTemplate(false)}
          onCreated={(bot) => {
            setTemplate(false);
            void qc.invalidateQueries({ queryKey: qk.bots });
            navigate(editorPath(bot.id));
          }}
        />
      )}
      {creating && (
        <Modal title="Novo chatbot" onCancel={() => setCreating(false)}>
          <form onSubmit={create}>
            <label className="block">
              <span className={fieldLabel}>Nome do chatbot</span>
              <input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} autoFocus className={field} />
            </label>
            <Actions
              busy={save.isPending || !name.trim()}
              error={save.error?.message ?? null}
              confirmLabel="Criar"
              onCancel={() => setCreating(false)}
              onConfirm={create}
            />
          </form>
        </Modal>
      )}
      {save.error && !creating && (
        <div role="alert" className="mt-5 rounded-block bg-danger-soft px-4 py-3 text-sm font-semibold text-danger">
          <p>{save.error.message}</p>
          {used.length > 0 && <p>Usado por: {used.join(', ')}</p>}
        </div>
      )}
      {bots.data.length === 0 ? (
        <EmptyState
          icon={<RobotIcon size={28} />}
          title="Nenhum chatbot ainda"
          hint="Crie um novo, importe um arquivo ou comece pelo modelo do escritório."
        />
      ) : (
        <ul className="mt-5">
          {bots.data.map((b) => (
            <ListRow
              key={b.id}
              leading={<RobotIcon size={20} aria-hidden />}
              title={
                <Link to={editorPath(b.id)} className="rounded-sm hover:underline focus-visible:-outline-offset-2">
                  {b.name}
                </Link>
              }
              badges={
                <span
                  title={b.publishedVersionId ? undefined : 'Publique uma versão no editor antes de ativar'}
                  className={`${badge} ${b.status === 'active' ? badgeTone.success : badgeTone.neutral}`}
                >
                  {statusLabel(b)}
                </span>
              }
              subtitle={
                <>
                  <span>{channelsLabel(b, channelNames)}</span> · <span className="tabular-nums">{runsLabel(b)}</span> ·{' '}
                  <span className="tabular-nums">
                    atualizado em {new Date(b.updatedAt).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })}
                  </span>
                  {b.description && <> · {b.description}</>}
                </>
              }
              actions={
                <RowMenu
                  label={`Opções do chatbot ${b.name}`}
                  items={[
                    { label: 'Editar', onSelect: () => navigate(editorPath(b.id)) },
                    {
                      label: b.status === 'active' ? 'Pausar' : 'Ativar',
                      onSelect: () => toggle(b),
                      disabled: save.isPending || (b.status === 'paused' && !b.publishedVersionId),
                    },
                    { label: 'Duplicar', onSelect: () => save.mutate(() => api.bots.duplicate(b.id)), disabled: save.isPending },
                    { label: 'Exportar', download: api.bots.exportUrl(b.id) },
                    { label: 'Excluir', onSelect: () => void remove(b), danger: true, disabled: save.isPending },
                  ]}
                />
              }
            />
          ))}
        </ul>
      )}
    </>
  );
}
