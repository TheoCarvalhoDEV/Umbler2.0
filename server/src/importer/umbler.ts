import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import {
  tagColorHex, type UmblerAnalysisDto, type UmblerImportError, type UmblerImportPhase, type UmblerMappingDto, type UmblerProgressDto,
} from '@talk/shared';
import { hashPassword } from '../auth/password.js';
import type { AppCtx } from '../ctx.js';
import type { Db, Tx } from '../db/client.js';
import {
  contactFieldValues, contactNotes, contactTags, contacts, customFields, quickAnswers, sectors, tags, umblerImports, umblerMap, users,
  type UmblerCatalogMaps, type UmblerPhaseStart,
} from '../db/schema.js';
import { mergeLidPairs } from '../history/merge.js';
import { getDefaultSectorId } from '../inbox/chats.js';
import { baseMime, saveMedia } from '../messages/media.js';
import { convertUmblerVariables } from '../messages/quick-answers.js';
import { lidFromJid, normalizePhoneBR } from '../whatsapp/phone.js';

// ---------- the Umbler API: GET only (spec 2026-10-21 importar-umbler §3, §9.4) ----------

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
      let status = res?.status ?? null;
      if (res?.ok) {
        try {
          return (await res.json()) as T;
        } catch {
          status = null; // body timeout, connection reset mid-body or not JSON: same as a network error
        }
      } else await res?.body?.cancel();
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

// ---------- what we read (docs/umbler/utalk-openapi-v1.json; only the fields we map) ----------

export interface UmblerRef { id: string }
export interface UmblerMe {
  organizations?: Array<{
    id: string;
    name: string;
    permissions?: string[];
    allowedSectors?: { allSectorsEnable?: boolean } | null;
    allowedChannels?: { allChannelsEnable?: boolean } | null;
  }>;
}
export interface UmblerMember { _t: string; id: string; displayName?: string | null; emailAddress?: string | null; active?: boolean }
export interface UmblerOrganization { id: string; name: string; maxDaysMessageHistoric?: number | null; organizationMembers?: UmblerMember[] }
export interface UmblerChannel { _t: string; id: string; name: string; phoneNumber?: string | null }
export interface UmblerSector { id: string; name: string; default: boolean; order: number }
export interface UmblerTag { id: string; name: string; emoji?: string | null; color?: string | null; order: number }
export interface UmblerFieldDef { _t: string; id: string; name: string }
export interface UmblerContact {
  id: string;
  name?: string | null;
  phoneNumber?: string | null;
  lid?: string | null;
  email?: string | null;
  landline?: string | null;
  address?: Record<string, string | null> | null;
  isBlocked?: boolean;
  tags?: UmblerRef[];
  customFields?: Array<{ customFieldDefinitionId: string; value?: unknown }>;
}
export interface UmblerQuickAnswer {
  id: string;
  name: string;
  content?: string | null;
  variables?: Array<{ defaultValue?: string | null }>;
  attachment?: { url?: string | null; originalName?: string | null } | null;
  organizationMember?: UmblerRef | null;
}
export interface UmblerNote { id: string; content: string; pinned?: boolean; createdBy?: string | null; createdAtUTC: string }
export interface UmblerChat {
  id: string;
  createdAtUTC: string;
  contact: { id: string; name?: string | null; phoneNumber?: string | null; lid?: string | null };
  channel: { id: string; _t: string; name?: string | null; phoneNumber?: string | null };
  sector?: UmblerRef | null;
  organizationMember?: UmblerRef | null;
  tags?: UmblerRef[];
  private?: boolean;
  waiting?: boolean;
  waitingSinceUTC?: string | null;
  totalUnread?: number;
  closedAtUTC?: string | null;
  closedBy?: UmblerRef | null;
  redactReason?: string | null;
  lastMessage?: { id: string; source?: string; messageState?: string } | null;
}
export interface UmblerMessage {
  _t: string;
  id: string;
  eventAtUTC: string;
  source?: string;
  isPrivate?: boolean;
  messageType?: string;
  content?: string | null;
  prefix?: string | null;
  file?: {
    url?: string | null;
    contentType?: string | null;
    originalName?: string | null;
    originalSizeBytes?: number | null;
    caption?: string | null;
    failDownload?: boolean;
  } | null;
  sentByOrganizationMember?: UmblerRef | null;
  inReplyTo?: UmblerRef | null;
  messageState?: string;
  latestEdit?: { senderAtUTC?: string | null } | null;
  reactions?: Array<{ emoji: string; source?: string; eventAtUTC: string }>;
  location?: { latitude: string; longitude: string; name?: string | null; address?: string | null } | null;
  contacts?: Array<{ name?: string | null; phoneNumbers?: string[] }>;
}

