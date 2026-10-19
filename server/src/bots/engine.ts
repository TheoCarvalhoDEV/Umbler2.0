import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import type { PgUpdateSetSource } from 'drizzle-orm/pg-core';
import {
  MAX_FLOW_LEVELS,
  MAX_STEPS_PER_CALL,
  NON_TERMINAL_RUN_STATES,
  STEP_LOG_LIMIT,
  catalogEntry,
  outputsOf,
  type BotEventData,
  type BotNode,
  type BotRunStep,
  type BotStopReason,
} from '@talk/shared';
import type { AppCtx } from '../ctx.js';
import type { Db, Tx } from '../db/client.js';
import { botRuns, bots, chats, contacts, messages } from '../db/schema.js';
import { addEvent, type ChatEventKind } from '../inbox/events.js';
import { badRequest, conflict, notFound } from '../lib/http-error.js';
import { stripSignature } from '../messages/signature.js';
import { BlockError } from './block-error.js';
import { startNodeOf } from './graph.js';
import type { BlockResult, BotCtx, InboundReply, ResumeEvent } from './registry.js';
import { getBot, getRun, getVersionRow, insertRun, lockRun, type BotRunRow } from './repo.js';
import { loadBotTextVars, renderBotText } from './variables.js';

const ACTIVE = [...NON_TERMINAL_RUN_STATES];
type Terminal = 'finished' | 'failed' | 'stopped';
type BotRef = { id: string; name: string };

export interface StartRunInput {
  botId: string;
  chatId: string;
  entry: 'channel' | 'manual' | 'call';
  startedBy: string | null;
  parentRunId?: string | null;
  depth?: number;
}

/** Engine rule 1. Takes the chat lock, then runs the new run to its first wait or end. */
export async function startRun(ctx: AppCtx, input: StartRunInput): Promise<BotRunRow> {
  return ctx.botRuntime.withChatLock(input.chatId, () => startRunLocked(ctx, input));
}

/** startRun without the lock: startChild runs inside a step, which already holds it (the lock is not re-entrant). */
async function startRunLocked(ctx: AppCtx, input: StartRunInput): Promise<BotRunRow> {
  const depth = input.depth ?? 0;
  if (input.entry === 'call' && depth >= MAX_FLOW_LEVELS) throw new BlockError(`Limite de ${MAX_FLOW_LEVELS} fluxos encadeados`);
  const bot = await getBot(ctx.db, input.botId);
  const version = bot.status === 'active' && bot.publishedVersionId ? await getVersionRow(ctx.db, bot.publishedVersionId) : null;
  if (!version) throw badRequest('Este chatbot não está ativo');
  const startNode = startNodeOf(version.graph, input.entry);
  if (!startNode) throw badRequest('Este chatbot não tem esse tipo de início');
  const [chat] = await ctx.db.select().from(chats).where(eq(chats.id, input.chatId));
  if (!chat) throw notFound('Conversa não encontrada');
  if (input.entry !== 'call') {
    // ponytail: check-then-insert is safe under the in-process chat lock; insertRun turns a unique-index race into the same 409.
    const [busy] = await ctx.db
      .select({ id: botRuns.id })
      .from(botRuns)
      .where(and(eq(botRuns.chatId, chat.id), eq(botRuns.botId, bot.id), eq(botRuns.depth, 0), inArray(botRuns.state, ACTIVE)))
      .limit(1);
    if (busy) throw conflict('Este chatbot já está em execução nesta conversa');
  }
  const run = await ctx.db.transaction(async (tx) => {
    // An agent may have stopped the caller since its step began (stopRun takes no lock): no child for a stopped caller.
    // The BlockError reaches the caller's step, whose conditional save then ends it silently.
    if (input.entry === 'call' && (!input.parentRunId || (await lockRun(tx, input.parentRunId))?.state !== 'running')) {
      throw new BlockError('O fluxo que chamou foi interrompido');
    }
    const row = await insertRun(tx, {
      botId: bot.id,
      versionId: version.id,
      chatId: chat.id,
      contactId: chat.contactId,
      state: 'running',
      currentNodeId: startNode.id,
      depth,
      parentRunId: input.parentRunId ?? null,
      startedBy: input.startedBy,
    });
    // the bot takes the conversation: a pending triage menu must not also answer the contact's next reply
    if (input.entry !== 'call') await tx.update(chats).set({ triagePending: false }).where(eq(chats.id, chat.id));
    // keep updated_at: a run is not an edit of the bot ("atualizado em" in the list)
    await tx.update(bots).set({ runCount: sql`${bots.runCount} + 1`, updatedAt: sql`${bots.updatedAt}` }).where(eq(bots.id, bot.id));
    await addEvent(tx, chat.id, 'bot_started', eventData(bot, row.id), null);
    return row;
  });
  await ctx.hub.publishChat(chat.id);
  return step(ctx, run.id);
}

