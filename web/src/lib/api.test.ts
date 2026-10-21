import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_APPOINTMENT_REMINDERS, DEFAULT_AUTO_RULES } from '@talk/shared';
import { api, ApiError, botRunningRuns, graphProblems, readBotExport, request } from './api';

const json = (status: number, body?: unknown) =>
  new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

afterEach(() => vi.unstubAllGlobals());

describe('request', () => {
  it('sends JSON with credentials and returns the parsed body', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => json(200, { id: 'u1' }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(request('POST', '/api/x', { a: 1 })).resolves.toEqual({ id: 'u1' });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('/api/x');
    expect(init?.method).toBe('POST');
    expect(init?.credentials).toBe('include');
    expect(init?.headers).toEqual({ 'content-type': 'application/json' });
    expect(init?.body).toBe('{"a":1}');
  });

  it('sends no content-type and no body when there is no body', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);
    await request('POST', '/api/chats/c1/assume');
    const init = fetchMock.mock.calls[0]![1]!;
    expect(init.headers).toEqual({});
    expect(init.body).toBeUndefined();
  });

  it('returns undefined on 204', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => new Response(null, { status: 204 })));
    await expect(request('POST', '/api/auth/logout')).resolves.toBeUndefined();
  });

  it('maps { error } to ApiError with the server message', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => json(404, { error: 'Não encontrado' })));
    const err = await request('GET', '/api/chats/x').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 404, message: 'Não encontrado' });
  });

  it('appends the correlation id of a 500', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>(async () => json(500, { error: 'Ocorreu um erro', correlationId: 'req-7' })),
    );
    const err = await request('GET', '/api/chats').catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 500, message: 'Ocorreu um erro (req-7)', correlationId: 'req-7' });
  });

  it('translates the rate limiter 429', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>(async () =>
        json(429, { statusCode: 429, error: 'Too Many Requests', message: 'Rate limit exceeded, retry in 1 minute' }),
      ),
    );
    const err = await request('POST', '/api/auth/login', {}).catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 429, message: 'Muitas tentativas. Aguarde um minuto e tente de novo.' });
  });

  it('handles a non-JSON error body', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => new Response('<h1>Bad Gateway</h1>', { status: 502 })));
    const err = await request('GET', '/api/chats').catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 502, message: 'Erro 502' });
  });

  it('maps a network failure to status 0', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => { throw new TypeError('Failed to fetch'); }));
    const err = await request('GET', '/api/chats').catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 0, message: 'Sem conexão com o servidor' });
  });
});