// ---------- one running import ----------

export type UmblerProgress = UmblerProgressDto & { maps?: UmblerCatalogMaps; phaseStart?: UmblerPhaseStart };

/** What every phase reads, and the counters it adds to (saved with the page that changed them, §9.3). */
export interface ImportRun {
  ctx: AppCtx;
  client: UmblerClient;
  importId: string;
  org: string;
  analysis: UmblerAnalysisDto;
  mapping: UmblerMappingDto;
  progress: UmblerProgress;
  signal: AbortSignal;
  sleep: (ms: number) => Promise<unknown>;
  freeBytes: (dir: string) => Promise<number>;
}

/** Thrown between pages once the worker stops: the row stays 'running' and the next start resumes it (§9.3). */
export class Stopped extends Error {}
export function checkStop(run: ImportRun): void {
  if (run.signal.aborted) throw new Stopped();
}

/** Writes the counters (and the phase, when given); inside the page's transaction, so a restart never counts twice. */
export async function saveProgress(db: Db | Tx, run: ImportRun, phase?: UmblerImportPhase): Promise<void> {
  await db
    .update(umblerImports)
    .set({ progress: run.progress, ...(phase ? { phase } : {}) })
    .where(eq(umblerImports.id, run.importId));
}

export function maps(run: ImportRun): UmblerCatalogMaps {
  if (!run.progress.maps) throw new Error('umbler: the catalog phase did not run');
  return run.progress.maps;
}

export const orgQuery = (run: ImportRun): Query => ({ organizationId: run.org });
/** Names compare trimmed and without case (§6.2, §7.1). */
export const fold = (s: string): string => s.trim().toLowerCase();
const str = (v: string | null | undefined): string | null => v?.trim() || null;
const byOrder = <T extends { order: number }>(list: T[]): T[] => [...list].sort((a, b) => a.order - b.order);

export function validPhone(raw: string | null | undefined): string | null {
  const phone = normalizePhoneBR(raw ?? '');
  return /^\d{10,15}$/.test(phone) ? phone : null;
}
export function lidOf(raw: string | null | undefined): string | null {
  return raw ? (lidFromJid(raw) ?? (/^\d+$/.test(raw) ? raw : null)) : null;
}

// ---------- phase 1: catalog (§7.1, §7.2), one transaction ----------

type FieldKind = UmblerCatalogMaps['fields'][string]['kind'];

// Umbler definition `_t` → our kind. Anything else (logic, lists, options, members, references, files, dictionaries)
// is listed in customFields.unsupported and its values are skipped.
export const FIELD_KINDS: Record<string, FieldKind> = {
  TextCustomFieldDefinitionModel: 'text',
  LinkCustomFieldDefinitionModel: 'text',
  NumberCustomFieldDefinitionModel: 'number',
  DecimalCustomFieldDefinitionModel: 'number',
  CurrencyCustomFieldDefinitionModel: 'number',
  DateCustomFieldDefinitionModel: 'date',
  CPFCustomFieldDefinitionModel: 'cpf',
  CNPJCustomFieldDefinitionModel: 'cnpj',
};

function toAddress(a: Record<string, string | null> | null | undefined): Record<string, string> | null {
  const entries = Object.entries(a ?? {}).filter((e): e is [string, string] => typeof e[1] === 'string' && e[1].trim() !== '');
  return entries.length ? Object.fromEntries(entries) : null;
}

function fieldValue(v: unknown, kind: FieldKind): string | null {
  if (typeof v === 'number') return String(v);
  if (typeof v !== 'string' || !v.trim()) return null;
  return kind === 'date' ? v.trim().slice(0, 10) : v.trim();
}

