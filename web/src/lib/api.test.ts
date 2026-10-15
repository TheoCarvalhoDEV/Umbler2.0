import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError, request } from './api';

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
