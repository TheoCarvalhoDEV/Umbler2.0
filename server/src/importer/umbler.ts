import { setTimeout as delay } from 'node:timers/promises';
import { tagColorHex } from '@talk/shared';
import { eq, TransactionRollbackError } from 'drizzle-orm';
import type { Db, Tx } from '../db/client.js';
import {
  contactFieldValues,
  contactTags,
  contacts,
  customFields,
  quickAnswers,
  sectors,
  tags,
} from '../db/schema.js';
import { saveMedia } from '../messages/media.js';
import { convertUmblerVariables } from '../messages/quick-answers.js';
import { lidFromJid, normalizePhoneBR } from '../whatsapp/phone.js';

export const UMBLER_API = 'https://app-utalk.umbler.com/api';
// ponytail: fixed spacing = the documented 100 req / 5 s; a token bucket only if imports get too slow.
const MIN_GAP_MS = 50;
const RETRY_AFTER_MS = 5_000;
const MAX_ATTEMPTS = 4;
const PAGE_SIZE = 50;

type FieldKind = 'text' | 'number' | 'date' | 'cpf' | 'cnpj';

// Umbler definition `_t` → our kind. Anything else (logic, lists, options, members, references,
// files, dictionaries) is listed in report.customFields.unsupported and its values are skipped.
const FIELD_KINDS: Record<string, FieldKind> = {
  TextCustomFieldDefinitionModel: 'text',
  LinkCustomFieldDefinitionModel: 'text',
  NumberCustomFieldDefinitionModel: 'number',
  DecimalCustomFieldDefinitionModel: 'number',
  CurrencyCustomFieldDefinitionModel: 'number',
  DateCustomFieldDefinitionModel: 'date',
  CPFCustomFieldDefinitionModel: 'cpf',
  CNPJCustomFieldDefinitionModel: 'cnpj',
};

// Only the fields we read from the Umbler public API (docs/umbler/utalk-openapi-v1.json).
interface UmblerMe { organizations?: Array<{ id: string; name: string }> }
interface UmblerSector { id: string; name: string; default: boolean; order: number }
interface UmblerTag { id: string; name: string; emoji?: string | null; color?: string | null; order: number }
interface UmblerFieldDef { _t: string; id: string; name: string }
interface UmblerContact {
  id: string;
  name?: string | null;
  phoneNumber?: string | null;
  lid?: string | null;
  email?: string | null;
  landline?: string | null;
  address?: Record<string, string | null> | null;
  isBlocked?: boolean;
  tags?: Array<{ id: string }>;
  customFields?: Array<{ customFieldDefinitionId: string; value?: unknown }>;
}
interface UmblerQuickAnswer {
  id: string;
  name: string;
  content?: string | null;
  variables?: Array<{ defaultValue?: string | null }>;
  attachment?: { url?: string | null; originalName?: string | null } | null;
}

export interface ImportDeps {
  db: Db;
  mediaDir: string;
  token: string;
  dryRun: boolean;
  fetchImpl?: typeof fetch;
  baseUrl?: string;
  sleep?: (ms: number) => Promise<unknown>;
}

export interface ImportCounts { created: number; existing: number }

export interface ImportReport {
  dryRun: boolean;
  organization: string;
  sectors: ImportCounts;
  tags: ImportCounts;
  customFields: ImportCounts & { unsupported: string[] };
  contacts: ImportCounts & { skippedInvalidPhone: Array<{ umblerId: string; name: string | null; phone: string | null }> };
  quickAnswers: ImportCounts & { attachments: number; attachmentErrors: string[] };
  unmappedVariables: Array<{ quickAnswer: string; variables: string[] }>;
}

type Query = Record<string, string | number | boolean | string[]>;
type UmblerGet = <T>(path: string, query: Query) => Promise<T>;

