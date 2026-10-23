import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';

// A fake Umbler Talk API on a random local port (spec 2026-10-21 importar-umbler §14), with the shapes of
// docs/umbler/utalk-openapi-v1.json, plus /s3/<name> in the role of the file links. It records every request; every
// test ends with expect(fake.problems()).toEqual([]). Never a real call.

export const ORG = 'ORG_TESTE_00001';
type Obj = Record<string, unknown>;

export interface FakeRequest { method: string; path: string; query: URLSearchParams; auth: string | null }
/** The next `times` (default 1) requests whose path matches answer `status`; Infinity = always. */
export interface Fault { path: RegExp; status: number; times?: number; retryAfter?: string; location?: string }
export interface FakeFile { body: Buffer; mime: string; status?: number; delayMs?: number }

export interface UmblerWorld {
  me: Obj;
  organization: Obj;
  channels: Obj[];
  sectors: Obj[];
  tags: Obj[];
  fieldDefs: Obj[];
  quickAnswers: Obj[];
  contacts: Obj[];
  /** GET /v1/contacts/{id}/custom-fields/ (the §4.1 fallback) */
  contactFields: Record<string, Obj[]>;
  notes: Record<string, Obj[]>;
  chats: Obj[];
  /** by chat id */
  messages: Record<string, Obj[]>;
  files: Record<string, FakeFile>;
  maxTake: number;
  /** added to page.totalItems (Behavior=CountAllAndGetSlice): an Umbler count that disagrees with its own list */
  totalBias: number;
  /** the contact list ignores includeCustomFields */
  omitCustomFields: boolean;
  planLimited: boolean;
  /** reading this chat's messages marks it as read in Umbler (the risk of §5): lastMessage → Read, totalUnread → 0 */
  marksRead: string | null;
}

export const MEMBERS = {
  ana: { _t: 'OrganizationHumanAgentReferenceModel', id: 'M_ANA', displayName: 'Ana Umbler', emailAddress: 'ANA@teste.local', active: true },
  carla: { _t: 'OrganizationHumanAgentReferenceModel', id: 'M_CARLA', displayName: 'Carla Antiga', emailAddress: 'carla@antigo.test', active: false },
  robo: { _t: 'OrganizationAIAgentReferenceModel', id: 'M_IA', displayName: 'Assistente', active: true },
};
export const PDF = Buffer.from('%PDF-1.4 anexo sintetico');

