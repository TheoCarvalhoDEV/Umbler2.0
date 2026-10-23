import { statfs } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { eq, inArray } from 'drizzle-orm';
import { UMBLER_IMPORT_PHASES, emptyUmblerCounts, type UmblerAnalysisDto, type UmblerImportPhase, type UmblerProgressDto } from '@talk/shared';
import { errorTag } from '../bots/scheduler.js';
import type { AppCtx } from '../ctx.js';
import { channels, contacts, customFields, quickAnswers, sectors, tags, umblerImports, users } from '../db/schema.js';
import { normalizePhoneBR } from '../whatsapp/phone.js';
import { FIRST_EVENT, chatQuery, fetchMessagePage, importClosedChats, importOpenChats } from './chats.js';
import {
  FIELD_KINDS, Stopped, UmblerError, createUmblerClient, fold, getAll, importCatalog, importContactsPhase, importNotesPhase, isGone,
  lidOf, pages, saveProgress, validPhone, type ImportRun, type UmblerChannel, type UmblerChat, type UmblerClient, type UmblerContact,
  type UmblerFieldDef, type UmblerMe, type UmblerOrganization, type UmblerQuickAnswer, type UmblerSector, type UmblerTag,
} from './umbler.js';

// Spec 2026-10-21 importar-umbler §5, §6.2, §9: "Analisar", the five phases and the resume. All state lives in
// umbler_imports and umbler_map, so a restart picks the row up where it stopped.

export type UmblerImportRow = typeof umblerImports.$inferSelect;

export interface JobDeps {
  client: UmblerClient;
  signal?: AbortSignal;
  sleep?: (ms: number) => Promise<unknown>;
  freeBytes?: (dir: string) => Promise<number>;
}

/** Free bytes of the disk that holds `dir` (§6.3 "Espaço livre", §7.8 disk_full). */
export async function freeBytesOf(dir: string): Promise<number> {
  const s = await statfs(dir);
  return s.bavail * s.bsize;
}

export const emptyProgress = (): UmblerProgressDto => ({ ...emptyUmblerCounts(), done: 0, total: 0, chatsRead: 0 });
const n = (x: number) => x.toLocaleString('pt-BR');

// ---------- Analisar (§5.1, §6.2, §6.3) ----------

/** §5.1: reads the newest closed chat still "Received" from the contact the way the import does, then checks it again. */
async function readTest(client: UmblerClient, org: string, chat: UmblerChat): Promise<UmblerAnalysisDto['readTest']> {
  try {
    await fetchMessagePage(client, org, chat.id, new Date(FIRST_EVENT));
  } catch (err) {
    if (isGone(err)) return 'not_done';
    throw err;
  }
  const again = await client.get<{ items?: UmblerChat[] }>(
    '/v1/contacts/{id}/chats/',
    { organizationId: org, ChatState: 'Closed', Skip: 0, Take: 50 },
    { id: chat.contact.id },
  );
  const after = again.items?.find((c) => c.id === chat.id);
  if (!after) return 'not_done';
  const same = after.lastMessage?.messageState === chat.lastMessage?.messageState && (after.totalUnread ?? 0) === (chat.totalUnread ?? 0);
  return same ? 'ok' : 'marked';
}

