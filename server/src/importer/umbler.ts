import { setTimeout as delay } from 'node:timers/promises';
import { tagColorHex, type UmblerImportError } from '@talk/shared';
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
import { baseMime, saveMedia } from '../messages/media.js';
import { convertUmblerVariables } from '../messages/quick-answers.js';
import { lidFromJid, normalizePhoneBR } from '../whatsapp/phone.js';

export const UMBLER_API = 'https://app-utalk.umbler.com/api';
/** §9.4: one call at a time, at least 100 ms apart (10/s, half the documented 100 GET per 5 s). */
const MIN_GAP_MS = 100;
const CALL_TIMEOUT_MS = 30_000;
/** §9.4 429: Retry-After when it comes, else these waits; the 8th refusal stops. */
const WAITS_429_S = [5, 10, 20, 40, 60, 60, 60];
/** §9.4 5xx, network error, timeout: one more try after each wait, then stop. */
const WAITS_DOWN_MS = [2_000, 10_000, 30_000];
/** §7.8 file links: one more try after each wait; 60 s per try; at most 64 MB (the send limit). */
const FILE_WAITS_MS = [1_000, 5_000, 25_000];
const FILE_TIMEOUT_MS = 60_000;
export const FILE_MAX_BYTES = 64 * 1024 * 1024;
export const PAGE_SIZE = 50;

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

/** A stop of §9.4. `route` is the template ("/v1/chats/{chatId}/relative-messages/"): never an id, a value or the token. */
export class UmblerError extends Error {
  constructor(
    public code: UmblerImportError,
    public status: number | null = null,
    public route: string | null = null,
  ) {
    super(route ? `GET ${route} → ${status ?? 'sem resposta'}` : code);
    this.name = 'UmblerError';
  }
}

/** §9.4: a note or chat deleted in Umbler during the copy is skipped (and counted) by the one-item callers. */
export const isGone = (err: unknown): boolean => err instanceof UmblerError && err.status === 404;

export type Query = Record<string, string | number | boolean | string[]>;
/** A downloaded file, or why not: 'gone' (403/404/410, too big) never comes back; 'temporary' failed every try. */
export type UmblerFile = { data: Buffer; mime: string } | { failed: 'gone' | 'temporary' };

export interface UmblerClient {
  /** GET only: there is no method parameter (§3). `route` is a template whose {names} come from `params`. */
  get<T>(route: string, query?: Query, params?: Record<string, string>): Promise<T>;
  /** A file link (S3): no Authorization header, so the token never leaves app-utalk (§7.8). */
  file(url: string): Promise<UmblerFile>;
}

export interface UmblerClientOpts {
  token: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<unknown>;
  now?: () => number;
}