function defaultWorld(fileUrl: (name: string) => string): UmblerWorld {
  const tagRef = (id: string, name: string) => ({ _t: 'SimpleTagReferenceModel', id, name });
  return {
    me: {
      _t: 'HumanOrganizationAgentModel',
      id: 'M_ANA',
      emailAddress: 'ana@teste.local',
      organizations: [
        {
          _t: 'OrganizationReferenceForHumanAgentModel', id: ORG, name: 'Escritório Teste', active: true, permissions: ['Owner'],
          allowedSectors: { allSectorsEnable: true, sectors: [] }, allowedChannels: { allChannelsEnable: true, channels: [] },
        },
      ],
    },
    organization: {
      _t: 'SimpleOrganizationModel', id: ORG, name: 'Escritório Teste', maxDaysMessageHistoric: null,
      organizationMembers: [MEMBERS.ana, MEMBERS.carla, MEMBERS.robo],
    },
    channels: [
      { _t: 'OrganizationBrokerWhatsappChannelReferenceModel', id: 'CH_WA', name: 'WhatsApp Umbler', state: 'Live', phoneNumber: '+5565999990000' },
      { _t: 'OrganizationWebsiteWidgetChannelReferenceModel', id: 'CH_WEB', name: 'Site', state: 'Live' },
    ],
    sectors: [
      { _t: 'SectorReferenceModel', id: 'SEC1', name: 'Atendimento', default: true, order: 0, groupIds: [] },
      { _t: 'SectorReferenceModel', id: 'SEC2', name: ' FINANCEIRO ', default: false, order: 1, groupIds: [] },
      { _t: 'SectorReferenceModel', id: 'SEC3', name: 'Trabalhista', default: false, order: 2, groupIds: [] },
    ],
    tags: [
      { _t: 'TagModel', id: 'TAG1', name: 'Cliente', emoji: '⭐', color: 'Gold', order: 0, groupIds: [] },
      { _t: 'TagModel', id: 'TAG2', name: 'Prospecção', emoji: null, color: 'Blue', order: 1, groupIds: [] },
    ],
    fieldDefs: [
      { _t: 'CPFCustomFieldDefinitionModel', id: 'CF1', name: 'CPF' },
      { _t: 'DateCustomFieldDefinitionModel', id: 'CF2', name: 'Nascimento' },
      { _t: 'LogicCustomFieldDefinitionModel', id: 'CF3', name: 'Aceitou termos' },
    ],
    quickAnswers: [
      {
        _t: 'QuickAnswerModel', id: 'QA1', name: 'Boas-vindas', content: 'Olá {{1}}, aqui é {{2}}.', organizationMember: null,
        variables: [{ name: 'nome', defaultValue: 'Contato.PrimeiroNome' }, { name: 'assinatura', defaultValue: 'Valor fixo qualquer' }],
        attachment: null,
      },
      {
        _t: 'QuickAnswerModel', id: 'QA2', name: 'Procuração', content: 'Segue a procuração.', organizationMember: { id: 'M_ANA' },
        variables: [], attachment: { fileId: 'F1', fileType: 'File', url: fileUrl('procuracao.pdf'), originalName: 'procuracao.pdf' },
      },
    ],
    contacts: [
      {
        _t: 'SimpleContactModel', id: 'C1', name: 'Maria Teste', phoneNumber: '+55 65 9999-8888', lid: null, email: 'maria@example.test',
        landline: null, address: { addressLine1: 'Rua das Flores, 100', city: 'Cuiabá', state: 'MT', zipCode: null }, isBlocked: false,
        tags: [tagRef('TAG1', 'Cliente')],
        customFields: [
          { _t: 'ContactCPFCustomFieldModel', customFieldDefinitionId: 'CF1', value: '000.000.000-00' },
          { _t: 'ContactDateCustomFieldModel', customFieldDefinitionId: 'CF2', value: '1990-05-17T00:00:00Z' },
          { _t: 'ContactLogicCustomFieldModel', customFieldDefinitionId: 'CF3', value: true },
        ],
      },
      {
        _t: 'SimpleContactModel', id: 'C2', name: 'João Teste', phoneNumber: '5565988887777', lid: '201234567890123', isBlocked: true,
        tags: [tagRef('TAG1', 'Cliente'), tagRef('TAG2', 'Prospecção')], customFields: [],
      },
      { _t: 'SimpleContactModel', id: 'C3', name: 'Só LID', phoneNumber: '123', lid: '209999999999999@lid', isBlocked: false, tags: [], customFields: [] },
      { _t: 'SimpleContactModel', id: 'C4', name: 'Sem Número', phoneNumber: null, lid: null, isBlocked: false, tags: [], customFields: [] },
    ],
    contactFields: {},
    notes: {},
    chats: [],
    messages: {},
    files: { 'procuracao.pdf': { body: PDF, mime: 'application/pdf' } },
    maxTake: 50,
    totalBias: 0,
    omitCustomFields: false,
    planLimited: false,
    marksRead: null,
  };
}

let seq = 0;
/** A BasicChatModel: Maria (C1) on the WhatsApp channel, sector Financeiro, owner Ana, open. */
export function umblerChat(over: Obj = {}): Obj {
  seq += 1;
  return {
    _t: 'BasicChatModel', id: `CHAT${seq}`, createdAtUTC: '2026-09-01T12:00:00Z',
    contact: { _t: 'ContactReferenceModel', id: 'C1', name: 'Maria Teste', phoneNumber: '+5565999998888', lid: null, contactType: 'DirectMessage' },
    channel: { _t: 'ChatBrokerWhatsappChannelReferenceModel', id: 'CH_WA', name: 'WhatsApp Umbler', phoneNumber: '+5565999990000' },
    sector: { _t: 'SectorReferenceModel', id: 'SEC2', name: 'Financeiro' },
    organizationMember: { _t: 'ChatAgentReferenceModel', id: 'M_ANA' },
    tags: [], open: true, private: false, waiting: false, waitingSinceUTC: null, totalUnread: 0, closedAtUTC: null, closedBy: null,
    redactReason: null, lastMessage: null, visibility: 'Show',
    ...over,
  };
}