/** "Analisar" (§6.2): lists only (no messages, ~300 calls), counts, proposals, warnings and the read test. */
export async function analyzeUmbler(ctx: AppCtx, deps: JobDeps, row: UmblerImportRow): Promise<void> {
  const c = deps.client;
  const me = await c.get<UmblerMe>('/v1/members/me/');
  const ref = me.organizations?.[0]; // ponytail: the office has exactly one organization (§4)
  if (!ref) throw new UmblerError('umbler_token', null, '/v1/members/me/');
  const q = { organizationId: ref.id };
  const org = await c.get<UmblerOrganization>('/v1/organizations/{id}/', {}, { id: ref.id });
  const channelList = await c.get<UmblerChannel[]>('/v1/channels/', q);
  const sectorList = await c.get<UmblerSector[]>('/v1/sectors/', q);
  const tagList = await getAll<UmblerTag>(c, '/v1/tags/', q);
  const fieldDefs = await c.get<UmblerFieldDef[]>('/v1/custom-field-definitions/', q);
  const answers = await getAll<UmblerQuickAnswer>(c, '/v1/quick-answers/', { ...q, viewFrom: 'Everyone' });

  const ours = await ctx.db.select({ phone: contacts.phone, lid: contacts.lid }).from(contacts);
  const phones = new Set(ours.flatMap((r) => (r.phone ? [r.phone] : [])));
  const lids = new Set(ours.flatMap((r) => (r.lid ? [r.lid] : [])));
  const contactCounts = { total: 0, existing: 0, withoutAddress: 0 };
  for await (const page of pages<UmblerContact>(c, '/v1/contacts/', { ...q, includeGroups: false, State: 'All' })) {
    for (const ct of page.items) {
      const phone = validPhone(ct.phoneNumber);
      const lid = lidOf(ct.lid);
      contactCounts.total += 1;
      if (!phone && !lid) contactCounts.withoutAddress += 1;
      else if ((phone && phones.has(phone)) || (lid && lids.has(lid))) contactCounts.existing += 1;
    }
    if (deps.signal?.aborted) throw new Stopped();
  }

  const progress = emptyProgress();
  const warnings: string[] = [];
  const stats = { open: 0, waiting: 0, closed: 0, redacted: 0, from: Number.POSITIVE_INFINITY, to: Number.NEGATIVE_INFINITY };
  const byChannel = new Map(channelList.map((ch) => [ch.id, { name: ch.name, type: ch._t, phone: ch.phoneNumber ?? null, chats: 0 }]));
  const byMember = new Map<string, number>();
  let candidate: UmblerChat | undefined;
  for (const state of ['open', 'closed'] as const) {
    let walked = 0;
    let total: number | null = null;
    for await (const page of pages<UmblerChat>(c, '/v1/chats/', chatQuery(ref.id, state), true)) {
      total ??= page.total;
      for (const ch of page.items) {
        walked += 1;
        stats[state] += 1;
        if (state === 'open' && ch.waiting) stats.waiting += 1;
        if (ch.redactReason) stats.redacted += 1;
        stats.from = Math.min(stats.from, Date.parse(ch.createdAtUTC));
        stats.to = Math.max(stats.to, Date.parse(ch.createdAtUTC));
        // a channel only a chat names (removed from Umbler) still gets its row
        const known = byChannel.get(ch.channel.id) ?? { name: ch.channel.name ?? '', type: ch.channel._t, phone: ch.channel.phoneNumber ?? null, chats: 0 };
        known.chats += 1;
        byChannel.set(ch.channel.id, known);
        if (ch.organizationMember) byMember.set(ch.organizationMember.id, (byMember.get(ch.organizationMember.id) ?? 0) + 1);
        if (state === 'closed' && !candidate && ch.lastMessage?.source === 'Contact' && ch.lastMessage.messageState === 'Received') {
          candidate = ch; // the newest one: the list is ClosedAtUTC Desc
        }
      }
      progress.chatsRead += page.items.length;
      await ctx.db.update(umblerImports).set({ progress }).where(eq(umblerImports.id, row.id)); // "N conversas lidas"
      if (deps.signal?.aborted) throw new Stopped();
    }
    // decision: page.totalItems of the first page is checked against what the walk found (§4 "conferir")
    if (total !== null && total !== walked) {
      warnings.push(`O Umbler informou ${n(total)} conversas ${state === 'open' ? 'abertas' : 'finalizadas'}, mas a lista trouxe ${n(walked)}.`);
    }
  }
  const tested = candidate ? await readTest(c, ref.id, candidate) : 'not_done';

  const ourSectors = await ctx.db.select({ id: sectors.id, name: sectors.name }).from(sectors);
  const ourUsers = await ctx.db.select({ id: users.id, email: users.email }).from(users);
  const ourChannels = await ctx.db
    .select({ id: channels.id, phone: channels.phone, status: channels.status })
    .from(channels)
    .orderBy(channels.createdAt);
  const sectorByName = new Map(ourSectors.map((s) => [fold(s.name), s.id]));
  const userByEmail = new Map(ourUsers.map((u) => [fold(u.email), u.id]));
  const channelByPhone = new Map(ourChannels.flatMap((ch) => (ch.phone ? [[normalizePhoneBR(ch.phone), ch.id] as const] : [])));

  const rows = [...byChannel].map(([id, ch]) => {
    const whatsapp = /whatsapp/i.test(ch.type);
    const phone = ch.phone ? normalizePhoneBR(ch.phone) : null;
    return { id, name: ch.name, type: ch.type, phone, whatsapp, chats: ch.chats, same: whatsapp && phone ? channelByPhone.get(phone) : undefined };
  });
  // §6.2 + §18.3: a WhatsApp number that is not here (an old number of the office) goes to the official channel: the one
  // an Umbler number matched, else our oldest connected channel, else our oldest channel.
  const official = rows.find((r) => r.same)?.same ?? ourChannels.find((ch) => ch.status === 'connected')?.id ?? ourChannels[0]?.id ?? 'none';
  const channelRows = rows.map(({ same, ...r }) => ({ ...r, proposal: r.whatsapp ? (same ?? official) : 'none' }));

  const members = (org.organizationMembers ?? [])
    .filter((m) => m._t === 'OrganizationHumanAgentReferenceModel' && m.emailAddress?.trim()) // AI agents stay out (§4)
    .map((m) => {
      const email = m.emailAddress!.trim();
      return {
        id: m.id, name: m.displayName?.trim() || email, email, active: m.active ?? false, chats: byMember.get(m.id) ?? 0,
        proposal: userByEmail.get(fold(email)) ?? 'create', // §18.4: no user with that e-mail → an inactive user
      };
    });

  const ourTags = new Set((await ctx.db.select({ name: tags.name }).from(tags)).map((t) => fold(t.name)));
  const ourFields = new Set((await ctx.db.select({ name: customFields.name }).from(customFields)).map((f) => fold(f.name)));
  const ourAnswers = new Set((await ctx.db.select({ name: quickAnswers.name }).from(quickAnswers)).map((a) => fold(a.name)));
  const newTags = tagList.filter((t) => !ourTags.has(fold(t.name.trim().slice(0, 30)))).length;
  const supported = fieldDefs.filter((d) => FIELD_KINDS[d._t]);
  const newFields = supported.filter((d) => !ourFields.has(fold(d.name))).length;
  const newAnswers = answers.filter((a) => !ourAnswers.has(fold(a.name))).length;

  const perms = ref.permissions ?? [];
  const everything = (perms.includes('Owner') || perms.includes('Admin')) && ref.allowedSectors?.allSectorsEnable && ref.allowedChannels?.allChannelsEnable;
  if (!everything) warnings.unshift('O token é de um usuário sem acesso a tudo: gere o token com o Proprietário.');
  if (stats.redacted) warnings.push(`${n(stats.redacted)} conversas vêm sem conteúdo para este token.`);
  if (org.maxDaysMessageHistoric) {
    warnings.push(`O plano do Umbler mostra só os últimos ${n(org.maxDaysMessageHistoric)} dias de mensagens; as anteriores não vêm.`);
  }
  if (tested === 'not_done') warnings.push('Não houve conversa para o teste de leitura; a importação confere as abertas durante a cópia.');
  const free = await (deps.freeBytes ?? freeBytesOf)(ctx.config.mediaDir);
  warnings.push(`Espaço livre para arquivos: ${(free / 1024 ** 3).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} GB.`);

  const analysis: UmblerAnalysisDto = {
    organizationId: ref.id,
    organization: org.name,
    contacts: contactCounts,
    chats: {
      open: stats.open, waiting: stats.waiting, closed: stats.closed,
      from: Number.isFinite(stats.from) ? new Date(stats.from).toISOString() : null,
      to: Number.isFinite(stats.to) ? new Date(stats.to).toISOString() : null,
    },
    channels: channelRows,
    sectors: sectorList.map((s) => ({ id: s.id, name: s.name.trim(), proposal: sectorByName.get(fold(s.name)) ?? 'create' })),
    members,
    tags: { new: newTags, existing: tagList.length - newTags },
    customFields: {
      new: newFields, existing: supported.length - newFields,
      unsupported: fieldDefs.filter((d) => !FIELD_KINDS[d._t]).map((d) => d.name.trim()),
    },
    quickAnswers: { new: newAnswers, existing: answers.length - newAnswers },
    readTest: tested,
    warnings,
  };
  await ctx.db.update(umblerImports).set({ state: 'analyzed', analysis, progress }).where(eq(umblerImports.id, row.id));
  console.info('umbler: analyzed', { importId: row.id, contacts: contactCounts.total, chats: stats.open + stats.closed, readTest: tested });
}

