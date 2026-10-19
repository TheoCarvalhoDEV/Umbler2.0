import { and, desc, eq, ilike, inArray, like, ne, or, sql, type SQL } from 'drizzle-orm';
import type { ChatListItem, ContactDto, ContactNoteDto } from '@talk/shared';
import type { AppCtx } from '../ctx.js';
import type { Db, Tx } from '../db/client.js';
import { chats, contactFieldValues, contactNotes, contactTags, contacts, customFields, tags, users } from '../db/schema.js';
import { toChatListItem } from '../inbox/queries.js';
import { avatarUrl } from './avatar.js';
import { visibleChatsWhere, type AuthUser } from '../inbox/visibility.js';
import { badRequest, conflict, notFound } from '../lib/http-error.js';
import { normalizePhoneBR } from '../whatsapp/phone.js';
type ContactRow = typeof contacts.$inferSelect;

export interface ContactInput {
  name?: string | null;
  phone?: string;
  email?: string | null;
  landline?: string | null;
  address?: Record<string, string> | null;
}
export interface ContactListQuery { q?: string; tagId?: string; cursor?: string; limit?: number }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function cleanPhone(raw: string): string {
  const phone = normalizePhoneBR(raw);
  if (!/^\d{10,15}$/.test(phone)) throw badRequest('Telefone inválido');
  return phone;
}

export async function toContactDtos(db: Db | Tx, rows: ContactRow[]): Promise<ContactDto[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const tagRows = await db.select().from(contactTags).where(inArray(contactTags.contactId, ids));
  const fieldRows = await db.select().from(contactFieldValues).where(inArray(contactFieldValues.contactId, ids));
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    phone: r.phone,
    lid: r.lid,
    email: r.email,
    landline: r.landline,
    address: (r.address as Record<string, string> | null) ?? null,
    blocked: r.blocked,
    tagIds: tagRows.filter((t) => t.contactId === r.id).map((t) => t.tagId),
    fields: Object.fromEntries(fieldRows.filter((f) => f.contactId === r.id).map((f) => [f.fieldId, f.value])),
    createdAt: r.createdAt.toISOString(),
    avatarUrl: avatarUrl(r),
  }));
}

export async function getContact(db: Db | Tx, id: string): Promise<ContactDto> {
  const [row] = await db.select().from(contacts).where(eq(contacts.id, id));
  if (!row) throw notFound('Contato não encontrado');
  const [dto] = await toContactDtos(db, [row]);
  return dto;
}

const CURSOR_ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

// Postgres keeps microseconds but the cursor carries a JS Date (milliseconds): order and
// compare on the truncated value so pages never skip or repeat rows.
const updatedMs = sql`date_trunc('milliseconds', ${contacts.updatedAt})`;

export async function listContacts(db: Db, f: ContactListQuery): Promise<{ items: ContactDto[]; nextCursor: string | null }> {
  const limit = f.limit ?? 50;
  const where: Array<SQL | undefined> = [];
  const q = f.q?.trim();
  if (q) {
    const byName = ilike(contacts.name, `%${q.replace(/[\\%_]/g, '\\$&')}%`);
    const digits = q.replace(/\D/g, '');
    // ponytail: "contains" on the normalized number covers prefix search and partial typing like "99999-0002".
    const phone = digits.length >= 10 ? normalizePhoneBR(digits) : digits;
    where.push(digits.length >= 3 ? or(byName, like(contacts.phone, `%${phone}%`)) : byName);
  }
  if (f.tagId) {
    where.push(
      inArray(contacts.id, db.select({ id: contactTags.contactId }).from(contactTags).where(eq(contactTags.tagId, f.tagId))),
    );
  }
  if (f.cursor) {
    const [iso, id] = Buffer.from(f.cursor, 'base64url').toString().split('|');
    // Only the toISOString() shape this function emits: Date.parse also takes "1", which Postgres rejects (500).
    if (!iso || !id || !UUID.test(id) || !CURSOR_ISO.test(iso)) throw badRequest('Cursor inválido');
    where.push(sql`(${updatedMs}, ${contacts.id}) < (${iso}::timestamptz, ${id}::uuid)`);
  }
  const rows = await db
    .select()
    .from(contacts)
    .where(and(...where))
    .orderBy(desc(updatedMs), desc(contacts.id))
    .limit(limit + 1);
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  return {
    items: await toContactDtos(db, page),
    nextCursor:
      rows.length > limit && last ? Buffer.from(`${last.updatedAt.toISOString()}|${last.id}`).toString('base64url') : null,
  };
}

