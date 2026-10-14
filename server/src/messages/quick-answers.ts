// Spec §5.7: named variables in quick answers, plus conversion of Umbler's positional {{n}}.
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

export function renderQuickAnswer(body: string, vars: QuickAnswerVars): string {
  const groups = new Map<string, Map<string, string>>([
    ['atendente', new Map(Object.entries(vars.atendente))],
    ['contato', new Map(Object.entries(vars.contato))],
    ['campo', new Map(Object.entries(vars.campo).map(([k, v]) => [slug(k), v]))],
  ]);
  return body.replace(NAMED_VAR, (match, group: string, name: string) => {
    const values = groups.get(slug(group));
    // Not one of our groups (e.g. text that merely looks like a variable): leave it.
    return values ? (values.get(slug(name)) ?? '') : match;
  });
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
