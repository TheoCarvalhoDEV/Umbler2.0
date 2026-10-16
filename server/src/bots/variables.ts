// Chatbot spec 2a §5.3: bot texts use the quick-answer variables plus {{contexto.<name>}} / {{contexto.<name>:raw}}.
import type { BotRunVars } from '@talk/shared';
import type { Db, Tx } from '../db/client.js';
import type { ChatRow } from '../inbox/chats.js';
import { loadAuthUser } from '../inbox/visibility.js';
import { buildChatVars, renderQuickAnswer, type QuickAnswerVars } from '../messages/quick-answers.js';

export interface BotTextVars extends QuickAnswerVars {
  contexto: Record<string, string>;
}

/** For each var: name → value, `${name}:raw` → raw, `${name}:label` → label ?? '' (renderQuickAnswer slugs `cpf:raw` → `cpf_raw`). */
export function contextoVars(vars: BotRunVars): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, v] of Object.entries(vars)) {
    out[`${name}:raw`] = v.raw;
    out[`${name}:label`] = v.label ?? '';
  }
  // ponytail: plain names go last so a node really named "cpf_raw" wins the slug collision with "cpf:raw";
  // {{contexto.cpf:raw}} then shows that node's value. Rename one node if that ever matters.
  for (const [name, v] of Object.entries(vars)) out[name] = v.value;
  return out;
}

/** atendente = the chat owner (loadAuthUser: null when inactive), or empty when there is none. */
export async function loadBotTextVars(db: Db | Tx, chat: ChatRow, runVars: BotRunVars): Promise<BotTextVars> {
  const atendente = chat.ownerId ? await loadAuthUser(db, chat.ownerId) : null;
  return { ...(await buildChatVars(db, chat, atendente)), contexto: contextoVars(runVars) };
}

export function renderBotText(text: string, vars: BotTextVars): string {
  return renderQuickAnswer(text, vars);
}