/** The admin's choice wins; 'create' (or an id that is gone) reuses a sector of the same name, else creates it. */
async function importSectors(tx: Tx, list: UmblerSector[], mapping: Record<string, string>, c: UmblerProgress) {
  const rows = await tx.select().from(sectors);
  const ours = new Set(rows.map((s) => s.id));
  const byName = new Map(rows.map((s) => [fold(s.name), s.id]));
  let hasDefault = rows.some((s) => s.isDefault);
  const map: Record<string, string> = {};
  for (const [i, s] of byOrder(list).entries()) {
    const target = mapping[s.id];
    const id = target && ours.has(target) ? target : byName.get(fold(s.name));
    if (id) {
      map[s.id] = id;
      c.sectors.existing += 1;
      continue;
    }
    const name = s.name.trim();
    const [row] = await tx.insert(sectors).values({ name, position: i, isDefault: s.default && !hasDefault }).returning({ id: sectors.id });
    hasDefault ||= s.default;
    byName.set(fold(name), row!.id);
    map[s.id] = row!.id;
    c.sectors.created += 1;
  }
  return map;
}

async function importTags(tx: Tx, list: UmblerTag[], c: UmblerProgress) {
  const idByName = new Map((await tx.select({ id: tags.id, name: tags.name }).from(tags)).map((t) => [fold(t.name), t.id]));
  const map: Record<string, string> = {};
  for (const [i, t] of byOrder(list).entries()) {
    const name = t.name.trim().slice(0, 30); // tags.name is varchar(30)
    let id = idByName.get(fold(name));
    if (id) {
      c.tags.existing += 1;
    } else {
      // Umbler TagColor name → hex of the shared palette, so the tag matches a TagForm swatch.
      const [row] = await tx
        .insert(tags)
        .values({ name, emoji: str(t.emoji), color: tagColorHex(t.color ?? ''), position: i })
        .returning({ id: tags.id });
      id = row!.id;
      idByName.set(fold(name), id);
      c.tags.created += 1;
    }
    map[t.id] = id;
  }
  return map;
}

async function importFields(tx: Tx, list: UmblerFieldDef[], c: UmblerProgress) {
  const rows = await tx.select({ id: customFields.id, name: customFields.name, kind: customFields.kind }).from(customFields);
  const byName = new Map(rows.map((f) => [fold(f.name), { id: f.id, kind: f.kind }]));
  const map: UmblerCatalogMaps['fields'] = {};
  for (const [i, d] of list.entries()) {
    const name = d.name.trim();
    const kind = FIELD_KINDS[d._t];
    if (!kind) {
      c.customFields.unsupported.push(name);
      continue;
    }
    let field = byName.get(fold(name));
    if (field) {
      c.customFields.existing += 1;
    } else {
      const [row] = await tx
        .insert(customFields)
        .values({ name, kind, position: i })
        .returning({ id: customFields.id, kind: customFields.kind });
      field = row!;
      byName.set(fold(name), field);
      c.customFields.created += 1;
    }
    map[d.id] = field;
  }
  return map;
}

/** §7.2: link to the chosen user (nothing in it changes), or create an inactive agent nobody can log in as. */
async function importMembers(tx: Tx, list: UmblerAnalysisDto['members'], mapping: Record<string, string>, c: UmblerProgress) {
  const rows = await tx.select({ id: users.id, email: users.email, active: users.active }).from(users);
  const byId = new Map(rows.map((u) => [u.id, u]));
  const byEmail = new Map(rows.map((u) => [fold(u.email), u]));
  const map: UmblerCatalogMaps['members'] = {};
  for (const m of list) {
    const target = mapping[m.id] ?? 'none';
    const found = target === 'none' ? undefined : target === 'create' ? byEmail.get(fold(m.email)) : byId.get(target);
    if (found) {
      map[m.id] = { id: found.id, active: found.active };
      c.members.linked += 1;
    } else if (target === 'create') {
      // a hash of 32 random bytes nobody knows; role agent, no sectors (§7.2)
      const passwordHash = await hashPassword(randomBytes(32).toString('base64'));
      const email = fold(m.email);
      const [row] = await tx
        .insert(users)
        .values({ name: m.name.trim() || email, email, passwordHash, role: 'agent', active: false })
        .returning({ id: users.id });
      map[m.id] = { id: row!.id, active: false };
      byEmail.set(email, { id: row!.id, email, active: false });
      c.members.createdInactive += 1;
    } else {
      c.members.none += 1; // "Sem atendente", or the chosen user was deleted meanwhile
    }
  }
  return map;
}