export function createUmblerClient(opts: UmblerClientOpts): UmblerClient {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const sleep = opts.sleep ?? delay;
  const now = opts.now ?? Date.now;
  const base = opts.baseUrl ?? UMBLER_API;
  let last = Number.NEGATIVE_INFINITY;

  async function call(url: URL): Promise<Response | null> {
    const wait = last + MIN_GAP_MS - now();
    if (wait > 0) await sleep(wait);
    last = now();
    try {
      return await fetchImpl(url, {
        headers: { Authorization: `Bearer ${opts.token}`, Accept: 'application/json' },
        redirect: 'error', // the token never follows a redirect
        signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
      });
    } catch {
      return null; // network error, timeout or a redirect
    }
  }

  async function get<T>(route: string, query: Query = {}, params: Record<string, string> = {}): Promise<T> {
    const url = new URL(base + route.replace(/\{(\w+)\}/g, (_m, k: string) => encodeURIComponent(params[k] ?? '')));
    for (const [k, v] of Object.entries(query)) for (const x of [v].flat()) url.searchParams.append(k, String(x));
    for (let limited = 0, down = 0; ; ) {
      const res = await call(url);
      if (res?.ok) return (await res.json()) as T;
      await res?.body?.cancel();
      const status = res?.status ?? null;
      if (status === 429) {
        if (limited === WAITS_429_S.length) throw new UmblerError('umbler_429', status, route);
        const retryAfter = Number(res?.headers.get('retry-after'));
        await sleep((retryAfter > 0 ? retryAfter : WAITS_429_S[limited]!) * 1000);
        limited += 1;
      } else if (status === 401 || status === 403) {
        throw new UmblerError('umbler_token', status, route);
      } else if (status === null || status >= 500) {
        if (down === WAITS_DOWN_MS.length) throw new UmblerError('umbler_unavailable', status, route);
        await sleep(WAITS_DOWN_MS[down]!);
        down += 1;
      } else {
        throw new UmblerError('umbler_400', status, route); // 400 (our query), 404 (isGone) and any other 4xx
      }
    }
  }

  async function fileOnce(url: string): Promise<UmblerFile> {
    if (!/^https?:\/\//.test(url)) return { failed: 'gone' };
    let res: Response;
    try {
      res = await fetchImpl(url, { signal: AbortSignal.timeout(FILE_TIMEOUT_MS) });
    } catch {
      return { failed: 'temporary' };
    }
    if (!res.ok || Number(res.headers.get('content-length')) > FILE_MAX_BYTES) {
      await res.body?.cancel();
      return { failed: res.status >= 500 ? 'temporary' : 'gone' };
    }
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for await (const chunk of res.body ?? []) {
        size += chunk.length;
        if (size > FILE_MAX_BYTES) return { failed: 'gone' }; // leaving the loop cancels the download
        chunks.push(chunk);
      }
    } catch {
      return { failed: 'temporary' }; // the timeout or the connection dropped mid-file
    }
    return { data: Buffer.concat(chunks), mime: baseMime(res.headers.get('content-type') ?? '') || 'application/octet-stream' };
  }

  return {
    get,
    async file(url) {
      for (let attempt = 0; ; attempt += 1) {
        const got = await fileOnce(url);
        if (!('failed' in got) || got.failed === 'gone' || attempt === FILE_WAITS_MS.length) return got;
        await sleep(FILE_WAITS_MS[attempt]!);
      }
    },
  };
}

/** §4 Skip/Take pages (Take=50) until the first empty one. `count`: the first page asks for page.totalItems (Analisar). */
export async function* pages<T>(
  client: UmblerClient,
  route: string,
  query: Query,
  count = false,
): AsyncGenerator<{ items: T[]; total: number | null }> {
  for (let skip = 0; ; ) {
    const first = count && skip === 0;
    const page = await client.get<{ page?: { totalItems?: number }; items?: T[] }>(route, {
      ...query,
      Skip: skip,
      Take: PAGE_SIZE,
      ...(first ? { Behavior: 'CountAllAndGetSlice' } : {}),
    });
    const items = page.items ?? [];
    if (items.length === 0) return;
    yield { items, total: first ? (page.page?.totalItems ?? null) : null };
    skip += items.length;
  }
}

export async function getAll<T>(client: UmblerClient, route: string, query: Query): Promise<T[]> {
  const all: T[] = [];
  for await (const page of pages<T>(client, route, query)) all.push(...page.items);
  return all;
}

async function fetchUmbler(deps: ImportDeps) {
  const client = createUmblerClient({ token: deps.token, baseUrl: deps.baseUrl, fetchImpl: deps.fetchImpl, sleep: deps.sleep });
  const get = client.get;
  const me = await get<UmblerMe>('/v1/members/me/', {});
  // ponytail: first organization of the token; the office has exactly one.
  const org = me.organizations?.[0];
  if (!org) throw new Error('O token do Umbler não pertence a nenhuma organização');
  const q: Query = { organizationId: org.id };

  const sectorList = await get<UmblerSector[]>('/v1/sectors/', q);
  const tagList = await getAll<UmblerTag>(client, '/v1/tags/', q);
  const fieldDefs = await get<UmblerFieldDef[]>('/v1/custom-field-definitions/', q);
  const contactList = await getAll<UmblerContact>(client, '/v1/contacts/', {
    ...q,
    includeGroups: false,
    includeCustomFields: fieldDefs.map((d) => d.id),
  });
  const qaList = await getAll<{ id: string }>(client, '/v1/quick-answers/', { ...q, viewFrom: 'Everyone' });
  const qaDetails: UmblerQuickAnswer[] = [];
  for (const { id } of qaList) qaDetails.push(await get<UmblerQuickAnswer>('/v1/quick-answers/{id}/', q, { id }));

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