/** Engine rule 2: the step loop. The caller holds the chat lock. Returns the run as saved last. */
export async function step(ctx: AppCtx, runId: string, resume?: ResumeEvent): Promise<BotRunRow> {
  let run = await loadRun(ctx.db, runId);
  if (run.state !== 'running') return run;
  const botRow = await getBot(ctx.db, run.botId);
  const bot: BotRef = { id: botRow.id, name: botRow.name };
  const [chat] = await ctx.db.select().from(chats).where(eq(chats.id, run.chatId));
  const [contact] = await ctx.db.select({ blocked: contacts.blocked }).from(contacts).where(eq(contacts.id, run.contactId));
  // Review Focus 2: a chat closed or a contact blocked elsewhere while the run waited gets nothing more from the bot
  if (chat.state !== 'open') return finishRun(ctx, run, bot, 'stopped', { reason: 'chat_closed' });
  if (contact.blocked) return finishRun(ctx, run, bot, 'stopped', { reason: 'contact_blocked' });
  const version = await getVersionRow(ctx.db, run.versionId);
  if (!version) return finishRun(ctx, run, bot, 'failed', { error: 'Versão do chatbot não encontrada' });
  const { nodes, edges } = version.graph;
  const edgeFrom = (nodeId: string, handle: string) => edges.find((e) => e.source === nodeId && e.sourceHandle === handle);

  const bctx: BotCtx = {
    app: ctx,
    now: ctx.botRuntime.now(),
    chat,
    bot,
    actor: { botId: bot.id, botName: bot.name, runId: run.id },
    render: async (text) => renderBotText(text, await loadBotTextVars(ctx.db, bctx.chat, run.vars)),
    lastInbound: () => lastInbound(ctx.db, run.chatId),
    startChild: (botId) =>
      startRunLocked(ctx, { botId, chatId: run.chatId, entry: 'call', startedBy: run.startedBy, parentRunId: run.id, depth: run.depth + 1 }),
    stopOtherRuns: async (otherChatId, reason) => {
      await stopRunsForChat(ctx, otherChatId, { userId: null, reason }, { exceptRunIds: await chainIds(ctx.db, run) });
    },
  };
  const at = bctx.now.toISOString();

  for (let i = 0; i < MAX_STEPS_PER_CALL; i++) {
    const node = nodes.find((n) => n.id === run.currentNodeId);
    if (!node) return finishRun(ctx, run, bot, 'failed', { error: 'Bloco não encontrado' });
    const def = ctx.botRuntime.registry[node.type];
    if (!def) return finishRun(ctx, run, bot, 'failed', { error: 'Bloco não suportado' }, { node: node.id, at, outcome: 'failed' });

    let result: BlockResult;
    let outcome: string | null = null;
    try {
      const ev = i === 0 ? resume : undefined;
      if (ev && !def.resume) throw new BlockError('Bloco não suportado');
      result = ev && def.resume ? await def.resume(bctx, run, node, ev) : await def.run(bctx, run, node);
    } catch (err) {
      const error = blockErrorMessage(err, run, node);
      if (outputsOf(node.type, node.config).some((o) => o.id === 'error') && edgeFrom(node.id, 'error')) {
        result = { next: 'error' };
        outcome = 'error';
      } else {
        result = { end: 'failed', error };
      }
    }

    if ('next' in result) {
      const s: BotRunStep = { node: node.id, at, outcome: outcome ?? result.next };
      const edge = edgeFrom(node.id, result.next);
      if (!edge) return finishRun(ctx, run, bot, 'finished', {}, s); // unconnected output = end of the flow
      run.retries = 0;
      const saved = await saveStep(ctx.db, run, s, { currentNodeId: edge.target, waitNodeId: null, wakeAt: null, timeoutAt: null, waitingSince: null });
      if (!saved) return loadRun(ctx.db, run.id); // stopped meanwhile: end silently
      run = saved;
      continue;
    }
    if ('wait' in result) {
      const set: PgUpdateSetSource<typeof botRuns> =
        result.wait === 'reply'
          ? { state: 'waiting_reply', waitNodeId: node.id, timeoutAt: result.timeoutAt, wakeAt: null, waitingSince: sql`clock_timestamp()` }
          : result.wait === 'timer'
            ? { state: 'waiting_timer', waitNodeId: node.id, wakeAt: result.wakeAt, timeoutAt: null, waitingSince: null }
            : { state: 'waiting_flow', waitNodeId: node.id, wakeAt: null, timeoutAt: null, waitingSince: null };
      return (await saveStep(ctx.db, run, { node: node.id, at, outcome: `wait:${result.wait}` }, set)) ?? loadRun(ctx.db, run.id);
    }
    const o = result.end === 'failed' ? { error: result.error } : result.end === 'stopped' ? { reason: result.reason } : {};
    return finishRun(ctx, run, bot, result.end, o, { node: node.id, at, outcome: result.end });
  }
  return finishRun(ctx, run, bot, 'failed', { error: `Limite de ${MAX_STEPS_PER_CALL} passos sem espera (possível laço)` });
}

