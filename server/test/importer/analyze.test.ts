import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { channels } from '../../src/db/schema.js';
import { ORG, umblerChat, umblerMessage } from '../fakes/umbler-api.js';
import { analyze, importWorld, proposals, testAnalysis, type World } from './world.js';

let w: World;
let logs: unknown[][];
beforeEach(async () => {
  w = await importWorld();
  logs = [];
  for (const level of ['info', 'error'] as const) vi.spyOn(console, level).mockImplementation((...args: unknown[]) => void logs.push(args));
});
afterEach(async () => {
  vi.restoreAllMocks();
  expect(w.fake.problems()).toEqual([]);
  await w.fake.close();
});

const closed = (closedAtUTC: string, over: Record<string, unknown> = {}) =>
  umblerChat({ open: false, closedAtUTC, createdAtUTC: closedAtUTC, ...over });
const received = { id: 'LAST', source: 'Contact', messageState: 'Received' };

describe('Analisar (spec 2026-10-21 importar-umbler §6.2)', () => {
  it('counts lists only and proposes sector by name, attendant by e-mail and channel by number', async () => {
    await w.ctx.db.update(channels).set({ phone: '5565999990000' }).where(eq(channels.id, w.s.channelId));
    w.fake.world.chats.push(
      umblerChat({ createdAtUTC: '2026-10-01T12:00:00Z', waiting: true }),
      umblerChat({ createdAtUTC: '2026-10-02T12:00:00Z', organizationMember: { id: 'M_CARLA' } }),
      closed('2025-03-04T12:00:00Z'),
      closed('2026-01-01T12:00:00Z', { channel: { _t: 'ChatWebsiteWidgetChannelReferenceModel', id: 'CH_WEB', name: 'Site' } }),
    );

    const row = await analyze(w);

    expect(row.state).toBe('analyzed');
    const a = row.analysis!;
    expect(a).toMatchObject({
      organizationId: 'ORG_TESTE_00001',
      organization: 'Escritório Teste',
      contacts: { total: 4, existing: 0, withoutAddress: 1 },
      chats: { open: 2, waiting: 1, closed: 2, from: '2025-03-04T12:00:00.000Z', to: '2026-10-02T12:00:00.000Z' },
      tags: { new: 2, existing: 0 },
      customFields: { new: 2, existing: 0, unsupported: ['Aceitou termos'] },
      quickAnswers: { new: 2, existing: 0 },
    });
    expect(a.channels.map((c) => [c.id, c.whatsapp, c.phone, c.chats])).toEqual([
      ['CH_WA', true, '5565999990000', 3],
      ['CH_WEB', false, null, 1],
    ]);
    expect(a.members.map((m) => [m.id, m.chats])).toEqual([['M_ANA', 3], ['M_CARLA', 1]]); // the AI agent stays out
    expect(proposals(a)).toEqual(proposals(testAnalysis(w)));
    expect(row.progress?.chatsRead).toBe(4);
    expect(w.fake.calls(/relative-messages/)).toEqual([]); // no candidate for the read test: no message call at all
    expect(JSON.stringify(logs)).not.toMatch(/Maria|5565|ana@teste|tok-teste/i);
  });

  it('an old WhatsApp number of the office goes to the official channel (§18.3); other kinds of channel never come', async () => {
    w.fake.world.channels.push({ _t: 'OrganizationCloudAPIWhatsappChannelReferenceModel', id: 'CH_OLD', name: 'Número antigo', phoneNumber: '+5565988880000' });
    const [second] = await w.ctx.db.insert(channels).values({ name: 'Outro', evolutionInstance: 'talk-outro', phone: '5565999990000' }).returning();

    const a = (await analyze(w)).analysis!;

    // CH_WA has the number of `second`, which is then the official channel; CH_OLD's number is nowhere here
    expect(Object.fromEntries(a.channels.map((c) => [c.id, c.proposal]))).toEqual({ CH_WA: second!.id, CH_WEB: 'none', CH_OLD: second!.id });
  });

  it('warns: token without full access, chats without content, plan limit, no read-test candidate, a count that disagrees, free space', async () => {
    const me = w.fake.world.me as { organizations: Array<Record<string, unknown>> };
    me.organizations[0]!.permissions = ['Operator'];
    w.fake.world.organization.maxDaysMessageHistoric = 90;
    w.fake.world.chats.push(umblerChat({ redactReason: 'InDisallowedSector' }));
    w.fake.world.totalBias = 1;
    w.free.bytes = 12.5 * 1024 ** 3;

    const a = (await analyze(w)).analysis!;

    expect(a.readTest).toBe('not_done');
    expect(a.warnings).toEqual([
      'O token é de um usuário sem acesso a tudo: gere o token com o Proprietário.',
      'O Umbler informou 2 conversas abertas, mas a lista trouxe 1.',
      '1 conversas vêm sem conteúdo para este token.',
      'O plano do Umbler mostra só os últimos 90 dias de mensagens; as anteriores não vêm.',
      'Não houve conversa para o teste de leitura; a importação confere as abertas durante a cópia.',
      'Espaço livre para arquivos: 12,5 GB.',
    ]);
  });

  it('read test (§5.1): reads the newest closed chat still "Received" from the contact, then looks at it again', async () => {
    const newest = closed('2026-09-10T12:00:00Z', { lastMessage: received, totalUnread: 2 });
    const older = closed('2026-09-05T12:00:00Z', { lastMessage: received });
    w.fake.world.chats.push(older, newest);
    w.fake.world.messages[newest.id as string] = [umblerMessage('M1', '2026-09-10T11:59:00Z')];

    expect((await analyze(w)).analysis!.readTest).toBe('ok');
    expect(w.fake.calls(/relative-messages/).map((r) => r.path)).toEqual([`/api/v1/chats/${newest.id}/relative-messages/`]);
    expect(w.fake.calls(/\/contacts\/C1\/chats\/$/).map((r) => r.query.get('ChatState'))).toEqual(['Closed']);

    w.fake.world.marksRead = newest.id as string; // this time reading marks it as read in Umbler
    expect((await analyze(w)).analysis!.readTest).toBe('marked');
  });

  it('a refused token fails the analysis with umbler_token, and the token is never in the row', async () => {
    w.fake.faults.push({ path: /members\/me/, status: 401 });
    const row = await analyze(w);
    expect(row).toMatchObject({ state: 'failed', error: 'umbler_token', analysis: null });
    expect(JSON.stringify(row)).not.toContain('tok-teste');
    expect(JSON.stringify(logs)).not.toContain('tok-teste');
  });

  it('uses the active organization when the token also sees an old, deactivated one (the real Umbler answers it with 403)', async () => {
    const me = w.fake.world.me as { organizations: Array<Record<string, unknown>> };
    me.organizations.unshift({ ...me.organizations[0], id: 'ORG_ANTIGA', name: 'Escritório antigo', active: false });
    const row = await analyze(w);
    expect(row).toMatchObject({ state: 'analyzed', error: null });
    expect(row.analysis!.organizationId).toBe(ORG);
    expect(w.fake.calls(/ORG_ANTIGA/)).toEqual([]);
  });

  it('stops with umbler_orgs, before reading anything else, when the token sees more than one active organization', async () => {
    const me = w.fake.world.me as { organizations: Array<Record<string, unknown>> };
    me.organizations.push({ ...me.organizations[0], id: 'ORG_OUTRA', name: 'Outra empresa' });
    const row = await analyze(w);
    expect(row).toMatchObject({ state: 'failed', error: 'umbler_orgs', analysis: null });
    expect(w.fake.requests.map((r) => r.path)).toEqual(['/api/v1/members/me/']);
  });
});
