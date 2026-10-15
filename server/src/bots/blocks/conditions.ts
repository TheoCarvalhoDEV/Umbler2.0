import { and, count, eq, gte, inArray } from 'drizzle-orm';
import {
  DEFAULT_TIMEZONE,
  NON_TERMINAL_RUN_STATES,
  type BotNode,
  type ChatAgentConfig,
  type ChatChannelConfig,
  type ChatSectorConfig,
  type ConditionConfig,
  type ContactFieldConfig,
  type DistributeConfig,
  type HoursConfig,
  type Logic,
  type MessageContainsConfig,
  type MultiConditionConfig,
  type NativeFieldId,
  type Operand,
  type Rule,
  type RuleOperator,
  type TagsConfig,
  type TimeUnit,
  type ValueConfig,
  type WaitIntervalConfig,
  type Weekday,
  type WeekdaysConfig,
} from '@talk/shared';
import { botRuns, chats, contactFieldValues, contactTags, contacts, messages } from '../../db/schema.js';
import { normalize } from '../../triage/triage.js';
import type { BotRunRow } from '../repo.js';
// Type-only on purpose: registry.ts imports this file at runtime for defaultRegistry, so a value import back would be a cycle.
// That is also why failures here return { end: 'failed' } instead of throwing BlockError (these blocks have no error output).
import type { BlockRegistry, BlockResult, BotCtx } from '../registry.js';

const conf = <T>(node: BotNode): T => node.config as unknown as T;
const yesNo = (ok: boolean): BlockResult => ({ next: ok ? 'yes' : 'no' });

/** Number() after trim and ',' → '.'; empty text is not a number. */
function toNumber(s: string): number {
  const t = s.trim().replace(',', '.');
  return t === '' ? Number.NaN : Number(t);
}

/** Numeric when both sides are numbers, else normalize()d text. contains / not_contains / starts always compare text. */
export function compareValues(left: string, op: RuleOperator, right: string): boolean {
  const order = (): number => {
    const a = toNumber(left);
    const b = toNumber(right);
    if (Number.isFinite(a) && Number.isFinite(b)) return Math.sign(a - b);
    const x = normalize(left);
    const y = normalize(right);
    return x < y ? -1 : x > y ? 1 : 0;
  };
  switch (op) {
    case 'empty': return left.trim() === '';
    case 'not_empty': return left.trim() !== '';
    case 'contains': return normalize(left).includes(normalize(right));
    case 'not_contains': return !normalize(left).includes(normalize(right));
    case 'starts': return normalize(left).startsWith(normalize(right));
    case 'eq': return order() === 0;
    case 'neq': return order() !== 0;
    case 'gt': return order() > 0;
    case 'gte': return order() >= 0;
    case 'lt': return order() < 0;
    case 'lte': return order() <= 0;
  }
}

/** Current value of a contact field: a NativeFieldId reads `contacts` (city/state from address), anything else is a custom field id. */
async function contactFieldValue(ctx: BotCtx, fieldId: string): Promise<string> {
  const contactId = ctx.chat.contactId;
  if (fieldId.startsWith('native:')) {
    const [c] = await ctx.app.db
      .select({ name: contacts.name, email: contacts.email, landline: contacts.landline, address: contacts.address })
      .from(contacts)
      .where(eq(contacts.id, contactId));
    if (!c) return '';
    const native: Record<NativeFieldId, string | null | undefined> = {
      'native:name': c.name,
      'native:email': c.email,
      'native:landline': c.landline,
      'native:city': c.address?.city,
      'native:state': c.address?.state,
    };
    return native[fieldId as NativeFieldId] ?? '';
  }
  const [row] = await ctx.app.db
    .select({ value: contactFieldValues.value })
    .from(contactFieldValues)
    .where(and(eq(contactFieldValues.contactId, contactId), eq(contactFieldValues.fieldId, fieldId)));
  return row?.value ?? '';
}

/** var → run.vars[name].value ('<name>:raw' → .raw; missing → ''), field → contact's current value, literal → rendered text. */
export async function operandValue(ctx: BotCtx, run: BotRunRow, o: Operand): Promise<string> {
  if (o.kind === 'literal') return ctx.render(o.value);
  if (o.kind === 'field') return contactFieldValue(ctx, o.value);
  const [name = '', part] = o.value.split(':');
  const found = run.vars[name];
  return (part === 'raw' ? found?.raw : found?.value) ?? '';
}