/** Engine rule 4. Returns how many runs the reply resumed. */
export async function resumeOnReply(ctx: AppCtx, chatId: string, reply: InboundReply): Promise<number> {
  return ctx.botRuntime.withChatLock(chatId, async () => {
    // waiting_flow parents are not listed: their child gets the reply
    const waiting = await ctx.db
      .select({ id: botRuns.id })
      .from(botRuns)
      .where(and(eq(botRuns.chatId, chatId), eq(botRuns.state, 'waiting_reply')))
      .orderBy(asc(botRuns.createdAt));
    let resumed = 0;
    for (const { id } of waiting) {
      const due = await ctx.db.transaction(async (tx) => {
        const r = await lockRun(tx, id);
        // Review Focus 1: a reply stored before the question went out is not its answer.
        // ponytail: compared in JS ms; a reply stored in the same millisecond the wait began counts as an answer.
        if (!r || r.state !== 'waiting_reply' || !r.waitingSince || reply.createdAt.getTime() < r.waitingSince.getTime()) return false;
        await tx.update(botRuns).set({ state: 'running' }).where(eq(botRuns.id, id));
        return true;
      });
      if (!due) continue;
      await step(ctx, id, { kind: 'reply', reply });
      resumed += 1;
    }
    return resumed;
  });
}

/** Engine rule 5. null = the run is no longer due (already resumed, stopped, or not yet time). */
export async function resumeOnTimer(ctx: AppCtx, runId: string, now: Date): Promise<BotRunRow | null> {
  const [found] = await ctx.db.select({ chatId: botRuns.chatId }).from(botRuns).where(eq(botRuns.id, runId));
  if (!found) return null;
  return ctx.botRuntime.withChatLock(found.chatId, async () => {
    const ev = await ctx.db.transaction(async (tx): Promise<ResumeEvent | null> => {
      const r = await lockRun(tx, runId);
      if (!r) return null;
      const e: ResumeEvent | null =
        r.state === 'waiting_timer' && r.wakeAt && r.wakeAt.getTime() <= now.getTime()
          ? { kind: 'timer' }
          : r.state === 'waiting_reply' && r.timeoutAt && r.timeoutAt.getTime() <= now.getTime()
            ? { kind: 'timeout' }
            : null;
      if (e) await tx.update(botRuns).set({ state: 'running' }).where(eq(botRuns.id, runId));
      return e;
    });
    return ev ? step(ctx, runId, ev) : null;
  });
}

/** Engine rule 6. No lock: a step in flight fails its conditional save and exits. Idempotent. */
export async function stopRun(
  ctx: AppCtx,
  runId: string,
  by: { userId: string | null; reason: BotStopReason },
): Promise<BotRunRow> {
  const run = await loadRun(ctx.db, runId);
  await stopRuns(ctx, await chainIds(ctx.db, run), by);
  return loadRun(ctx.db, runId);
}

export async function stopRunsForChat(
  ctx: AppCtx,
  chatId: string,
  by: { userId: string | null; reason: BotStopReason },
  opts: { exceptRunIds?: string[] } = {},
): Promise<BotRunRow[]> {
  const except = new Set(opts.exceptRunIds ?? []);
  const ids = (await runningRunsForChat(ctx.db, chatId)).map((r) => r.id).filter((id) => !except.has(id));
  return stopRuns(ctx, ids, by);
}