describe('api helpers', () => {
  it('is callable as api<T>(path, { method, body })', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => json(200, { ok: true }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(api<{ ok: boolean }>('/api/x', { method: 'POST', body: { a: 1 } })).resolves.toEqual({ ok: true });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('/api/x');
    expect(init?.method).toBe('POST');
    expect(init?.body).toBe('{"a":1}');
    await api('/api/y');
    expect(fetchMock.mock.calls[1]![1]?.method).toBe('GET');
  });

  it('builds the chat list query string without empty values', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => json(200, { items: [], nextCursor: null }));
    vi.stubGlobal('fetch', fetchMock);
    await api.chats.list({ tab: 'waiting', q: 'ana', sectorId: undefined, ownerId: '', limit: 30 });
    expect(fetchMock.mock.calls[0]![0]).toBe('/api/chats?tab=waiting&q=ana&limit=30');
  });

  it('sends files as multipart with text fields before the file and no JSON header', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => json(200, { id: 'm1' }));
    vi.stubGlobal('fetch', fetchMock);
    const file = new File(['%PDF'], 'contrato.pdf', { type: 'application/pdf' });
    await api.chats.sendFile('c1', { file, text: 'segue', signature: true });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('/api/chats/c1/messages');
    expect(init?.headers).toEqual({});
    const form = init?.body as FormData;
    expect([...form.keys()]).toEqual(['text', 'signature', 'file']);
    expect(form.get('signature')).toBe('true');
  });

  it('pins with PUT and unpins with DELETE', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);
    await api.chats.pin('c1', true);
    await api.chats.pin('c1', false);
    expect(fetchMock.mock.calls.map(([u, i]) => `${i?.method} ${String(u)}`)).toEqual([
      'PUT /api/chats/c1/pin',
      'DELETE /api/chats/c1/pin',
    ]);
  });
});
describe('bot client', () => {
  it('keeps the error body in ApiError.data and reads the BOT_RUNNING runs from it', async () => {
    const body = { error: 'O chatbot está em execução nesta conversa', code: 'BOT_RUNNING', runs: [{ id: 'r1', botName: 'Fluxo' }] };
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => json(409, body)));
    const err = await api.chats.sendText('c1', { text: 'oi', signature: true }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 409, message: body.error, data: body });
    expect(botRunningRuns(err)).toEqual(body.runs);
    expect(graphProblems(err)).toBeNull();
  });

  it('reads graph problems from a 400 and ignores every other error', async () => {
    const problems = [{ nodeId: 'n1', message: 'Bloco sem entrada' }];
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => json(400, { error: 'O fluxo tem problemas', problems })));
    const err = await api.bots.saveVersion('b1', { graph: { nodes: [], edges: [] }, publish: true }).catch((e: unknown) => e);
    expect(graphProblems(err)).toEqual(problems);
    expect(botRunningRuns(err)).toBeNull();
    expect(botRunningRuns(new ApiError(409, 'Conflito'))).toBeNull();
    expect(botRunningRuns(new ApiError(409, 'Conflito', undefined, null))).toBeNull();
    expect(graphProblems(new Error('x'))).toBeNull();
  });

  it('sends botAction in the JSON of text and transfer, and before the file in multipart', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => json(200, { id: 'm1' }));
    vi.stubGlobal('fetch', fetchMock);
    await api.chats.sendText('c1', { text: 'oi', signature: false, botAction: 'stop' });
    await api.chats.transfer('c1', { sectorId: 's1', botAction: 'keep' });
    await api.chats.sendFile('c1', { file: new File(['x'], 'a.pdf', { type: 'application/pdf' }), signature: true, botAction: 'keep' });
    expect(fetchMock.mock.calls[0]![1]?.body).toBe('{"text":"oi","signature":false,"botAction":"stop"}');
    expect(fetchMock.mock.calls[1]![1]?.body).toBe('{"sectorId":"s1","botAction":"keep"}');
    const form = fetchMock.mock.calls[2]![1]?.body as FormData;
    expect([...form.keys()]).toEqual(['signature', 'botAction', 'file']);
    expect(form.get('botAction')).toBe('keep');
  });

  it('calls the bot routes with the right method, path and body', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => json(200, {}));
    vi.stubGlobal('fetch', fetchMock);
    const graph = { nodes: [], edges: [] };
    await api.bots.importBot({ name: 'Cobrança', graph });
    await api.bots.setStatus('b1', 'active');
    await api.bots.duplicate('b1');
    await api.bots.version('b1', 3);
    await api.botRuns.start('c1', 'b1');
    await api.botRuns.stop('r1');
    await api.bots.uploadMedia(new File(['png'], 'logo.png', { type: 'image/png' }));
    expect(fetchMock.mock.calls.map(([u, i]) => `${i?.method} ${String(u)}`)).toEqual([
      'POST /api/bots/import',
      'POST /api/bots/b1/status',
      'POST /api/bots/b1/duplicate',
      'GET /api/bots/b1/versions/3',
      'POST /api/chats/c1/bot-runs',
      'POST /api/bot-runs/r1/stop',
      'POST /api/bots/media',
    ]);
    expect(fetchMock.mock.calls[0]![1]?.body).toBe(JSON.stringify({ name: 'Cobrança', graph }));
    expect(fetchMock.mock.calls[1]![1]?.body).toBe('{"status":"active"}');
    expect(fetchMock.mock.calls[4]![1]?.body).toBe('{"botId":"b1"}');
    expect(((fetchMock.mock.calls[6]![1]?.body as FormData).get('file') as File).name).toBe('logo.png');
    expect(api.bots.exportUrl('b 1')).toBe('/api/bots/b%201/export');
  });

  it('calls the message action routes with the right method, path and body', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => json(200, {}));
    vi.stubGlobal('fetch', fetchMock);
    await api.messages.react('m1', '👍');
    await api.messages.remove('m1');
    await api.messages.edit('m1', 'novo');
    await api.messages.edits('m1');
    await api.messages.forward('m1', { contactId: 'k1' });
    await api.chats.sendSticker('c1', { stickerFromMessageId: 'm2' });
    await api.stickers.recent();
    await api.chats.sendFile('c1', { file: new File(['png'], 'f.png', { type: 'image/png' }), signature: false, asSticker: true });
    expect(fetchMock.mock.calls.map(([u, i]) => `${i?.method} ${String(u)}`)).toEqual([
      'POST /api/messages/m1/reaction',
      'DELETE /api/messages/m1',
      'PATCH /api/messages/m1',
      'GET /api/messages/m1/edits',
      'POST /api/messages/m1/forward',
      'POST /api/chats/c1/messages',
      'GET /api/stickers/recent',
      'POST /api/chats/c1/messages',
    ]);
    expect(fetchMock.mock.calls[0]![1]?.body).toBe('{"emoji":"👍"}');
    expect(fetchMock.mock.calls[1]![1]?.body).toBeUndefined();
    expect(fetchMock.mock.calls[2]![1]?.body).toBe('{"text":"novo"}');
    expect(fetchMock.mock.calls[4]![1]?.body).toBe('{"contactId":"k1"}');
    expect(fetchMock.mock.calls[5]![1]?.body).toBe('{"stickerFromMessageId":"m2"}');
    expect([...(fetchMock.mock.calls[7]![1]?.body as FormData).keys()]).toEqual(['signature', 'asSticker', 'file']);
  });
});