async function importQuickAnswers(
  tx: Tx,
  list: UmblerQuickAnswer[],
  attachments: Map<string, string | null>,
  members: UmblerCatalogMaps['members'],
  c: UmblerProgress,
): Promise<void> {
  const names = new Set((await tx.select({ name: quickAnswers.name }).from(quickAnswers)).map((q) => fold(q.name)));
  for (const qa of list) {
    const name = qa.name.trim();
    if (names.has(fold(name))) {
      c.quickAnswers.existing += 1;
      continue;
    }
    const { body, unmapped } = convertUmblerVariables(
      qa.content ?? '',
      (qa.variables ?? []).map((v) => ({ defaultValue: v.defaultValue ?? '' })),
    );
    if (unmapped.length) c.quickAnswers.unmappedVariables.push(name);
    if (attachments.get(qa.id) === null) c.quickAnswers.attachmentErrors.push(name);
    // §7.1: "Apenas para mim" (inferred from organizationMember, §4.1) of an active user stays that user's
    const owner = qa.organizationMember ? members[qa.organizationMember.id] : undefined;
    const mine = owner?.active === true;
    await tx.insert(quickAnswers).values({
      name, body, attachmentPath: attachments.get(qa.id) ?? null, visibility: mine ? 'owner' : 'all', ownerId: mine ? owner.id : null,
    });
    names.add(fold(name));
    c.quickAnswers.created += 1;
  }
}

/** A quick-answer attachment saved under mediaDir; null when it could not be downloaded (listed in the report). */
async function saveAttachment(run: ImportRun, url: string, name: string | null): Promise<string | null> {
  const got = await run.client.file(url);
  if ('failed' in got) return null;
  // ponytail: a file saved before a failed commit stays orphaned in mediaDir; harmless for a one-off import.
  return (await saveMedia(run.ctx.config.mediaDir, got.data, got.mime, name)).path;
}

/** Phase 1 (§7.1, §9.1): sectors, tags, fields, attendants and quick answers in one transaction, which also moves to 'contacts'. */
export async function importCatalog(run: ImportRun): Promise<void> {
  const q = orgQuery(run);
  const sectorList = await run.client.get<UmblerSector[]>('/v1/sectors/', q);
  const tagList = await getAll<UmblerTag>(run.client, '/v1/tags/', q);
  const fieldDefs = await run.client.get<UmblerFieldDef[]>('/v1/custom-field-definitions/', q);
  const listed = await getAll<UmblerQuickAnswer>(run.client, '/v1/quick-answers/', { ...q, viewFrom: 'Everyone' });
  const existing = new Set((await run.ctx.db.select({ name: quickAnswers.name }).from(quickAnswers)).map((r) => fold(r.name)));
  // Details and files of the new answers only, before the transaction: no network call inside it (§11).
  const details: UmblerQuickAnswer[] = [];
  const attachments = new Map<string, string | null>();
  for (const item of listed) {
    if (existing.has(fold(item.name))) {
      details.push(item);
      continue;
    }
    checkStop(run);
    const qa = await run.client.get<UmblerQuickAnswer>('/v1/quick-answers/{id}/', q, { id: item.id });
    details.push(qa);
    if (qa.attachment?.url) attachments.set(qa.id, await saveAttachment(run, qa.attachment.url, qa.attachment.originalName ?? null));
  }
  const c = run.progress;
  await run.ctx.db.transaction(async (tx) => {
    const sectorMap = await importSectors(tx, sectorList, run.mapping.sectors, c);
    const tagMap = await importTags(tx, tagList, c);
    const fieldMap = await importFields(tx, fieldDefs, c);
    const members = await importMembers(tx, run.analysis.members, run.mapping.members, c);
    await importQuickAnswers(tx, details, attachments, members, c);
    c.maps = { sectors: sectorMap, tags: tagMap, fields: fieldMap, members, defaultSector: await getDefaultSectorId(tx) };
    await saveProgress(tx, run, 'contacts'); // its counters are not idempotent: the catalog never runs twice
  });
}