// ---------- Importar (§9.1-9.3) ----------

const PHASES: Record<UmblerImportPhase, (run: ImportRun) => Promise<void>> = {
  catalog: importCatalog,
  contacts: importContactsPhase,
  open_chats: importOpenChats,
  notes: importNotesPhase,
  closed_chats: importClosedChats,
};

/** The phases from the one the row stopped in; every phase skips what umbler_map already has. */
export async function importUmbler(ctx: AppCtx, deps: JobDeps, row: UmblerImportRow): Promise<void> {
  if (!row.analysis || !row.mapping) throw new Error('umbler: a running import without analysis or mapping');
  const signal = deps.signal ?? new AbortController().signal;
  const run: ImportRun = {
    ctx,
    client: deps.client,
    importId: row.id,
    org: row.analysis.organizationId,
    analysis: row.analysis,
    mapping: row.mapping,
    progress: { ...emptyProgress(), ...row.progress },
    signal,
    sleep: deps.sleep ?? ((ms) => delay(ms, undefined, { signal })),
    freeBytes: deps.freeBytes ?? freeBytesOf,
  };
  for (let i = UMBLER_IMPORT_PHASES.indexOf(row.phase ?? 'catalog'); i < UMBLER_IMPORT_PHASES.length; i += 1) {
    const phase = UMBLER_IMPORT_PHASES[i]!;
    run.progress.done = 0;
    run.progress.total = 0;
    await saveProgress(ctx.db, run, phase);
    await PHASES[phase](run);
    console.info('umbler: phase done', { importId: row.id, phase });
  }
  const finishedAt = new Date();
  const { done: _done, total: _total, chatsRead: _read, maps: _maps, ...counts } = run.progress;
  const durationMs = finishedAt.getTime() - (row.startedAt ?? finishedAt).getTime();
  await ctx.db.update(umblerImports).set({ state: 'done', finishedAt, report: { ...counts, durationMs } }).where(eq(umblerImports.id, row.id));
  console.info('umbler: import done', { importId: row.id, chats: counts.chats.openCreated + counts.chats.closed, messages: counts.messages.total });
}

