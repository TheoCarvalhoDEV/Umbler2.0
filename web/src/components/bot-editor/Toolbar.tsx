import { useEffect, useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import {
  ArrowClockwiseIcon,
  ArrowCounterClockwiseIcon,
  ArrowLeftIcon,
  ClockCounterClockwiseIcon,
  DownloadSimpleIcon,
  SquaresFourIcon,
  TreeStructureIcon,
} from '@phosphor-icons/react';
import type { BotDto } from '@talk/shared';
import { badge, badgeTone, button, iconButton, iconButtonGhost, iconButtonOn } from '../ui';

export interface ToolbarProps {
  name: string;
  onRename(name: string): void;
  status: BotDto['status'];
  publishedVersionNumber: number | null;
  onToggleStatus(): void;
  canUndo: boolean;
  canRedo: boolean;
  onUndo(): void;
  onRedo(): void;
  onLayout(): void;
  onSave(publish: boolean): void;
  busy: boolean;
  dirty: boolean;
  readOnly: boolean;
  exportUrl: string;
  paletteOpen: boolean;
  onTogglePalette(): void;
  versionsOpen: boolean;
  onToggleVersions(): void;
}

function IconButton(props: { label: string; onClick(): void; disabled?: boolean; pressed?: boolean; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-label={props.label}
      title={props.label}
      aria-pressed={props.pressed}
      disabled={props.disabled}
      onClick={props.onClick}
      className={props.pressed ? iconButtonOn : iconButtonGhost}
    >
      {props.children}
    </button>
  );
}

function NameInput({ name, disabled, onRename }: { name: string; disabled: boolean; onRename(name: string): void }) {
  const [value, setValue] = useState(name);
  useEffect(() => setValue(name), [name]);
  function commit() {
    const v = value.trim();
    if (v && v !== name) onRename(v);
    else setValue(name);
  }
  return (
    <input
      aria-label="Nome do chatbot"
      value={value}
      maxLength={80}
      disabled={disabled}
      onChange={(e) => setValue(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur();
      }}
      className="h-10 w-64 min-w-0 rounded-block border border-transparent bg-transparent px-3 text-base font-bold text-fg hover:border-field focus:border-field disabled:opacity-60"
    />
  );
}

export function Toolbar(p: ToolbarProps) {
  const active = p.status === 'active';
  return (
    <header className="flex flex-wrap items-center gap-2 rounded-card bg-surface px-3 py-2.5">
      <Link to="/configuracoes/chatbots" aria-label="Voltar para a lista de chatbots" title="Voltar" className={iconButton}>
        <ArrowLeftIcon size={20} />
      </Link>
      <NameInput name={p.name} disabled={p.readOnly} onRename={p.onRename} />
      <span className={`${badge} ${active ? badgeTone.success : badgeTone.neutral}`}>{active ? 'Ativo' : 'Pausado'}</span>
      <span className="text-[13px] text-muted">
        {p.publishedVersionNumber ? `Publicada: versão ${p.publishedVersionNumber}` : 'Nenhuma versão publicada'}
      </span>
      {p.dirty && <span className={`${badge} ${badgeTone.warning}`}>Alterações não salvas</span>}
      <div className="ml-auto flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-0.5">
          <IconButton label="Paleta de blocos (Tab)" pressed={p.paletteOpen} disabled={p.readOnly} onClick={p.onTogglePalette}>
            <SquaresFourIcon size={20} />
          </IconButton>
          <IconButton label="Desfazer" disabled={!p.canUndo} onClick={p.onUndo}>
            <ArrowCounterClockwiseIcon size={20} />
          </IconButton>
          <IconButton label="Refazer" disabled={!p.canRedo} onClick={p.onRedo}>
            <ArrowClockwiseIcon size={20} />
          </IconButton>
          <IconButton label="Auto-organizar" disabled={p.readOnly} onClick={p.onLayout}>
            <TreeStructureIcon size={20} />
          </IconButton>
          <IconButton label="Versões" pressed={p.versionsOpen} onClick={p.onToggleVersions}>
            <ClockCounterClockwiseIcon size={20} />
          </IconButton>
        </div>
        <a href={p.exportUrl} download title="Baixa a última versão salva" className={button()}>
          <DownloadSimpleIcon size={16} aria-hidden />
          Exportar
        </a>
        <button type="button" className={button()} disabled={p.busy} onClick={p.onToggleStatus}>
          {active ? 'Pausar' : 'Ativar'}
        </button>
        <button type="button" className={button()} disabled={p.busy || p.readOnly} onClick={() => p.onSave(false)}>
          Salvar rascunho
        </button>
        <button type="button" className={button('primary')} disabled={p.busy || p.readOnly} onClick={() => p.onSave(true)}>
          Salvar e publicar
        </button>
      </div>
    </header>
  );
}