export async function evalRule(ctx: BotCtx, run: BotRunRow, r: Rule): Promise<boolean> {
  const left = await operandValue(ctx, run, r.left);
  const needsRight = r.operator !== 'empty' && r.operator !== 'not_empty';
  const right = needsRight && r.right ? await operandValue(ctx, run, r.right) : '';
  return compareValues(left, r.operator, right);
}

/** and: stops at the first false; or: stops at the first true. No rules: and → true, or → false. */
async function evalRules(ctx: BotCtx, run: BotRunRow, logic: Logic, rules: Rule[] = []): Promise<boolean> {
  for (const r of rules) {
    const ok = await evalRule(ctx, run, r);
    if (logic === 'or' ? ok : !ok) return ok;
  }
  return logic !== 'or';
}

const DAY_MS = 86_400_000;
const UNIT_MS: Record<TimeUnit, number> = { seconds: 1_000, minutes: 60_000, hours: 3_600_000, days: DAY_MS };

/** Weekday and minutes since midnight of `d` in `timeZone`. Throws RangeError on an unknown zone (validateGraph rejects those). */
export function zonedParts(d: Date, timeZone: string): { weekday: Weekday; minutes: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(d);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? '';
  return {
    weekday: part('weekday').toLowerCase() as Weekday, // 'Wed' → 'wed'
    minutes: (Number(part('hour')) % 24) * 60 + Number(part('minute')),
  };
}

/** 'HH:MM' → minutes since midnight (NaN when malformed, which matches no interval). */
function hhmm(s: string): number {
  const [h = '', m = ''] = s.split(':');
  return Number(h) * 60 + Number(m);
}