// Bumps updated_at (list order) and applies `extra`; 404 when the contact does not exist.
async function touch(db: Db | Tx, id: string, extra: Partial<typeof contacts.$inferInsert> = {}): Promise<void> {
  const [row] = await db
    .update(contacts)
    .set({ ...extra, updatedAt: new Date() })
    .where(eq(contacts.id, id))
    .returning({ id: contacts.id });
  if (!row) throw notFound('Contato não encontrado');
}

// ChatListItem embeds the contact name, tagIds and avatarUrl, so open chats are re-sent to the inboxes.
export async function publishOpenChats(ctx: AppCtx, contactId: string): Promise<void> {
  const open = await ctx.db
    .select({ id: chats.id })
    .from(chats)
    .where(and(eq(chats.contactId, contactId), eq(chats.state, 'open')));
  for (const c of open) await ctx.hub.publishChat(c.id);
}

export async function createContact(ctx: AppCtx, input: ContactInput & { phone: string }): Promise<ContactDto> {
  const now = new Date();
  const [row] = await ctx.db
    .insert(contacts)
    .values({
      id: crypto.randomUUID(),
      name: input.name ?? null,
      phone: cleanPhone(input.phone),
      email: input.email ?? null,
      landline: input.landline ?? null,
      address: input.address ?? null,
      blocked: false,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing()
    .returning();
  if (!row) throw conflict('Já existe um contato com este telefone');
  const [dto] = await toContactDtos(ctx.db, [row]);
  return dto;
}

export async function updateContact(ctx: AppCtx, id: string, p: ContactInput): Promise<ContactDto> {
  const phone = p.phone === undefined ? undefined : cleanPhone(p.phone);
  if (phone && (await ctx.db.$count(contacts, and(eq(contacts.phone, phone), ne(contacts.id, id))))) {
    throw conflict('Já existe um contato com este telefone');
  }
  await touch(ctx.db, id, { name: p.name, phone, email: p.email, landline: p.landline, address: p.address });
  await publishOpenChats(ctx, id);
  return getContact(ctx.db, id);
}

export async function setContactBlocked(ctx: AppCtx, id: string, blocked: boolean): Promise<ContactDto> {
  await touch(ctx.db, id, { blocked });
  return getContact(ctx.db, id);
}

export async function setContactTags(ctx: AppCtx, id: string, tagIds: string[]): Promise<ContactDto> {
  const unique = [...new Set(tagIds)];
  await ctx.db.transaction(async (tx) => {
    await touch(tx, id);
    if (unique.length && (await tx.$count(tags, inArray(tags.id, unique))) !== unique.length) {
      throw badRequest('Etiqueta inexistente');
    }
    await tx.delete(contactTags).where(eq(contactTags.contactId, id));
    if (unique.length) await tx.insert(contactTags).values(unique.map((tagId) => ({ contactId: id, tagId })));
  });
  await publishOpenChats(ctx, id);
  return getContact(ctx.db, id);
}

// Merge semantics: only the given fields change; an empty value removes the field.
// ponytail: values are free text; kind-specific validation (cpf/cnpj/date) is left to the UI mask.
export async function setContactFields(ctx: AppCtx, id: string, values: Record<string, string>): Promise<ContactDto> {
  const fieldIds = Object.keys(values);
  await ctx.db.transaction(async (tx) => {
    await touch(tx, id);
    if (fieldIds.length && (await tx.$count(customFields, inArray(customFields.id, fieldIds))) !== fieldIds.length) {
      throw badRequest('Campo inexistente');
    }
    for (const [fieldId, raw] of Object.entries(values)) {
      const value = raw.trim();
      if (!value) {
        await tx
          .delete(contactFieldValues)
          .where(and(eq(contactFieldValues.contactId, id), eq(contactFieldValues.fieldId, fieldId)));
      } else {
        await tx
          .insert(contactFieldValues)
          .values({ contactId: id, fieldId, value })
          .onConflictDoUpdate({ target: [contactFieldValues.contactId, contactFieldValues.fieldId], set: { value } });
      }
    }
  });
  return getContact(ctx.db, id);
}

export async function listContactChats(ctx: AppCtx, user: AuthUser, id: string): Promise<ChatListItem[]> {
  if (!(await ctx.db.$count(contacts, eq(contacts.id, id)))) throw notFound('Contato não encontrado');
  // Spec §6: the history hides chats the user cannot see (same rule as the inbox).
  const rows = await ctx.db
    .select()
    .from(chats)
    .where(and(eq(chats.contactId, id), visibleChatsWhere(user)))
    .orderBy(desc(chats.createdAt));
  return Promise.all(rows.map((chat) => toChatListItem(ctx.db, chat, user.id)));
}

const noteColumns = {
  id: contactNotes.id,
  body: contactNotes.body,
  pinned: contactNotes.pinned,
  authorName: users.name,
  createdAt: contactNotes.createdAt,
};

function noteQuery(db: Db | Tx, where: SQL | undefined) {
  return db
    .select(noteColumns)
    .from(contactNotes)
    .leftJoin(users, eq(users.id, contactNotes.authorId))
    .where(where)
    .orderBy(desc(contactNotes.pinned), desc(contactNotes.createdAt));
}

const toNoteDto = (r: { id: string; body: string; pinned: boolean; authorName: string | null; createdAt: Date }): ContactNoteDto => ({
  ...r,
  createdAt: r.createdAt.toISOString(),
});

export async function listContactNotes(db: Db | Tx, contactId: string): Promise<ContactNoteDto[]> {
  return (await noteQuery(db, eq(contactNotes.contactId, contactId))).map(toNoteDto);
}

async function getNote(db: Db | Tx, contactId: string, noteId: string): Promise<ContactNoteDto> {
  const [row] = await noteQuery(db, and(eq(contactNotes.contactId, contactId), eq(contactNotes.id, noteId)));
  if (!row) throw notFound('Observação não encontrada');
  return toNoteDto(row);
}

export async function createContactNote(ctx: AppCtx, user: AuthUser, contactId: string, body: string): Promise<ContactNoteDto> {
  if (!(await ctx.db.$count(contacts, eq(contacts.id, contactId)))) throw notFound('Contato não encontrado');
  const id = crypto.randomUUID();
  await ctx.db.insert(contactNotes).values({ id, contactId, authorId: user.id, body, pinned: false, createdAt: new Date() });
  return getNote(ctx.db, contactId, id);
}

// ponytail: any user may edit/pin/delete any note (spec has no note ownership rule); add an author check if asked.
export async function updateContactNote(
  ctx: AppCtx,
  contactId: string,
  noteId: string,
  patch: { body?: string; pinned?: boolean },
): Promise<ContactNoteDto> {
  const [row] = await ctx.db
    .update(contactNotes)
    .set(patch)
    .where(and(eq(contactNotes.id, noteId), eq(contactNotes.contactId, contactId)))
    .returning({ id: contactNotes.id });
  if (!row) throw notFound('Observação não encontrada');
  return getNote(ctx.db, contactId, noteId);
}

export async function deleteContactNote(ctx: AppCtx, contactId: string, noteId: string): Promise<void> {
  const deleted = await ctx.db
    .delete(contactNotes)
    .where(and(eq(contactNotes.id, noteId), eq(contactNotes.contactId, contactId)))
    .returning({ id: contactNotes.id });
  if (deleted.length === 0) throw notFound('Observação não encontrada');
}