/** A MessageModel from the contact, read, text "texto <id>". */
export function umblerMessage(id: string, at: string, over: Obj = {}): Obj {
  return {
    _t: 'MessageModel', id, createdAtUTC: at, eventAtUTC: at, chat: { _t: 'ChatIdReferenceModel', id: 'X' }, source: 'Contact',
    isPrivate: false, messageType: 'Text', content: `texto ${id}`, prefix: null, file: null, messageState: 'Read', reactions: [],
    contacts: [], sentByOrganizationMember: null, inReplyTo: null, latestEdit: null, location: null,
    ...over,
  };
}

const json = (res: ServerResponse, body: unknown, status = 200) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

export async function startFakeUmbler() {
  const requests: FakeRequest[] = [];
  const faults: Fault[] = [];
  let concurrentFiles = 0;
  const stats = { maxConcurrentFiles: 0 };
  let origin = '';
  const fileUrl = (name: string) => `${origin}/s3/${name}`;
  const server = createServer((req, res) => void handle(req, res));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const world = defaultWorld(fileUrl);

  const page = (url: URL, items: Obj[]) => {
    const skip = Number(url.searchParams.get('Skip') ?? '0');
    const take = Math.min(Number(url.searchParams.get('Take') ?? '50'), world.maxTake);
    const slice = items.slice(skip, skip + take);
    const totalItems = url.searchParams.get('Behavior') === 'CountAllAndGetSlice' ? items.length + world.totalBias : 0;
    return { page: { totalItems, skipped: skip, took: slice.length, maxTake: world.maxTake }, items: slice };
  };
  const byState = (state: string | null, list: Obj[]) =>
    state === 'Closed' ? list.filter((c) => c.open === false) : state === 'All' ? list : list.filter((c) => c.open !== false);

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', origin);
    const p = url.pathname;
    requests.push({ method: req.method ?? '', path: p, query: url.searchParams, auth: req.headers.authorization ?? null });
    const fault = faults.find((f) => f.path.test(p) && (f.times ?? 1) > 0);
    if (fault) {
      fault.times = (fault.times ?? 1) - 1;
      res.writeHead(fault.status, {
        'content-type': 'application/json',
        ...(fault.retryAfter ? { 'retry-after': fault.retryAfter } : {}),
        ...(fault.location ? { location: fault.location } : {}),
      });
      res.end('{}');
      return;
    }
    if (p.startsWith('/s3/')) {
      const file = world.files[decodeURIComponent(p.slice(4))];
      if (!file) return json(res, { error: 'NoSuchKey' }, 404);
      concurrentFiles += 1;
      stats.maxConcurrentFiles = Math.max(stats.maxConcurrentFiles, concurrentFiles);
      if (file.delayMs) await delay(file.delayMs);
      concurrentFiles -= 1;
      res.writeHead(file.status ?? 200, { 'content-type': file.mime });
      res.end(file.body);
      return;
    }
    const q = url.searchParams;
    const orgOk = q.get('organizationId') === ORG;
    let m: RegExpExecArray | null;
    if (p === '/api/v1/members/me/') return json(res, world.me);
    if (p === `/api/v1/organizations/${ORG}/`) return json(res, world.organization);
    if (!orgOk) return json(res, { error: 'organizationId' }, 400);
    if (p === '/api/v1/channels/') return json(res, world.channels);
    if (p === '/api/v1/sectors/') return json(res, world.sectors);
    if (p === '/api/v1/tags/') return json(res, page(url, world.tags));
    if (p === '/api/v1/custom-field-definitions/') return json(res, world.fieldDefs);
    if (p === '/api/v1/quick-answers/') return json(res, page(url, world.quickAnswers));
    if ((m = /^\/api\/v1\/quick-answers\/([^/]+)\/$/.exec(p))) {
      const qa = world.quickAnswers.find((x) => x.id === m![1]);
      return qa ? json(res, qa) : json(res, { error: 'not found' }, 404);
    }
    if (p === '/api/v1/contacts/') {
      const asked = q.getAll('includeCustomFields');
      const list = world.contacts.map((c) => {
        if (world.omitCustomFields || asked.length === 0) {
          const { customFields: _cf, ...rest } = c;
          return rest;
        }
        return c;
      });
      return json(res, page(url, list));
    }
    if ((m = /^\/api\/v1\/contacts\/([^/]+)\/custom-fields\/$/.exec(p))) return json(res, world.contactFields[m[1]!] ?? []);
    if ((m = /^\/api\/v1\/contacts\/([^/]+)\/notes\/$/.exec(p))) {
      const notes = world.notes[m[1]!];
      return notes ? json(res, notes) : json(res, { error: 'not found' }, 404);
    }
    if ((m = /^\/api\/v1\/contacts\/([^/]+)\/chats\/$/.exec(p))) {
      const id = m[1];
      const mine = world.chats.filter((c) => (c.contact as Obj).id === id);
      return json(res, page(url, byState(q.get('ChatState') ?? 'All', mine)));
    }
    if (p === '/api/v1/chats/') {
      // §4: the importer must ask for direct chats, hidden ones too, without pinned ones mixed in, in the spec's order
      const state = q.get('ChatState');
      const order = state === 'Closed' ? 'ClosedAtUTC/Desc' : 'CreatedAtUTC/Asc';
      const ok =
        q.getAll('ContactTypes').join() === 'DirectMessage' &&
        q.getAll('Visibility').sort().join() === 'Hide,HideUntilNextMessage,Show' &&
        q.get('IncludePinneds') === 'false' &&
        `${q.get('ChatOrderBy')}/${q.get('Order')}` === order;
      if (!ok) return json(res, { error: 'unexpected chat query' }, 400);
      const list = [...byState(state ?? 'Open', world.chats)].sort((a, b) =>
        state === 'Closed'
          ? String(b.closedAtUTC).localeCompare(String(a.closedAtUTC))
          : String(a.createdAtUTC).localeCompare(String(b.createdAtUTC)),
      );
      return json(res, page(url, list));
    }
    if ((m = /^\/api\/v1\/chats\/([^/]+)\/relative-messages\/$/.exec(p))) {
      const chatId = m[1]!;
      const take = Number(q.get('Take'));
      if (!(take >= 1 && take <= 250) || q.get('Direction') !== 'TakeAfter' || q.get('IncludeMetadata') !== 'false') {
        return json(res, { error: 'bad relative-messages query' }, 400);
      }
      const all = world.messages[chatId];
      if (!all) return json(res, { error: 'not found' }, 404);
      const from = Date.parse(q.get('FromEventUTC') ?? '');
      const list = [...all]
        .sort((a, b) => Date.parse(String(a.eventAtUTC)) - Date.parse(String(b.eventAtUTC)))
        .filter((x) => Date.parse(String(x.eventAtUTC)) >= from) // inclusive
        .slice(0, take);
      if (world.marksRead === chatId) {
        const chat = world.chats.find((c) => c.id === chatId);
        if (chat) Object.assign(chat, { totalUnread: 0, lastMessage: { ...(chat.lastMessage as Obj), messageState: 'Read' } });
      }
      return json(res, { hasMessagesBeforeAllowedOrganizationPlan: world.planLimited, messages: list });
    }
    return json(res, { error: 'not found' }, 404);
  }

  return {
    world,
    requests,
    faults,
    stats,
    baseUrl: `${origin}/api`,
    fileUrl,
    /** What must never happen (§3, §5, §14): a non-GET, read/unread/pin, a chat or message detail, a token on a file link. */
    problems(): string[] {
      return requests.flatMap((r) => {
        const out: string[] = [];
        if (r.method !== 'GET') out.push(`${r.method} ${r.path}`);
        if (/\/(read|unread|pin)\/?$/.test(r.path)) out.push(`read/unread/pin ${r.path}`);
        if (/^\/api\/v1\/chats\/[^/]+\/$/.test(r.path) || r.path.startsWith('/api/v1/messages/')) out.push(`detail ${r.path}`);
        if (r.path.startsWith('/s3/') && r.auth !== null) out.push(`Authorization on ${r.path}`);
        return out;
      });
    },
    calls: (path: RegExp) => requests.filter((r) => path.test(r.path)),
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

export type FakeUmbler = Awaited<ReturnType<typeof startFakeUmbler>>;