/** Non-terminal runs of the chat, oldest first. */
export async function runningRunsForChat(db: Db | Tx, chatId: string): Promise<BotRunRow[]> {
  return db
    .select()
    .from(botRuns)
    .where(and(eq(botRuns.chatId, chatId), inArray(botRuns.state, ACTIVE)))
    .orderBy(asc(botRuns.createdAt));
}

/** Boot (Task 9 wires it): runs left 'running' by a dead process fail, and so do callers left waiting on them. */
export async function failInterruptedRuns(db: Db): Promise<number> {
  const error = 'Interrompido por reinício do servidor';
  return db.transaction(async (tx) => {
    const set = { state: 'failed' as const, error, finishedAt: new Date(), wakeAt: null, timeoutAt: null, waitingSince: null };
    const failed = await tx.update(botRuns).set(set).where(eq(botRuns.state, 'running')).returning();
    // A call_flow caller whose child is gone would wait forever and block its (chat, bot): fail it, level by level
    // (one UPDATE does not see rows it changes itself).
    for (;;) {
      const orphans = await tx
        .update(botRuns)
        .set(set)
        .where(
          and(
            eq(botRuns.state, 'waiting_flow'),
            sql`not exists (select 1 from bot_runs c where c.parent_run_id = bot_runs.id and c.state in ('running', 'waiting_reply', 'waiting_timer', 'waiting_flow'))`,
          ),
        )
        .returning();
      if (orphans.length === 0) break;
      failed.push(...orphans);
    }
    if (failed.length === 0) return 0;
    const names = await botNames(tx, failed);
    for (const r of failed) {
      await addEvent(tx, r.chatId, 'bot_failed', eventData({ id: r.botId, name: names.get(r.botId) ?? '' }, r.id, { reason: error }), null);
    }
    return failed.length;
  });
}

// ---------- internals ----------

async function loadRun(db: Db | Tx, runId: string): Promise<BotRunRow> {
  const row = await getRun(db, runId);
  if (!row) throw notFound('Execução não encontrada');
  return row;
}

function eventData(bot: BotRef, runId: string, extra: { reason?: string; by?: string | null } = {}) {
  return { botId: bot.id, botName: bot.name, runId, ...extra } satisfies BotEventData;
}

/**
 * Saves one step: appends to the capped step log, writes vars and retries (blocks mutate them in place) and `set`.
 * WHERE state = 'running' — null means the run was stopped meanwhile. The optional event goes in the same tx.
 * No WhatsApp send happens here: blocks send through sendSystemMessage before returning.
 */
async function saveStep(
  db: Db,
  run: BotRunRow,
  s: BotRunStep | undefined,
  set: PgUpdateSetSource<typeof botRuns>,
  event?: { kind: ChatEventKind; data: Record<string, unknown> },
): Promise<BotRunRow | null> {
  const steps = s ? [...run.steps, s].slice(-STEP_LOG_LIMIT) : run.steps;
  return db.transaction(async (tx) => {
    const [row] = await tx
      .update(botRuns)
      .set({ ...set, steps, vars: run.vars, retries: run.retries })
      .where(and(eq(botRuns.id, run.id), eq(botRuns.state, 'running')))
      .returning();
    if (!row) return null;
    if (event) await addEvent(tx, row.chatId, event.kind, event.data, null);
    return row;
  });
}

/** Engine rule 3: terminal transition of a running run, its event, the chat publish, then the waiting caller. */
async function finishRun(
  ctx: AppCtx,
  run: BotRunRow,
  bot: BotRef,
  state: Terminal,
  o: { error?: string; reason?: BotStopReason },
  s?: BotRunStep,
): Promise<BotRunRow> {
  const event =
    state === 'finished'
      ? { kind: 'bot_finished' as const, data: eventData(bot, run.id) }
      : state === 'failed'
        ? { kind: 'bot_failed' as const, data: eventData(bot, run.id, { reason: o.error }) }
        : { kind: 'bot_stopped' as const, data: eventData(bot, run.id, { reason: o.reason, by: null }) };
  const saved = await saveStep(
    ctx.db,
    run,
    s,
    { state, error: o.error ?? null, finishedAt: ctx.botRuntime.now(), wakeAt: null, timeoutAt: null, waitingSince: null },
    event,
  );
  if (!saved) return loadRun(ctx.db, run.id);
  await ctx.hub.publishChat(saved.chatId);
  await resumeParent(ctx, saved, state);
  return saved;
}

