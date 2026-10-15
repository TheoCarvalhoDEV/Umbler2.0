import type { JSX } from 'react';
import { catalogEntry, type BotDto, type BotNode, type BotPatch } from '@talk/shared';
import type { EditorCatalog } from '../useEditorCatalog';

export interface BlockCardProps {
  node: BotNode;
  catalog: EditorCatalog;
  bot: BotDto; // with the editor's pending BotPatch applied
  problems: string[];
  onChange(config: Record<string, unknown>): void;
  onBotChange(patch: BotPatch): void;
}

/** Task 15 replaces this body with a switch on node.type. Until then every block only shows its description. */
export function BlockConfigCard({ node }: BlockCardProps): JSX.Element {
  return <p className="text-xs text-muted">{catalogEntry(node.type).description}</p>;
}
