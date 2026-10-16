import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError, botRunningRuns, graphProblems, request } from './api';

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
});
