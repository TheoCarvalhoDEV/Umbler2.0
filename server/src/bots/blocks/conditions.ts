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
};
