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
import { btn, btnPrimary } from '../settings/common';

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
      className={`rounded p-1.5 text-muted hover:bg-sidebar-hover hover:text-fg disabled:opacity-40 ${props.pressed ? 'bg-sidebar-active text-fg' : ''}`}
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
      className="w-64 rounded border border-transparent bg-transparent px-2 py-1 text-sm font-semibold hover:border-border focus:border-border"
    />
  );
}

export function Toolbar(p: ToolbarProps) {
  const active = p.status === 'active';
  return (
    <header className="flex flex-wrap items-center gap-2 border-b border-border bg-panel px-3 py-2">
      <Link
        to="/configuracoes/chatbots"
        aria-label="Voltar para a lista de chatbots"
        title="Voltar"
        className="rounded p-1.5 text-muted hover:bg-sidebar-hover hover:text-fg"
      >
        <ArrowLeftIcon size={18} />
      </Link>
      <NameInput name={p.name} disabled={p.readOnly} onRename={p.onRename} />
      <span className={`rounded px-2 py-0.5 text-xs ${active ? 'bg-success/20 text-success' : 'bg-border text-muted'}`}>
        {active ? 'Ativo' : 'Pausado'}
      </span>
      <span className="text-xs text-muted">
        {p.publishedVersionNumber ? `Publicada: versão ${p.publishedVersionNumber}` : 'Nenhuma versão publicada'}
      </span>
      {p.dirty && <span className="text-xs text-amber-400">Alterações não salvas</span>}
      <div className="ml-auto flex flex-wrap items-center gap-1">
        <IconButton label="Paleta de blocos (Tab)" pressed={p.paletteOpen} disabled={p.readOnly} onClick={p.onTogglePalette}>
          <SquaresFourIcon size={18} />
        </IconButton>
        <IconButton label="Desfazer" disabled={!p.canUndo} onClick={p.onUndo}>
          <ArrowCounterClockwiseIcon size={18} />
        </IconButton>
        <IconButton label="Refazer" disabled={!p.canRedo} onClick={p.onRedo}>
          <ArrowClockwiseIcon size={18} />
        </IconButton>
        <IconButton label="Auto-organizar" disabled={p.readOnly} onClick={p.onLayout}>
          <TreeStructureIcon size={18} />
        </IconButton>
        <IconButton label="Versões" pressed={p.versionsOpen} onClick={p.onToggleVersions}>
          <ClockCounterClockwiseIcon size={18} />
        </IconButton>
        <a href={p.exportUrl} download title="Baixa a última versão salva" className={`${btn} inline-flex items-center gap-1`}>
          <DownloadSimpleIcon size={16} aria-hidden />
          Exportar
        </a>
        <button type="button" className={btn} disabled={p.busy} onClick={p.onToggleStatus}>
          {active ? 'Pausar' : 'Ativar'}
        </button>
        <button type="button" className={btn} disabled={p.busy || p.readOnly} onClick={() => p.onSave(false)}>
          Salvar rascunho
        </button>
        <button type="button" className={btnPrimary} disabled={p.busy || p.readOnly} onClick={() => p.onSave(true)}>
          Salvar e publicar
        </button>
      </div>
    </header>
  );
}