function umblerClient(deps: ImportDeps): UmblerGet {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const sleep = deps.sleep ?? delay;
  const base = deps.baseUrl ?? UMBLER_API;
  let last = 0;
  return async <T>(path: string, query: Query): Promise<T> => {
    const url = new URL(base + path);
    for (const [k, v] of Object.entries(query)) for (const x of [v].flat()) url.searchParams.append(k, String(x));
    for (let attempt = 1; ; attempt++) {
      const wait = last + MIN_GAP_MS - Date.now();
      if (wait > 0) await sleep(wait);
      last = Date.now();
      const res = await fetchImpl(url, { headers: { Authorization: `Bearer ${deps.token}`, Accept: 'application/json' } });
      if (res.status === 429 && attempt < MAX_ATTEMPTS) {
        await sleep(RETRY_AFTER_MS);
        continue;
      }
      if (!res.ok) throw new Error(`Umbler respondeu ${res.status} em GET ${path}`);
      return (await res.json()) as T;
    }
  };
}

// Skip/Take pagination; stops at the first empty page (does not trust maxTake/totalItems).
async function getAll<T>(get: UmblerGet, path: string, query: Query): Promise<T[]> {
  const items: T[] = [];
  for (;;) {
    const page = await get<{ items?: T[] }>(path, { ...query, Skip: items.length, Take: PAGE_SIZE });
    if (!page.items?.length) return items;
    items.push(...page.items);
  }
}

async function fetchUmbler(deps: ImportDeps) {
  const get = umblerClient(deps);
  const me = await get<UmblerMe>('/v1/members/me/', {});
  // ponytail: first organization of the token; the office has exactly one.
  const org = me.organizations?.[0];
  if (!org) throw new Error('O token do Umbler não pertence a nenhuma organização');
  const q: Query = { organizationId: org.id };

  const sectorList = await get<UmblerSector[]>('/v1/sectors/', q);
  const tagList = await getAll<UmblerTag>(get, '/v1/tags/', q);
  const fieldDefs = await get<UmblerFieldDef[]>('/v1/custom-field-definitions/', q);
  const contactList = await getAll<UmblerContact>(get, '/v1/contacts/', {
    ...q,
    includeGroups: false,
    includeCustomFields: fieldDefs.map((d) => d.id),
  });
  const qaList = await getAll<{ id: string }>(get, '/v1/quick-answers/', { ...q, viewFrom: 'Everyone' });
  const qaDetails: UmblerQuickAnswer[] = [];
  for (const { id } of qaList) qaDetails.push(await get<UmblerQuickAnswer>(`/v1/quick-answers/${encodeURIComponent(id)}/`, q));

  return { org, sectorList, tagList, fieldDefs, contactList, qaDetails };
}

const str = (v: string | null | undefined): string | null => v?.trim() || null;
const byOrder = <T extends { order: number }>(list: T[]): T[] => [...list].sort((a, b) => a.order - b.order);

function toAddress(a: Record<string, string | null> | null | undefined): Record<string, string> | null {
  const entries = Object.entries(a ?? {}).filter((e): e is [string, string] => typeof e[1] === 'string' && e[1].trim() !== '');
  return entries.length ? Object.fromEntries(entries) : null;
}

function fieldValue(v: unknown, kind: FieldKind): string | null {
  if (typeof v === 'number') return String(v);
  if (typeof v !== 'string' || !v.trim()) return null;
  return kind === 'date' ? v.trim().slice(0, 10) : v.trim();
}

async function importSectors(tx: Tx, list: UmblerSector[], r: ImportReport): Promise<void> {
  const rows = await tx.select().from(sectors);
  const names = new Set(rows.map((s) => s.name));
  let hasDefault = rows.some((s) => s.isDefault);
  for (const [i, s] of byOrder(list).entries()) {
    const name = s.name.trim();
    if (names.has(name)) {
      r.sectors.existing++;
      continue;
    }
    await tx.insert(sectors).values({ name, position: i, isDefault: s.default && !hasDefault });
    hasDefault ||= s.default;
    names.add(name);
    r.sectors.created++;
  }
}