describe('readBotExport', () => {
  const file = (text: string) => new File([text], 'bot.json', { type: 'application/json' });

  it('reads an exported chatbot', async () => {
    const graph = { nodes: [], edges: [] };
    await expect(readBotExport(file(JSON.stringify({ name: 'Triagem', graph, extra: 1 })))).resolves.toEqual({ name: 'Triagem', graph });
  });

  it('rejects a file that is not JSON or not a chatbot', async () => {
    await expect(readBotExport(file('oi'))).rejects.toThrow('não é um JSON');
    await expect(readBotExport(file('{"a":1}'))).rejects.toThrow('não é um chatbot exportado');
  });

  it('rejects a file over 1 MB before reading it, and accepts one right at the limit', async () => {
    const text = vi.fn(async () => '{}');
    const big = { size: 1_000_001, text } as unknown as Blob;
    await expect(readBotExport(big)).rejects.toThrow('Arquivo grande demais (máx. 1 MB).');
    expect(text).not.toHaveBeenCalled();
    await expect(readBotExport(file('x'.repeat(1_000_000)))).rejects.toThrow('não é um JSON'); // passed the guard
  });
});

describe('api routes of the 2026-10-19 delivery', () => {
  it('calls the timeline cursors, search, favorites, notes and preferences routes', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => json(200, []));
    vi.stubGlobal('fetch', fetchMock);
    await api.chats.timeline('c1', { around: 'm1', limit: 50 });
    await api.chats.timeline('c1', { after: 'm2' });
    await api.chats.search('c1', 'ação 10%');
    await api.chats.favorites('c1');
    await api.messages.favorite('m1', true);
    await api.messages.favorite('m1', false);
    await api.notes.remove('m1');
    await api.auth.setPreferences({ sounds: false });
    expect(fetchMock.mock.calls.map(([url, init]) => `${init?.method} ${String(url)}`)).toEqual([
      'GET /api/chats/c1/timeline?around=m1&limit=50',
      'GET /api/chats/c1/timeline?after=m2',
      'GET /api/chats/c1/search?q=a%C3%A7%C3%A3o+10%25',
      'GET /api/chats/c1/favorites',
      'PUT /api/messages/m1/favorite',
      'DELETE /api/messages/m1/favorite',
      'DELETE /api/notes/m1',
      'PUT /api/auth/me/preferences',
    ]);
    expect(fetchMock.mock.calls.at(-1)![1]!.body).toBe('{"sounds":false}');
  });
});