/**
 * One beat (§9.3): advances the active row (analyzing or running) until it ends, fails or the worker stops. A stop
 * between pages leaves it as it is; any other error marks it failed with its §9.4 code. The row is read fresh on every
 * beat, so a failed phase never leaves its in-memory counters behind (they may include a rolled-back transaction).
 */
export async function runUmblerJob(ctx: AppCtx, deps: JobDeps): Promise<void> {
  const [row] = await ctx.db.select().from(umblerImports).where(inArray(umblerImports.state, ['analyzing', 'running']));
  if (!row) return;
  try {
    if (row.state === 'analyzing') await analyzeUmbler(ctx, deps, row);
    else await importUmbler(ctx, deps, row);
  } catch (err) {
    if (err instanceof Stopped || deps.signal?.aborted) return;
    const code = err instanceof UmblerError ? err.code : 'unexpected';
    // ids, the code and the route template only (§3): never text, phone, name, URL or the token
    console.error('umbler: import stopped', { importId: row.id, code, route: err instanceof UmblerError ? err.route : null, err: errorTag(err) });
    await ctx.db.update(umblerImports).set({ state: 'failed', error: code }).where(eq(umblerImports.id, row.id));
  }
}

/** The worker's beat. Without UMBLER_TOKEN an active row fails with umbler_token (the token left the .env). */
export async function umblerBeat(ctx: AppCtx, signal: AbortSignal, makeClient?: () => UmblerClient): Promise<void> {
  const sleep = (ms: number) => delay(ms, undefined, { signal });
  const token = ctx.config.umblerToken;
  const client = makeClient ? makeClient() : token ? createUmblerClient({ token, sleep }) : null;
  if (!client) {
    await ctx.db.update(umblerImports).set({ state: 'failed', error: 'umbler_token' }).where(inArray(umblerImports.state, ['analyzing', 'running']));
    return;
  }
  await runUmblerJob(ctx, { client, signal, sleep });
}