// Returns Umbler tag id → our tag id.
async function importTags(tx: Tx, list: UmblerTag[], r: ImportReport): Promise<Map<string, string>> {
  const idByName = new Map((await tx.select({ id: tags.id, name: tags.name }).from(tags)).map((t) => [t.name, t.id]));
  const map = new Map<string, string>();
  for (const [i, t] of byOrder(list).entries()) {
    const name = t.name.trim().slice(0, 30); // tags.name is varchar(30)
    let id = idByName.get(name);
    if (id) {
      r.tags.existing++;
    } else {
      // Umbler TagColor name → hex of the shared palette (Task 15), so the tag matches a TagForm swatch.
      const color = tagColorHex(t.color ?? '');
      id = (await tx.insert(tags).values({ name, emoji: str(t.emoji), color, position: i }).returning({ id: tags.id }))[0].id;
      idByName.set(name, id);
      r.tags.created++;
    }
    map.set(t.id, id);
  }
  return map;
}

// Returns Umbler definition id → our field.
async function importFields(
  tx: Tx,
  list: UmblerFieldDef[],
  r: ImportReport,
): Promise<Map<string, { id: string; kind: FieldKind }>> {
  const rows = await tx.select({ id: customFields.id, name: customFields.name, kind: customFields.kind }).from(customFields);
  const byName = new Map(rows.map((f) => [f.name, { id: f.id, kind: f.kind }]));
  const map = new Map<string, { id: string; kind: FieldKind }>();
  for (const [i, d] of list.entries()) {
    const name = d.name.trim();
    const kind = FIELD_KINDS[d._t];
    if (!kind) {
      r.customFields.unsupported.push(name);
      continue;
    }
    let field = byName.get(name);
    if (field) {
      r.customFields.existing++;
    } else {
      field = (
        await tx
          .insert(customFields)
          .values({ name, kind, position: i })
          .returning({ id: customFields.id, kind: customFields.kind })
      )[0];
      byName.set(name, field);
      r.customFields.created++;
    }
    map.set(d.id, field);
  }
  return map;
}

async function importContacts(
  tx: Tx,
  list: UmblerContact[],
  tagIds: Map<string, string>,
  fields: Map<string, { id: string; kind: FieldKind }>,
  r: ImportReport,
): Promise<void> {
  for (const c of list) {
    const phone = normalizePhoneBR(c.phoneNumber ?? '');
    if (!/^\d{10,15}$/.test(phone)) {
      r.contacts.skippedInvalidPhone.push({ umblerId: c.id, name: c.name ?? null, phone: c.phoneNumber ?? null });
      continue;
    }
    const lid = c.lid ? (lidFromJid(c.lid) ?? (/^\d+$/.test(c.lid) ? c.lid : null)) : null;

    // Same matching order as the webhook (spec §5.1 step 4): phone first, then LID.
    const [byPhone] = await tx.select().from(contacts).where(eq(contacts.phone, phone));
    const [byLid] = lid ? await tx.select().from(contacts).where(eq(contacts.lid, lid)) : [];
    const found = byPhone ?? byLid;

    let contactId: string;
    if (found) {
      // Fill only what is empty: never overwrite data already edited in the new system.
      await tx
        .update(contacts)
        .set({
          name: found.name ?? str(c.name),
          phone: found.phone ?? phone,
          lid: found.lid ?? (byLid ? null : lid), // a LID owned by another contact is never copied
          email: found.email ?? str(c.email),
          landline: found.landline ?? str(c.landline),
          address: found.address ?? toAddress(c.address),
        })
        .where(eq(contacts.id, found.id));
      contactId = found.id;
      r.contacts.existing++;
    } else {
      const [row] = await tx
        .insert(contacts)
        .values({
          name: str(c.name),
          phone,
          lid,
          email: str(c.email),
          landline: str(c.landline),
          address: toAddress(c.address),
          blocked: c.isBlocked ?? false,
        })
        .returning({ id: contacts.id });
      contactId = row.id;
      r.contacts.created++;
    }

    const tagRows = (c.tags ?? []).flatMap((t) => {
      const tagId = tagIds.get(t.id);
      return tagId ? [{ contactId, tagId }] : [];
    });
    if (tagRows.length) await tx.insert(contactTags).values(tagRows).onConflictDoNothing();

    const valueRows = (c.customFields ?? []).flatMap((f) => {
      const field = fields.get(f.customFieldDefinitionId);
      const value = field ? fieldValue(f.value, field.kind) : null;
      return field && value !== null ? [{ contactId, fieldId: field.id, value }] : [];
    });
    if (valueRows.length) await tx.insert(contactFieldValues).values(valueRows).onConflictDoNothing();
  }
}

