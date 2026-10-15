import { posix } from 'node:path';
import { eq } from 'drizzle-orm';
import type { BotAttachment, EditTagsConfig, NoteConfig, SendMessageConfig, SetContactFieldConfig } from '@talk/shared';
import { setContactFields, setContactTags, updateContact, type ContactInput } from '../../contacts/service.js';
import { contactTags, contacts } from '../../db/schema.js';
import { addEvent } from '../../inbox/events.js';
import { HttpError } from '../../lib/http-error.js';
import { sendSystemMessage, type SystemSendInput } from '../../messages/send.js';
import type { BotRunRow } from '../repo.js';
import { BlockError } from '../block-error.js';
import type { BlockDefinition, BlockRegistry, BotCtx } from '../registry.js';

// Action blocks (spec §4 "Ação"). Blocks never write bot_runs: they mutate run.vars / run.retries and return a BlockResult.
// BlockError comes from block-error.ts, not registry.ts: registry.ts imports this module at load time, so a value import back from it would hit a TDZ error.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The contact services throw HttpError with safe pt-BR text ('Campo inexistente', 'Etiqueta inexistente', 'Telefone inválido'). */
async function asBlockError<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof HttpError) throw new BlockError(err.message);
    throw err;
  }
}

/** System send tagged with the run; publishes the chat (new preview); throws when WhatsApp did not take it. */
async function send(ctx: BotCtx, run: BotRunRow, input: Omit<SystemSendInput, 'botRunId'>): Promise<void> {
  const res = await sendSystemMessage(ctx.app, ctx.chat, { ...input, botRunId: run.id });
  if (res.messageId) await ctx.app.hub.publishChat(ctx.chat.id);
  if (!res.ok) throw new BlockError('Não foi possível enviar a mensagem');
}

/** Bot media library only: a relative path that stays under bots/ (no traversal, no Windows separators). */
function libraryFile(a: BotAttachment): BotAttachment {
  const path = posix.normalize(a.path);
  if (/[\\\0]/.test(a.path) || !path.startsWith('bots/')) throw new BlockError('Arquivo do chatbot inválido');
  return { ...a, path };
}

/** Writes a custom field (by id) or a NativeFieldId; an empty value clears it. city/state live in contacts.address. */
async function saveContactField(ctx: BotCtx, fieldId: string, value: string): Promise<void> {
  const contactId = ctx.chat.contactId;
  const v = value.trim();
  const native: ContactInput | null =
    fieldId === 'native:name' ? { name: v || null }
    : fieldId === 'native:email' ? { email: v || null }
    : fieldId === 'native:landline' ? { landline: v || null }
    : null;
  if (native) {
    await asBlockError(() => updateContact(ctx.app, contactId, native));
    return;
  }
  if (fieldId === 'native:city' || fieldId === 'native:state') {
    const key = fieldId === 'native:city' ? 'city' : 'state';
    const [row] = await ctx.app.db.select({ address: contacts.address }).from(contacts).where(eq(contacts.id, contactId));
    const address: Record<string, string> = { ...(row?.address ?? {}) };
    if (v) address[key] = v;
    else delete address[key];
    await asBlockError(() => updateContact(ctx.app, contactId, { address }));
    return;
  }
  if (!UUID_RE.test(fieldId)) throw new BlockError('Campo inexistente');
  await asBlockError(() => setContactFields(ctx.app, contactId, { [fieldId]: v }));
}

const sendMessage: BlockDefinition = {
  type: 'send_message',
  async run(ctx, run, node) {
    const cfg = node.config as unknown as SendMessageConfig;
    const text = (await ctx.render(cfg.text ?? '')).trim();
    const attachment = cfg.attachment ? libraryFile(cfg.attachment) : null;
    if (!text && !attachment) throw new BlockError('Mensagem vazia');
    await send(ctx, run, { text: text || undefined, attachment });
    return { next: 'next' };
  },
};

const note: BlockDefinition = {
  type: 'note',
  async run(ctx, _run, node) {
    const cfg = node.config as unknown as NoteConfig;
    const text = await ctx.render(cfg.text ?? '');
    const { botId, botName, runId } = ctx.actor;
    await addEvent(ctx.app.db, ctx.chat.id, 'bot_note', { botId, botName, runId, text }, null);
    await ctx.app.hub.publishChat(ctx.chat.id);
    return { next: 'next' };
  },
};

const setContactField: BlockDefinition = {
  type: 'set_contact_field',
  async run(ctx, _run, node) {
    const cfg = node.config as unknown as SetContactFieldConfig;
    await saveContactField(ctx, cfg.fieldId ?? '', await ctx.render(cfg.value ?? ''));
    return { next: 'next' };
  },
};

const editTags: BlockDefinition = {
  type: 'edit_tags',
  async run(ctx, _run, node) {
    const cfg = node.config as unknown as EditTagsConfig;
    const add = cfg.add ?? [];
    if (add.some((id) => !UUID_RE.test(id))) throw new BlockError('Etiqueta inexistente');
    const remove = new Set(cfg.remove ?? []);
    const current = await ctx.app.db
      .select({ tagId: contactTags.tagId })
      .from(contactTags)
      .where(eq(contactTags.contactId, ctx.chat.contactId));
    const next = [...new Set([...current.map((r) => r.tagId), ...add])].filter((id) => !remove.has(id));
    // setContactTags replaces the whole set, so pass the merged list; it rejects unknown tags with 'Etiqueta inexistente'.
    await asBlockError(() => setContactTags(ctx.app, ctx.chat.contactId, next));
    return { next: 'next' };
  },
};

export const actionBlocks: BlockRegistry = {
  send_message: sendMessage,
  note,
  set_contact_field: setContactField,
  edit_tags: editTags,
};
