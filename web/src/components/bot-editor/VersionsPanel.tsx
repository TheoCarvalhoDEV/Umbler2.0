import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { BotGraph, BotVersionDto } from '@talk/shared';
import { api, qk } from '../../lib/api';
import { btn, Loading } from '../settings/common';
import { badge, badgeTone, fieldError, sectionTitle } from '../ui';
import { errorMessage } from '../conversation/model';

export interface VersionsPanelProps {
  botId: string;
  onRestore(graph: BotGraph, number: number): void;
  onView?(version: BotVersionDto): void;
}

const when = (iso: string) => new Date(iso).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });

export function VersionsPanel({ botId, onRestore, onView }: VersionsPanelProps) {
  const qc = useQueryClient();
  const list = useQuery({ queryKey: qk.botVersions(botId), queryFn: () => api.bots.versions(botId) });
  const [loading, setLoading] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function open(n: number, then: (v: BotVersionDto) => void) {
    setLoading(n);
    setError(null);
    try {
      // versions are immutable, so the cached copy never goes stale
      then(await qc.fetchQuery({ queryKey: qk.botVersion(botId, n), queryFn: () => api.bots.version(botId, n), staleTime: Infinity }));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setLoading(null);
    }
  }

  return (
    <section aria-label="Versões" className="border-t border-border p-4 first:border-t-0">
      <h2 className={`mb-3 ${sectionTitle}`}>Versões</h2>
      {!list.data ? (
        <Loading error={list.error} />
      ) : (
        <ul className="space-y-2">
          {list.data.map((v) => (
            <li key={v.id} className="rounded-item bg-sunken p-3 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-bold">Versão {v.number}</span>
                {v.published && <span className={`${badge} ${badgeTone.success}`}>Publicada</span>}
                {!v.valid && <span className={`${badge} ${badgeTone.danger}`}>Com problemas</span>}
              </div>
              <p className="mt-1 text-[13px] leading-[18px] text-muted">
                {when(v.createdAt)} · {v.createdByName ?? 'Sistema'}
                {v.label ? ` · ${v.label}` : ''}
              </p>
              <div className="mt-2.5 flex flex-wrap gap-1.5">
                {onView && (
                  <button type="button" className={btn} disabled={loading !== null} onClick={() => void open(v.number, onView)}>
                    Visualizar
                  </button>
                )}
                <button
                  type="button"
                  className={btn}
                  disabled={loading !== null}
                  onClick={() => void open(v.number, (full) => onRestore(full.graph, full.number))}
                >
                  Restaurar como rascunho
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
      {error && (
        <p role="alert" className={fieldError}>
          {error}
        </p>
      )}
    </section>
  );
}
