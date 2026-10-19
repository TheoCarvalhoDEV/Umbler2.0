import { useState, type ChangeEvent, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { BotDto, BotExport } from '@talk/shared';
import { Loading, Section, btn, btnPrimary, field, useSend } from '../../../components/settings/common';
import { api, ApiError, qk } from '../../../lib/api';
import { confirmDialog } from '../../../lib/confirm';
import { OfficeTemplateDialog } from './OfficeTemplateDialog';

const editorPath = (id: string) => `/configuracoes/chatbots/${id}`;

function statusLabel(b: BotDto): string {
  if (b.status === 'active') return 'Ativo';
  return b.publishedVersionId ? 'Pausado' : 'Rascunho';
}

function runsLabel(b: BotDto): string {
  return b.activeRunCount > 0 ? `${b.runCount} (${b.activeRunCount} em andamento)` : String(b.runCount);
}

function channelsLabel(b: BotDto, names: Map<string, string>): string {
  const list = b.startChannelIds.map((id) => names.get(id) ?? 'Canal removido');
  if (b.manualStart) list.push('Início manual');
  return list.join(', ') || '—';
}

/** Names from the DELETE 409 `{ usedBy: [{ id, name }] }`; [] for any other error. */
function usedByNames(e: unknown): string[] {
  if (!(e instanceof ApiError)) return [];
  const list = (e.data as { usedBy?: unknown } | null | undefined)?.usedBy;
  return Array.isArray(list) ? list.map((b) => String((b as { name?: unknown }).name ?? '')) : [];
}

/** Catches the wrong file only; the server validates the graph again (zod) and recomputes `valid`. */
async function readExport(file: Blob): Promise<BotExport> {
  let data: unknown;
  try {
    data = JSON.parse(await file.text());
  } catch {
    throw new Error('Arquivo inválido: não é um JSON.');
  }
  const d = data as Partial<BotExport> | null;
  if (!d || typeof d.name !== 'string' || !d.graph || !Array.isArray(d.graph.nodes) || !Array.isArray(d.graph.edges)) {
    throw new Error('Arquivo inválido: não é um chatbot exportado.');
  }
  return { name: d.name, graph: d.graph };
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

  function create(e: FormEvent) {
    e.preventDefault();
    save.mutate(async () => {
      const bot = await api.bots.create({ name: name.trim() });
      navigate(editorPath(bot.id));
    });
  }

  function importFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ''; // lets the same file be picked again
    if (file) save.mutate(async () => api.bots.importBot(await readExport(file)));
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
    <Section
      title="Chatbots"
      action={
        <div className="flex flex-wrap justify-end gap-2">
          <label className={`${btn} cursor-pointer`}>
            Importar
            <input type="file" accept=".json,application/json" onChange={importFile} className="sr-only" />
          </label>
          <button type="button" onClick={() => setTemplate(true)} className={btn}>
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
            Novo chatbot
          </button>
        </div>
      }
    >
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
        <form onSubmit={create} className="mb-4 flex items-end gap-2 rounded border border-border p-3">
          <label className="flex-1 text-sm">
            Nome do chatbot
            <input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} autoFocus className={field} />
          </label>
          <button type="submit" disabled={save.isPending || !name.trim()} className={btnPrimary}>
            Criar
          </button>
          <button type="button" onClick={() => setCreating(false)} className={btn}>
            Cancelar
          </button>
        </form>
      )}
      {save.error && (
        <div role="alert" className="my-2 text-sm text-danger">
          <p>{save.error.message}</p>
          {used.length > 0 && <p>Usado por: {used.join(', ')}</p>}
        </div>
      )}
      {bots.data.length === 0 ? (
        <p className="text-sm text-muted">Nenhum chatbot. Crie um novo, importe um arquivo ou comece pelo modelo do escritório.</p>
      ) : (
        <div className="overflow-x-auto rounded border border-border">
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-muted">
              <tr>
                <th className="px-3 py-2 font-medium">Nome</th>
                <th className="px-3 py-2 font-medium">Canais</th>
                <th className="px-3 py-2 font-medium">Situação</th>
                <th className="px-3 py-2 font-medium">Execuções</th>
                <th className="px-3 py-2 font-medium">Atualizado em</th>
                <th className="px-3 py-2">
                  <span className="sr-only">Ações</span>
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {bots.data.map((b) => (
                <tr key={b.id} className="align-top">
                  <td className="px-3 py-2">
                    <Link to={editorPath(b.id)} className="font-medium hover:underline">
                      {b.name}
                    </Link>
                    {b.description && <span className="block text-xs text-muted">{b.description}</span>}
                  </td>
                  <td className="px-3 py-2">{channelsLabel(b, channelNames)}</td>
                  <td className="px-3 py-2">{statusLabel(b)}</td>
                  <td className="px-3 py-2">{runsLabel(b)}</td>
                  <td className="whitespace-nowrap px-3 py-2">
                    {new Date(b.updatedAt).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })}
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex flex-wrap justify-end gap-1">
                      <Link to={editorPath(b.id)} className={btn}>
                        Editar
                      </Link>
                      <button
                        type="button"
                        disabled={save.isPending || (b.status === 'paused' && !b.publishedVersionId)}
                        title={b.publishedVersionId ? undefined : 'Publique uma versão no editor antes de ativar'}
                        onClick={() => toggle(b)}
                        className={btn}
                      >
                        {b.status === 'active' ? 'Pausar' : 'Ativar'}
                      </button>
                      <button
                        type="button"
                        disabled={save.isPending}
                        onClick={() => save.mutate(() => api.bots.duplicate(b.id))}
                        className={btn}
                      >
                        Duplicar
                      </button>
                      <a href={api.bots.exportUrl(b.id)} download className={btn}>
                        Exportar
                      </a>
                      <button type="button" disabled={save.isPending} onClick={() => remove(b)} className={btn}>
                        Excluir
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Section>
  );
}