async function downloadAttachment(deps: ImportDeps, url: string, originalName: string | null): Promise<string> {
  // A storage link, not the Umbler API: no Authorization header, the token never leaves app-utalk.
  const res = await (deps.fetchImpl ?? fetch)(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const mime = res.headers.get('content-type')?.split(';')[0].trim() || 'application/octet-stream';
  const saved = await saveMedia(deps.mediaDir, Buffer.from(await res.arrayBuffer()), mime, originalName);
  return saved.path;
}

async function importQuickAnswers(tx: Tx, list: UmblerQuickAnswer[], deps: ImportDeps, r: ImportReport): Promise<void> {
  const names = new Set((await tx.select({ name: quickAnswers.name }).from(quickAnswers)).map((q) => q.name));
  for (const qa of list) {
    const name = qa.name.trim();
    if (names.has(name)) {
      r.quickAnswers.existing++;
      continue;
    }
    const { body, unmapped } = convertUmblerVariables(
      qa.content ?? '',
      (qa.variables ?? []).map((v) => ({ defaultValue: v.defaultValue ?? '' })),
    );
    if (unmapped.length) r.unmappedVariables.push({ quickAnswer: name, variables: unmapped });

    let attachmentPath: string | null = null;
    const url = qa.attachment?.url;
    if (url) {
      r.quickAnswers.attachments++;
      if (!deps.dryRun) {
        // ponytail: a file saved before a failed commit stays orphaned in mediaDir; harmless for a one-off import.
        attachmentPath = await downloadAttachment(deps, url, qa.attachment?.originalName ?? null).catch(() => {
          r.quickAnswers.attachmentErrors.push(name);
          return null;
        });
      }
    }
    // ponytail: imported answers are shared ('all'); Umbler members are not users here, so the owner
    // of an "Apenas para mim" answer cannot be mapped. The admin adjusts visibility afterwards.
    await tx.insert(quickAnswers).values({ name, body, attachmentPath, visibility: 'all', ownerId: null });
    names.add(name);
    r.quickAnswers.created++;
  }
}

export async function importUmbler(deps: ImportDeps): Promise<ImportReport> {
  const data = await fetchUmbler(deps); // phase 1: read everything, touch nothing

  const counts = (): ImportCounts => ({ created: 0, existing: 0 });
  const report: ImportReport = {
    dryRun: deps.dryRun,
    organization: data.org.name,
    sectors: counts(),
    tags: counts(),
    customFields: { ...counts(), unsupported: [] },
    contacts: { ...counts(), skippedInvalidPhone: [] },
    quickAnswers: { ...counts(), attachments: 0, attachmentErrors: [] },
    unmappedVariables: [],
  };

  // Phase 2: one transaction. Dry-run takes the same path and rolls back, so its counts are exact.
  try {
    await deps.db.transaction(async (tx) => {
      await importSectors(tx, data.sectorList, report);
      const tagIds = await importTags(tx, data.tagList, report);
      const fields = await importFields(tx, data.fieldDefs, report);
      await importContacts(tx, data.contactList, tagIds, fields, report);
      await importQuickAnswers(tx, data.qaDetails, deps, report);
      if (deps.dryRun) tx.rollback();
    });
  } catch (err) {
    if (!(err instanceof TransactionRollbackError)) throw err;
  }
  return report;
}