// ---------- phase 2: contacts (§7.4), phase 4: their notes (§7.5) ----------

const CONTACT_BATCH = 100;
const NIL_UUID = '00000000-0000-0000-0000-000000000000';

/**
 * §7.4: phone first, then LID; fills only what is empty. No valid phone but a LID → a LID-only contact; neither → null
 * (counted). Writes the umbler_map row in the same transaction; `blocked` only on a new contact.
 */
export async function upsertContact(tx: Tx, c: UmblerContact, counts: UmblerProgress['contacts']): Promise<string | null> {
  const phone = validPhone(c.phoneNumber);
  const lid = lidOf(c.lid);
  if (!phone && !lid) {
    counts.skipped += 1;
    return null;
  }
  const [byPhone] = phone ? await tx.select().from(contacts).where(eq(contacts.phone, phone)) : [];
  const [byLid] = lid ? await tx.select().from(contacts).where(eq(contacts.lid, lid)) : [];
  const found = byPhone ?? byLid;
  let id: string;
  if (found) {
    // never overwrite data already edited here; a LID owned by another contact is never copied
    await tx
      .update(contacts)
      .set({
        name: found.name ?? str(c.name),
        phone: found.phone ?? phone,
        lid: found.lid ?? (byLid ? null : lid),
        email: found.email ?? str(c.email),
        landline: found.landline ?? str(c.landline),
        address: found.address ?? toAddress(c.address),
      })
      .where(eq(contacts.id, found.id));
    id = found.id;
    counts.completed += 1;
  } else {
    const [row] = await tx
      .insert(contacts)
      .values({
        name: str(c.name), phone, lid, email: str(c.email), landline: str(c.landline), address: toAddress(c.address),
        blocked: c.isBlocked ?? false,
      })
      .returning({ id: contacts.id });
    id = row!.id;
    if (phone) counts.created += 1;
    else counts.lidOnly += 1;
  }
  await tx.insert(umblerMap).values({ kind: 'contact', umblerId: c.id, localId: id }).onConflictDoNothing();
  return id;
}

async function importContactBatch(run: ImportRun, list: UmblerContact[]): Promise<void> {
  if (list.length === 0) return;
  const m = maps(run);
  const p = run.progress;
  const mapped = await run.ctx.db
    .select({ umblerId: umblerMap.umblerId })
    .from(umblerMap)
    .where(and(inArray(umblerMap.kind, ['contact', 'contactSkipped']), inArray(umblerMap.umblerId, list.map((c) => c.id))));
  const done = new Set(mapped.map((r) => r.umblerId));
  const todo = list.filter((c) => !done.has(c.id));
  // §4.1: the list ignored includeCustomFields → one call per contact, before the transaction
  if (Object.keys(m.fields).length > 0) {
    for (const c of todo) {
      if (c.customFields !== undefined || (!validPhone(c.phoneNumber) && !lidOf(c.lid))) continue;
      checkStop(run);
      c.customFields = await run.client
        .get<NonNullable<UmblerContact['customFields']>>('/v1/contacts/{id}/custom-fields/', orgQuery(run), { id: c.id })
        .catch((err: unknown) => {
          if (isGone(err)) return [];
          throw err;
        });
    }
  }
  await run.ctx.db.transaction(async (tx) => {
    for (const c of todo) {
      const id = await upsertContact(tx, c, p.contacts);
      if (!id) {
        // marker so a resume or a second run neither recounts it nor asks for its fields again (no contact row: kind differs)
        await tx.insert(umblerMap).values({ kind: 'contactSkipped', umblerId: c.id, localId: NIL_UUID, doneAt: new Date() }).onConflictDoNothing();
        continue;
      }
      const tagRows = (c.tags ?? []).flatMap((t) => (m.tags[t.id] ? [{ contactId: id, tagId: m.tags[t.id]! }] : []));
      if (tagRows.length) await tx.insert(contactTags).values(tagRows).onConflictDoNothing();
      const valueRows = (c.customFields ?? []).flatMap((f) => {
        const field = m.fields[f.customFieldDefinitionId];
        const value = field ? fieldValue(f.value, field.kind) : null;
        return field && value !== null ? [{ contactId: id, fieldId: field.id, value }] : [];
      });
      if (valueRows.length) await tx.insert(contactFieldValues).values(valueRows).onConflictDoNothing();
    }
    p.done += list.length;
    await saveProgress(tx, run);
  });
  // §7.4: a LID-only contact the WhatsApp history created joins the phone one before any chat (§8 needs a single contact).
  // Every pair of the batch, mapped ones too: after a crash right here, or on a second run, it still merges (idempotent).
  await mergeLidPairs(
    run.ctx,
    list.flatMap((c) => {
      const phone = validPhone(c.phoneNumber);
      const lid = lidOf(c.lid);
      return phone && lid ? [{ lid, phone }] : [];
    }),
  );
}