describe('api routes of the 2026-10-20 delivery', () => {
  it('calls the conversation-tag and bulk routes, and sends sort and chatTagId', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => json(200, { done: [], failed: [] }));
    vi.stubGlobal('fetch', fetchMock);
    await api.chats.setTags('c1', ['t1']);
    await api.chats.bulkTransfer({ chatIds: ['c1', 'c2'], sectorId: 's1', ownerId: null });
    await api.chats.bulkClose({ chatIds: ['c1'], sendClosingMessage: true });
    await api.chats.bulkRead(['c1']);
    await api.chats.list({ tab: 'inbox', sort: 'waiting', chatTagId: 't1' });
    expect(fetchMock.mock.calls.map(([u, i]) => `${i?.method} ${String(u)} ${String(i?.body ?? '')}`)).toEqual([
      'PUT /api/chats/c1/tags {"tagIds":["t1"]}',
      'POST /api/chats/bulk/transfer {"chatIds":["c1","c2"],"sectorId":"s1","ownerId":null}',
      'POST /api/chats/bulk/close {"chatIds":["c1"],"sendClosingMessage":true}',
      'POST /api/chats/bulk/read {"chatIds":["c1"]}',
      'GET /api/chats?tab=inbox&sort=waiting&chatTagId=t1 ',
    ]);
  });
});

describe('api routes of the 2026-10-20 agendamentos delivery', () => {
  it('calls the scheduled-message and auto-rule routes', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => json(200, {}));
    vi.stubGlobal('fetch', fetchMock);
    await api.scheduled.listForChat('c1');
    await api.scheduled.list('failed');
    await api.scheduled.create('c1', { text: 'Oi', sendAt: '2026-10-21T12:00:00.000Z', signature: true });
    await api.scheduled.update('s1', { sendAt: '2026-10-21T13:00:00.000Z' });
    await api.scheduled.cancel('s1');
    await api.settings.autoRules.get();
    await api.settings.autoRules.put(DEFAULT_AUTO_RULES);
    expect(fetchMock.mock.calls.map(([u, i]) => `${i?.method} ${String(u)} ${String(i?.body ?? '')}`)).toEqual([
      'GET /api/chats/c1/scheduled-messages ',
      'GET /api/scheduled-messages?status=failed ',
      'POST /api/chats/c1/scheduled-messages {"text":"Oi","sendAt":"2026-10-21T12:00:00.000Z","signature":true}',
      'PATCH /api/scheduled-messages/s1 {"sendAt":"2026-10-21T13:00:00.000Z"}',
      'POST /api/scheduled-messages/s1/cancel ',
      'GET /api/settings/auto-rules ',
      `PUT /api/settings/auto-rules ${JSON.stringify(DEFAULT_AUTO_RULES)}`,
    ]);
  });

  it('sends a scheduled attachment as multipart, with the fields before the file', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => json(200, {}));
    vi.stubGlobal('fetch', fetchMock);
    const file = new File(['%PDF'], 'peticao.pdf', { type: 'application/pdf' });
    await api.scheduled.create('c1', { text: 'Segue', sendAt: '2026-10-21T12:00:00.000Z', signature: false, file });
    const body = fetchMock.mock.calls[0]![1]!.body as FormData;
    expect([...body.keys()]).toEqual(['text', 'sendAt', 'signature', 'file']);
    expect(body.get('signature')).toBe('false');
    expect((body.get('file') as File).name).toBe('peticao.pdf');
  });
});

describe('api routes of the 2026-10-21 compromissos delivery', () => {
  it('calls the appointment and default-reminder routes', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => json(200, {}));
    vi.stubGlobal('fetch', fetchMock);
    const { reminders } = DEFAULT_APPOINTMENT_REMINDERS;
    const input = { contactId: 'k1', title: 'Audiência', startsAt: '2026-10-21T18:00:00.000Z', signature: false, reminders };
    await api.appointments.listForChat('c1');
    await api.appointments.list('past');
    await api.appointments.create(input);
    await api.appointments.update('a1', { note: null });
    await api.appointments.cancel('a1');
    await api.settings.appointmentReminders.get();
    await api.settings.appointmentReminders.put({ reminders });
    expect(fetchMock.mock.calls.map(([u, i]) => `${i?.method} ${String(u)} ${String(i?.body ?? '')}`)).toEqual([
      'GET /api/chats/c1/appointments ',
      'GET /api/appointments?tab=past ',
      `POST /api/appointments ${JSON.stringify(input)}`,
      'PATCH /api/appointments/a1 {"note":null}',
      'POST /api/appointments/a1/cancel ',
      'GET /api/settings/appointment-reminders ',
      `PUT /api/settings/appointment-reminders ${JSON.stringify({ reminders })}`,
    ]);
  });
});
