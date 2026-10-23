import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FILE_MAX_BYTES, UmblerError, createUmblerClient, isGone, type UmblerClient } from '../../src/importer/umbler.js';
import { ORG, PDF, startFakeUmbler, type FakeUmbler } from '../fakes/umbler-api.js';

let fake: FakeUmbler;
let sleeps: number[];
let client: UmblerClient;
const q = { organizationId: ORG };
const waits = () => sleeps.filter((ms) => ms >= 1000); // without the 100 ms spacing

beforeEach(async () => {
  fake = await startFakeUmbler();
  sleeps = [];
  client = createUmblerClient({ token: 'tok-teste', baseUrl: fake.baseUrl, sleep: async (ms) => void sleeps.push(ms) });
});
afterEach(async () => {
  expect(fake.problems()).toEqual([]);
  await fake.close();
});

describe('Umbler client (spec 2026-10-21 importar-umbler §9.4)', () => {
  it('sends the Bearer token and the query, fills the route template, and keeps 100 ms between calls (fake clock)', async () => {
    let now = 0;
    const spaced: number[] = [];
    const timed = createUmblerClient({
      token: 'tok-teste', baseUrl: fake.baseUrl, now: () => now,
      sleep: async (ms) => {
        spaced.push(ms);
        now += ms;
      },
    });
    await timed.get('/v1/sectors/', q);
    await timed.get('/v1/quick-answers/{id}/', q, { id: 'QA1' });
    now += 30;
    await timed.get('/v1/channels/', q);
    expect(spaced).toEqual([100, 70]);
    expect(fake.requests.map((r) => [r.path, r.auth, r.query.get('organizationId')])).toEqual([
      ['/api/v1/sectors/', 'Bearer tok-teste', ORG],
      ['/api/v1/quick-answers/QA1/', 'Bearer tok-teste', ORG],
      ['/api/v1/channels/', 'Bearer tok-teste', ORG],
    ]);
  });

  it('429: waits Retry-After when it comes, else 5, 10, 20, 40, 60, 60, 60 s, and stops at the 8th refusal', async () => {
    fake.faults.push({ path: /\/sectors\/$/, status: 429, retryAfter: '7' });
    await expect(client.get('/v1/sectors/', q)).resolves.toHaveLength(3);
    expect(waits()).toEqual([7000]);

    sleeps.length = 0;
    fake.faults.push({ path: /\/tags\/$/, status: 429, times: 8 });
    const err = await client.get('/v1/tags/', q).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UmblerError);
    expect(err).toMatchObject({ code: 'umbler_429', status: 429, route: '/v1/tags/' });
    expect(waits()).toEqual([5000, 10_000, 20_000, 40_000, 60_000, 60_000, 60_000]);
  });

  it('401 and 403 stop at once with umbler_token', async () => {
    fake.faults.push({ path: /\/sectors\/$/, status: 401 }, { path: /\/channels\/$/, status: 403 });
    await expect(client.get('/v1/sectors/', q)).rejects.toMatchObject({ code: 'umbler_token', status: 401 });
    await expect(client.get('/v1/channels/', q)).rejects.toMatchObject({ code: 'umbler_token', status: 403 });
    expect(fake.requests).toHaveLength(2);
    expect(waits()).toEqual([]);
  });

  it('5xx: one more try after 2, 10 and 30 s, then umbler_unavailable; a 500 then 200 goes on', async () => {
    fake.faults.push({ path: /\/sectors\/$/, status: 500 });
    await expect(client.get('/v1/sectors/', q)).resolves.toHaveLength(3);
    expect(waits()).toEqual([2000]);

    sleeps.length = 0;
    fake.faults.push({ path: /\/channels\/$/, status: 503, times: 4 });
    await expect(client.get('/v1/channels/', q)).rejects.toMatchObject({ code: 'umbler_unavailable', status: 503 });
    expect(waits()).toEqual([2000, 10_000, 30_000]);
  });

  it('a body cut mid-read is a network error: retried after 2, 10 and 30 s, then umbler_unavailable; one cut then 200 goes on', async () => {
    fake.faults.push({ path: /\/sectors\/$/, status: 200, cut: true });
    await expect(client.get('/v1/sectors/', q)).resolves.toHaveLength(3);
    expect(waits()).toEqual([2000]);

    sleeps.length = 0;
    fake.faults.push({ path: /\/channels\/$/, status: 200, cut: true, times: 4 });
    await expect(client.get('/v1/channels/', q)).rejects.toMatchObject({ code: 'umbler_unavailable', status: null });
    expect(waits()).toEqual([2000, 10_000, 30_000]);
  });

  it("never follows a redirect (redirect: 'error'): the token stays at app-utalk", async () => {
    fake.faults.push({ path: /\/sectors\/$/, status: 302, location: `${fake.baseUrl}/elsewhere`, times: 4 });
    await expect(client.get('/v1/sectors/', q)).rejects.toMatchObject({ code: 'umbler_unavailable', status: null });
    expect(fake.calls(/elsewhere/)).toEqual([]);
  });

  it('400 stops with umbler_400; a 404 is the same code, and isGone tells the one-item callers', async () => {
    fake.faults.push({ path: /\/sectors\/$/, status: 400 });
    await expect(client.get('/v1/sectors/', q)).rejects.toMatchObject({ code: 'umbler_400', status: 400 });
    const err = await client.get('/v1/contacts/{id}/notes/', q, { id: 'NOPE' }).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'umbler_400', status: 404 });
    expect(isGone(err)).toBe(true);
    expect(String((err as Error).message)).toBe('GET /v1/contacts/{id}/notes/ → 404'); // the template, never the id
  });

  it('files: no Authorization; 403/404/410 and over 64 MB are gone at once; 5xx is retried after 1, 5 and 25 s', async () => {
    await expect(client.file(fake.fileUrl('procuracao.pdf'))).resolves.toEqual({ data: PDF, mime: 'application/pdf' });

    fake.world.files['proibido.pdf'] = { body: PDF, mime: 'application/pdf', status: 403 };
    fake.world.files['grande.bin'] = { body: Buffer.alloc(FILE_MAX_BYTES + 1), mime: 'application/octet-stream' };
    await expect(client.file(fake.fileUrl('proibido.pdf'))).resolves.toEqual({ failed: 'gone' });
    await expect(client.file(fake.fileUrl('sumiu.pdf'))).resolves.toEqual({ failed: 'gone' });
    await expect(client.file(fake.fileUrl('grande.bin'))).resolves.toEqual({ failed: 'gone' });
    expect(waits()).toEqual([]);

    fake.faults.push({ path: /^\/s3\/procuracao/, status: 500, times: 4 });
    await expect(client.file(fake.fileUrl('procuracao.pdf'))).resolves.toEqual({ failed: 'temporary' });
    expect(waits()).toEqual([1000, 5000, 25_000]);
    fake.faults.push({ path: /^\/s3\/procuracao/, status: 502 });
    await expect(client.file(fake.fileUrl('procuracao.pdf'))).resolves.toMatchObject({ mime: 'application/pdf' });
    expect(fake.calls(/^\/s3\//).every((r) => r.auth === null)).toBe(true);
  });
});

describe('server/src/importer (spec §3)', () => {
  it('calls Umbler with GET only: no method, no read/unread/pin, no chat or message detail route', async () => {
    const dir = fileURLToPath(new URL('../../src/importer', import.meta.url));
    const files = (await readdir(dir)).filter((f) => f.endsWith('.ts'));
    const offenders: string[] = [];
    for (const f of files) {
      const text = await readFile(join(dir, f), 'utf8');
      const bad = [
        /\bmethod\s*:/, // fetch(…, { method }) – the client has no method parameter
        /['"`](POST|PUT|PATCH|DELETE)['"`]/,
        /\/(read|unread|pin|redownload-media|transcribe|favorite)\//,
        /['"`]\/v1\/chats\/\{\w+\}\/['"`]/, // GET /v1/chats/{id}/ is what the Umbler app calls to open a chat (§3)
        /['"`]\/v1\/messages\//,
      ];
      for (const re of bad) if (re.test(text)) offenders.push(`${f}: ${re}`);
    }
    expect(files).toContain('umbler.ts');
    expect(offenders).toEqual([]);
  });
});