/** Phase 2 (§9.1): the whole contact list, 100 per transaction; contacts already in umbler_map are skipped. */
export async function importContactsPhase(run: ImportRun): Promise<void> {
  const fieldIds = Object.keys(maps(run).fields);
  run.progress.total = run.analysis.contacts.total;
  let batch: UmblerContact[] = [];
  const query = { ...orgQuery(run), includeGroups: false, State: 'All', includeCustomFields: fieldIds };
  for await (const page of pages<UmblerContact>(run.client, '/v1/contacts/', query)) {
    checkStop(run);
    batch.push(...page.items);
    if (batch.length >= CONTACT_BATCH) {
      await importContactBatch(run, batch);
      batch = [];
    }
  }
  await importContactBatch(run, batch);
}

/** Phase 4 (§7.5): one notes call per imported contact still without done_at; a 404 (deleted in Umbler) is skipped. */
export async function importNotesPhase(run: ImportRun): Promise<void> {
  const { db } = run.ctx;
  const m = maps(run);
  const p = run.progress;
  const todo = await db
    .select({ umblerId: umblerMap.umblerId, localId: umblerMap.localId })
    .from(umblerMap)
    .where(and(eq(umblerMap.kind, 'contact'), isNull(umblerMap.doneAt)));
  p.total = todo.length;
  for (const row of todo) {
    checkStop(run);
    let notes: UmblerNote[] = [];
    try {
      notes = await run.client.get<UmblerNote[]>('/v1/contacts/{id}/notes/', orgQuery(run), { id: row.umblerId });
    } catch (err) {
      if (!isGone(err)) throw err;
      p.gone += 1;
    }
    await db.transaction(async (tx) => {
      const [contact] = await tx.select({ id: contacts.id }).from(contacts).where(eq(contacts.id, row.localId));
      const have = notes.length
        ? await tx
            .select({ umblerId: umblerMap.umblerId })
            .from(umblerMap)
            .where(and(eq(umblerMap.kind, 'note'), inArray(umblerMap.umblerId, notes.map((n) => n.id))))
        : [];
      const copied = new Set(have.map((r) => r.umblerId));
      for (const n of contact ? notes : []) {
        if (copied.has(n.id)) continue;
        const [note] = await tx
          .insert(contactNotes)
          .values({
            contactId: contact!.id, body: n.content, pinned: n.pinned ?? false, createdAt: new Date(n.createdAtUTC),
            authorId: (n.createdBy && m.members[n.createdBy]?.id) || null,
          })
          .returning({ id: contactNotes.id });
        await tx.insert(umblerMap).values({ kind: 'note', umblerId: n.id, localId: note!.id });
        p.notes += 1;
      }
      await tx
        .update(umblerMap)
        .set({ doneAt: new Date() })
        .where(and(eq(umblerMap.kind, 'contact'), eq(umblerMap.umblerId, row.umblerId)));
      p.done += 1;
      await saveProgress(tx, run);
    });
  }
}