export const conditionBlocks: BlockRegistry = {
  condition: {
    type: 'condition',
    run: async (ctx, run, node) => {
      const c = conf<ConditionConfig>(node);
      return yesNo(await evalRules(ctx, run, c.logic, c.rules));
    },
  },
  multi_condition: {
    type: 'multi_condition',
    run: async (ctx, run, node) => {
      const cases = conf<MultiConditionConfig>(node).cases ?? [];
      for (const [i, k] of cases.entries()) {
        if (await evalRules(ctx, run, k.logic, k.rules)) return { next: `case:${i}` };
      }
      return { next: 'else' };
    },
  },
  value: {
    type: 'value',
    run: async (ctx, run, node) => yesNo(await evalRule(ctx, run, conf<ValueConfig>(node))),
  },
  contact_field: {
    type: 'contact_field',
    run: async (ctx, run, node) => {
      const c = conf<ContactFieldConfig>(node);
      const rule: Rule = { left: { kind: 'field', value: c.fieldId }, operator: c.operator, right: { kind: 'literal', value: c.value } };
      return yesNo(await evalRule(ctx, run, rule));
    },
  },
  distribute: {
    type: 'distribute',
    run: async (ctx, _run, node) => {
      const weights = (conf<DistributeConfig>(node).branches ?? []).map((b) => Math.max(0, b.weight));
      const total = weights.reduce((sum, w) => sum + w, 0);
      if (!(total > 0)) return { end: 'failed', error: 'O bloco "Distribuir" não tem caminhos com peso' };
      const pick = ctx.app.botRuntime.random() * total;
      let acc = 0;
      for (const [i, w] of weights.entries()) {
        acc += w;
        if (pick < acc) return { next: `branch:${i}` };
      }
      return { next: `branch:${weights.length - 1}` }; // random() < 1, so only float rounding lands here
    },
  },
  contact_active: {
    type: 'contact_active',
    run: async (ctx) => {
      const since = new Date(ctx.now.getTime() - DAY_MS);
      const [hit] = await ctx.app.db
        .select({ id: messages.id })
        .from(messages)
        .innerJoin(chats, eq(chats.id, messages.chatId))
        .where(
          and(
            eq(chats.contactId, ctx.chat.contactId),
            eq(messages.channelId, ctx.chat.channelId),
            eq(messages.direction, 'in'),
            gte(messages.sentAt, since),
          ),
        )
        .limit(1);
      return yesNo(hit !== undefined);
    },
  },
  first_chat: {
    type: 'first_chat',
    run: async (ctx) => {
      const [{ n }] = await ctx.app.db
        .select({ n: count() })
        .from(chats)
        .where(and(eq(chats.contactId, ctx.chat.contactId), eq(chats.channelId, ctx.chat.channelId)));
      return yesNo(n === 1);
    },
  },
  tags: {
    type: 'tags',
    run: async (ctx, _run, node) => {
      const c = conf<TagsConfig>(node);
      const wanted = c.tagIds ?? [];
      const rows = await ctx.app.db
        .select({ tagId: contactTags.tagId })
        .from(contactTags)
        .where(eq(contactTags.contactId, ctx.chat.contactId));
      const has = new Set(rows.map((r) => r.tagId));
      const hits = wanted.filter((id) => has.has(id)).length;
      if (c.mode === 'all') return yesNo(hits === wanted.length);
      if (c.mode === 'none') return yesNo(hits === 0);
      return yesNo(hits > 0);
    },
  },
  chat_sector: {
    type: 'chat_sector',
    run: async (ctx, _run, node) => yesNo((conf<ChatSectorConfig>(node).sectorIds ?? []).includes(ctx.chat.sectorId)),
  },
  chat_channel: {
    type: 'chat_channel',
    run: async (ctx, _run, node) => yesNo((conf<ChatChannelConfig>(node).channelIds ?? []).includes(ctx.chat.channelId)),
  },
  chat_agent: {
    type: 'chat_agent',
    run: async (ctx, _run, node) => {
      const c = conf<ChatAgentConfig>(node);
      const owner = ctx.chat.ownerId;
      if (c.mode === 'none') return yesNo(owner === null);
      if (c.mode === 'any') return yesNo(owner !== null);
      return yesNo(owner !== null && (c.userIds ?? []).includes(owner));
    },
  },
  chat_status: {
    type: 'chat_status',
    run: async (ctx) => yesNo(ctx.chat.waiting),
  },
  message_contains: {
    type: 'message_contains',
    run: async (ctx, _run, node) => {
      const c = conf<MessageContainsConfig>(node);
      const words = (c.keywords ?? []).map((k) => normalize(k)).filter((k) => k !== '');
      const body = (await ctx.lastInbound())?.body;
      if (!body || words.length === 0) return yesNo(false);
      const text = normalize(body);
      return yesNo(c.match === 'all' ? words.every((w) => text.includes(w)) : words.some((w) => text.includes(w)));
    },
  },
  parallel_bot: {
    type: 'parallel_bot',
    run: async (ctx, run) => {
      const active = await ctx.app.db
        .select({ id: botRuns.id, parentRunId: botRuns.parentRunId })
        .from(botRuns)
        .where(and(eq(botRuns.chatId, ctx.chat.id), inArray(botRuns.state, [...NON_TERMINAL_RUN_STATES])));
      // Ancestors that matter are non-terminal (waiting_flow), so walking the active rows is enough.
      const byId = new Map(active.map((r) => [r.id, r.parentRunId]));
      const chain = new Set([run.id]);
      for (let p = run.parentRunId; p && !chain.has(p); p = byId.get(p) ?? null) chain.add(p);
      return yesNo(active.some((r) => !chain.has(r.id)));
    },
  },
  weekdays: {
    type: 'weekdays',
    run: async (ctx, _run, node) => {
      const { weekday } = zonedParts(ctx.now, conf<WeekdaysConfig>(node).timezone || DEFAULT_TIMEZONE);
      return { next: `day:${weekday}` };
    },
  },
  hours: {
    type: 'hours',
    run: async (ctx, _run, node) => {
      const c = conf<HoursConfig>(node);
      const { weekday, minutes } = zonedParts(ctx.now, c.timezone || DEFAULT_TIMEZONE);
      const inside = (c.intervals ?? []).some(
        (i) => (!i.days || i.days.includes(weekday)) && minutes >= hhmm(i.from) && minutes < hhmm(i.to), // `to` exclusive
      );
      return { next: inside ? 'in' : 'out' };
    },
  },
  wait_interval: {
    type: 'wait_interval',
    run: async (ctx, _run, node) => {
      const c = conf<WaitIntervalConfig>(node);
      const amount = c.mode === 'variable' ? toNumber(await ctx.render(c.variable ?? '')) : c.amount;
      const ms = amount * UNIT_MS[c.unit];
      const wake = new Date(ctx.now.getTime() + ms);
      if (!(ms > 0) || Number.isNaN(wake.getTime())) {
        return { end: 'failed', error: 'O tempo de espera precisa ser um número maior que zero' };
      }
      return c.resumeOnReply ? { wait: 'reply', timeoutAt: wake } : { wait: 'timer', wakeAt: wake };
    },
    // timer (plain wait) and timeout (resumeOnReply, nobody answered) both mean the time ran out.
    resume: async (_ctx, _run, _node, ev) => ({ next: ev.kind === 'reply' ? 'replied' : 'next' }),
  },
};
