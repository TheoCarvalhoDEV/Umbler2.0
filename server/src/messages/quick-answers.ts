import { eq } from 'drizzle-orm';
import type { Db, Tx } from '../db/client.js';
import { contactFieldValues, contacts, customFields } from '../db/schema.js';
import type { ChatRow } from '../inbox/chats.js';
import type { AuthUser } from '../inbox/visibility.js';
// Spec §5.7: named variables in quick answers, plus conversion of Umbler's positional {{n}}.
// Chatbot spec 2a §5.3: bots render with this same function plus the `contexto` group.
export interface QuickAnswerVars {
  atendente: { nome: string; primeiro_nome: string; email: string };
  contato: { nome: string; primeiro_nome: string; telefone: string; email: string };
  campo: Record<string, string>;
}

// "Número do Processo" -> "numero_do_processo". Names are compared in this form, so
// {{campo.CPF}}, {{campo.cpf}} and {{ Campo.Cpf }} all hit the field named "CPF".
function slug(s: string): string {
  return s
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

const NAMED_VAR = /\{\{\s*([^{}.]+)\.([^{}]+?)\s*\}\}/g;

// Later entries win on a slug collision (contextoVars relies on this).
const slugged = (r: Record<string, string>) => new Map(Object.entries(r).map(([k, v]) => [slug(k), v]));

export function renderQuickAnswer(body: string, vars: QuickAnswerVars & { contexto?: Record<string, string> }): string {
  const groups = new Map<string, Map<string, string>>([
    ['atendente', new Map(Object.entries(vars.atendente))],
    ['contato', new Map(Object.entries(vars.contato))],
    ['campo', slugged(vars.campo)],
  ]);
  // Only bots pass contexto; for quick answers {{contexto.x}} stays literal as before.
  if (vars.contexto) groups.set('contexto', slugged(vars.contexto));
  return body.replace(NAMED_VAR, (match, group: string, name: string) => {
    const values = groups.get(slug(group));
    // Not one of our groups (e.g. text that merely looks like a variable): leave it.
    return values ? (values.get(slug(name)) ?? '') : match;
  });
}

export function firstName(s: string): string {
  return s.trim().split(/\s+/)[0] ?? '';
}

/** Vars of a chat: its contact, the contact's custom fields (keyed by field name) and the given atendente. */
export async function buildChatVars(
  db: Db | Tx,
  chat: Pick<ChatRow, 'contactId'>,
  atendente: Pick<AuthUser, 'name' | 'email'> | null,
): Promise<QuickAnswerVars> {
  const [contact] = await db.select().from(contacts).where(eq(contacts.id, chat.contactId));
  const fieldRows = await db
    .select({ name: customFields.name, value: contactFieldValues.value })
    .from(contactFieldValues)
    .innerJoin(customFields, eq(customFields.id, contactFieldValues.fieldId))
    .where(eq(contactFieldValues.contactId, chat.contactId));
  const contactName = contact?.name ?? '';
  return {
    atendente: atendente
      ? { nome: atendente.name, primeiro_nome: firstName(atendente.name), email: atendente.email }
      : { nome: '', primeiro_nome: '', email: '' },
    contato: {
      nome: contactName,
      primeiro_nome: firstName(contactName),
      telefone: contact?.phone ?? '',
      email: contact?.email ?? '',
    },
    campo: Object.fromEntries(fieldRows.map((f) => [f.name, f.value])),
  };
}

const ENTITY = new Map([
  ['atendente', 'atendente'],
  ['agente', 'atendente'],
  ['agent', 'atendente'],
  ['member', 'atendente'],
  ['organizationmember', 'atendente'],
  ['contato', 'contato'],
  ['contact', 'contato'],
]);
const ATTR = new Map([
  ['nomecompleto', 'nome'],
  ['nome', 'nome'],
  ['name', 'nome'],
  ['fullname', 'nome'],
  ['primeironome', 'primeiro_nome'],
  ['firstname', 'primeiro_nome'],
  ['email', 'email'],
  ['numero', 'telefone'],
  ['telefone', 'telefone'],
  ['celular', 'telefone'],
  ['phone', 'telefone'],
  ['phonenumber', 'telefone'],
]);
const FIELD_PREFIX = new Set(['campo', 'campos', 'campopersonalizado', 'campospersonalizados', 'customfield', 'customfields']);
const compact = (s: string) => slug(s).replace(/_/g, '');

// ponytail: matches the defaultValue shapes seen in Umbler's UI ("Contato.PrimeiroNome") and API
// ("{{Contact.FirstName}}"). Task 20's report lists anything else, so add shapes when it shows them.
function umblerToNamed(defaultValue: string): string | null {
  const v = defaultValue.trim().replace(/^\{\{\s*|\s*\}\}$/g, '');
  const dot = v.indexOf('.');
  if (dot <= 0) return null;
  const prefix = compact(v.slice(0, dot));
  const rest = v.slice(dot + 1).trim();
  if (!rest) return null;
  if (FIELD_PREFIX.has(prefix)) return `campo.${rest}`;
  const entity = ENTITY.get(prefix);
  const attr = ATTR.get(compact(rest));
  if (!entity || !attr || (attr === 'telefone' && entity !== 'contato')) return null;
  return `${entity}.${attr}`;
}

export function convertUmblerVariables(
  body: string,
  variables: Array<{ defaultValue: string }>,
): { body: string; unmapped: string[] } {
  const unmapped = new Set<string>();
  const out = body.replace(/\{\{\s*(\d+)\s*\}\}/g, (match, n: string) => {
    const dv = variables[Number(n) - 1]?.defaultValue?.trim();
    if (!dv) {
      unmapped.add(match);
      return match;
    }
    const named = umblerToNamed(dv);
    if (named) return `{{${named}}}`;
    unmapped.add(dv);
    return dv;
  });
  return { body: out, unmapped: [...unmapped] };
}