/** A call_flow caller in waiting_flow continues, under the chat lock the caller of this step already holds. */
async function resumeParent(ctx: AppCtx, child: BotRunRow, outcome: Terminal): Promise<void> {
  if (!child.parentRunId) return;
  const [parent] = await ctx.db
    .update(botRuns)
    .set({ state: 'running' })
    .where(and(eq(botRuns.id, child.parentRunId), eq(botRuns.state, 'waiting_flow')))
    .returning({ id: botRuns.id });
  if (parent) await step(ctx, parent.id, { kind: 'flow', outcome });
}

/** Stops the given runs that are still non-terminal; one bot_stopped each. Never resumes callers: the whole chain is stopped. */
async function stopRuns(ctx: AppCtx, ids: string[], by: { userId: string | null; reason: BotStopReason }): Promise<BotRunRow[]> {
  if (ids.length === 0) return [];
  const stopped = await ctx.db.transaction(async (tx) => {
    const rows = await tx
      .update(botRuns)
      .set({ state: 'stopped', finishedAt: ctx.botRuntime.now(), wakeAt: null, timeoutAt: null, waitingSince: null })
      .where(and(inArray(botRuns.id, ids), inArray(botRuns.state, ACTIVE)))
      .returning();
    if (rows.length === 0) return rows;
    const names = await botNames(tx, rows);
    for (const r of rows) {
      const data = eventData({ id: r.botId, name: names.get(r.botId) ?? '' }, r.id, { reason: by.reason, by: by.userId });
      await addEvent(tx, r.chatId, 'bot_stopped', data, by.userId);
    }
    return rows;
  });
  for (const chatId of new Set(stopped.map((r) => r.chatId))) await ctx.hub.publishChat(chatId);
  return stopped;
}

/** The run's call_flow chain: its root (walking up parentRunId) plus every descendant. */
async function chainIds(db: Db | Tx, run: BotRunRow): Promise<string[]> {
  // ponytail: loads every run of the chat, terminal ones too; use a recursive CTE if chats collect thousands of runs.
  const all = await db.select({ id: botRuns.id, parentRunId: botRuns.parentRunId }).from(botRuns).where(eq(botRuns.chatId, run.chatId));
  const parentOf = new Map(all.map((r) => [r.id, r.parentRunId]));
  let root = run.id;
  for (let p = parentOf.get(root); p; p = parentOf.get(p)) root = p;
  const ids = [root];
  for (let i = 0; i < ids.length; i++) for (const r of all) if (r.parentRunId === ids[i]) ids.push(r.id);
  return ids;
}

async function botNames(db: Db | Tx, rows: BotRunRow[]): Promise<Map<string, string>> {
  const list = await db
    .select({ id: bots.id, name: bots.name })
    .from(bots)
    .where(inArray(bots.id, [...new Set(rows.map((r) => r.botId))]));
  return new Map(list.map((b) => [b.id, b.name]));
}

async function lastInbound(db: Db, chatId: string): Promise<InboundReply | null> {
  const [m] = await db
    .select({
      messageId: messages.id,
      kind: messages.kind,
      body: messages.body,
      mediaMime: messages.mediaMime,
      mediaName: messages.mediaName,
      createdAt: messages.createdAt,
    })
    .from(messages)
    .where(and(eq(messages.chatId, chatId), eq(messages.direction, 'in')))
    .orderBy(desc(messages.createdAt))
    .limit(1);
  // Same text ingest hands to resumeOnReply: an agent signature in front is not part of the answer.
  return m ? { ...m, body: m.body === null ? null : stripSignature(m.body) } : null;
}

/** BlockError messages are safe to show; anything else may carry contact data, so only its name and code are logged. */
function blockErrorMessage(err: unknown, run: BotRunRow, node: BotNode): string {
  if (err instanceof BlockError) return err.message;
  const e = err as { name?: unknown; code?: unknown } | null;
  console.error('erro inesperado em bloco de chatbot', { runId: run.id, nodeId: node.id, type: node.type, name: e?.name, code: e?.code });
  return `Erro inesperado no bloco "${catalogEntry(node.type).label}"`;
}
