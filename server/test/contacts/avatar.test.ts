import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { contacts, messages } from '../../src/db/schema.js';
import { findOrOpenChat } from '../../src/inbox/chats.js';
import { avatarRefreshesIdle, handleInbound } from '../../src/messages/ingest.js';
import type { InboundEvent } from '../../src/whatsapp/types.js';
import { loginAs, makeTestApp, makeTestCtx, seedBasics } from '../helpers.js';

type MessageEvent = Extract<InboundEvent, { type: 'message' }>;

const PHONE = '5565999990001';
const PIC_URL = 'https://pps.whatsapp.test/v/maria.jpg';
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);
const DAY = 24 * 60 * 60 * 1000;
let seq = 0;

function msg(over: Partial<MessageEvent> = {}): MessageEvent {
  seq += 1;
  return {
    type: 'message', instance: 'talk-test', externalId: `AV${seq}`, direction: 'in', phone: PHONE, lid: null,
    pushName: 'Maria', kind: 'text', body: 'corpo secreto', hasMedia: false, mediaMime: null, mediaName: null,
    replyToExternalId: null, sentAt: new Date(), raw: {}, ...over,
  };
}

const noHooks = { startTriage: async () => {}, handleTriageReply: async () => true };

let ctx: Awaited<ReturnType<typeof makeTestCtx>>;
let seed: Awaited<ReturnType<typeof seedBasics>>;
let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;
let logged: ReturnType<typeof vi.spyOn>;
let app: FastifyInstance | undefined;

const ingest = async (...events: InboundEvent[]) => {
  await handleInbound(ctx, events, noHooks);
  await avatarRefreshesIdle();
};
const contactRow = async (id: string) => (await ctx.db.select().from(contacts).where(eq(contacts.id, id)))[0]!;
const imageResponse = (body: Buffer = PNG, type = 'image/png') =>
  new Response(new Uint8Array(body), { status: 200, headers: { 'content-type': type } });

async function insertContact(over: Partial<typeof contacts.$inferInsert> = {}) {
  const [row] = await ctx.db.insert(contacts).values({ id: randomUUID(), phone: PHONE, name: 'Maria', ...over }).returning();
  return row!;
}

beforeEach(async () => {
  ctx = await makeTestCtx();
  seed = await seedBasics(ctx);
  fetchMock = vi.fn<typeof fetch>(async () => imageResponse());
  vi.stubGlobal('fetch', fetchMock);
  logged = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(async () => {
  vi.unstubAllGlobals();
  logged.mockRestore();
  await app?.close();
  app = undefined;
});

describe('avatar refresh on inbound messages', () => {
  it('first inbound message: looks up the picture after commit, saves it and publishes the open chat', async () => {
    ctx.wa.profilePictures.set(PHONE, PIC_URL);
    await ingest(msg());

    expect(ctx.wa.pictureLookups).toEqual([{ instance: 'talk-test', address: PHONE }]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]![0])).toBe(PIC_URL);
    expect(fetchMock.mock.calls[0]![1]?.signal).toBeInstanceOf(AbortSignal);

    const [c] = await ctx.db.select().from(contacts);
    expect(c!.avatarPath).toBe(`avatars/${c!.id}.png`);
    expect(c!.avatarCheckedAt).toBeInstanceOf(Date);
    expect(await readFile(join(ctx.config.mediaDir, c!.avatarPath!))).toEqual(PNG);

    const chatEvents = ctx.hub.events.filter((e) => e.type === 'chat');
    expect(chatEvents).toHaveLength(2); // ingest's publish + the avatar one
    expect(logged).not.toHaveBeenCalled();
  });

  it('a lid-only contact is looked up as <lid>@lid', async () => {
    await ingest(msg({ phone: null, lid: '123456789' }));
    expect(ctx.wa.pictureLookups).toEqual([{ instance: 'talk-test', address: '123456789@lid' }]);
    // no picture before or after: nothing to re-send to the inboxes
    expect(ctx.hub.events.filter((e) => e.type === 'chat')).toHaveLength(1);
  });

  it('runs only when never checked or checked over 7 days ago', async () => {
    const fresh = await insertContact({ avatarCheckedAt: new Date(Date.now() - 6 * DAY) });
    await ingest(msg());
    expect(ctx.wa.pictureLookups).toEqual([]);
    expect((await contactRow(fresh.id)).avatarCheckedAt).toEqual(fresh.avatarCheckedAt);

    await ctx.db.update(contacts).set({ avatarCheckedAt: new Date(Date.now() - 8 * DAY) }).where(eq(contacts.id, fresh.id));
    await ingest(msg());
    expect(ctx.wa.pictureLookups).toHaveLength(1);
    expect((await contactRow(fresh.id)).avatarCheckedAt!.getTime()).toBeGreaterThan(Date.now() - DAY);

    await ingest(msg()); // just checked: no new lookup
    expect(ctx.wa.pictureLookups).toHaveLength(1);
  });

  it('a burst of messages looks the picture up once', async () => {
    await ingest(msg(), msg(), msg());
    expect(ctx.wa.pictureLookups).toHaveLength(1);
  });

  it('outbound messages do not trigger it', async () => {
    await ingest(msg({ direction: 'out' }));
    expect(ctx.wa.pictureLookups).toEqual([]);
  });

  it('runs outside the ingest transaction and does not hold the message back', async () => {
    let release!: (url: string | null) => void;
    let messagesSeen = -1;
    vi.spyOn(ctx.wa, 'fetchProfilePicture').mockImplementation(async () => {
      // Inside the transaction a ctx.db query would deadlock on PGlite; outside it sees the committed message.
      messagesSeen = await ctx.db.$count(messages);
      return new Promise<string | null>((r) => (release = r));
    });

    await handleInbound(ctx, [msg()], noHooks); // returns while the lookup is still pending
    expect(await ctx.db.$count(messages)).toBe(1);
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    expect(messagesSeen).toBe(1);
    release(null);
    await avatarRefreshesIdle();
  });

  it('no picture: clears avatar_path, removes the old file and records the check', async () => {
    const c = await insertContact({ avatarPath: 'avatars/old.jpg', avatarCheckedAt: new Date(Date.now() - 8 * DAY) });
    await mkdir(join(ctx.config.mediaDir, 'avatars'), { recursive: true });
    await writeFile(join(ctx.config.mediaDir, 'avatars/old.jpg'), 'x');

    await ingest(msg());
    const row = await contactRow(c.id);
    expect(row.avatarPath).toBeNull();
    expect(row.avatarCheckedAt!.getTime()).toBeGreaterThan(Date.now() - DAY);
    expect(existsSync(join(ctx.config.mediaDir, 'avatars/old.jpg'))).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a gateway failure keeps the message and the old picture, logs only the error name and records the check', async () => {
    const c = await insertContact({ avatarPath: `avatars/keep.png` });
    ctx.wa.profilePictures.set(PHONE, new Error('Evolution 500 corpo secreto'));

    await ingest(msg());
    expect(await ctx.db.$count(messages)).toBe(1);
    const row = await contactRow(c.id);
    expect(row.avatarPath).toBe('avatars/keep.png');
    expect(row.avatarCheckedAt).toBeInstanceOf(Date);
    expect(logged).toHaveBeenCalledWith('avatar refresh failed', { contactId: c.id, err: 'Error' });
    expect(JSON.stringify(logged.mock.calls)).not.toContain('secreto');
  });

  it('rejects a download that is not a raster image or is over 2 MB', async () => {
    ctx.wa.profilePictures.set(PHONE, PIC_URL);
    const c = await insertContact();

    fetchMock.mockResolvedValueOnce(imageResponse(Buffer.from('<svg onload="alert(1)"/>'), 'image/svg+xml'));
    await ingest(msg());
    expect((await contactRow(c.id)).avatarPath).toBeNull();

    await ctx.db.update(contacts).set({ avatarCheckedAt: null }).where(eq(contacts.id, c.id));
    fetchMock.mockResolvedValueOnce(imageResponse(Buffer.alloc(2 * 1024 * 1024 + 1), 'image/jpeg'));
    await ingest(msg());
    expect((await contactRow(c.id)).avatarPath).toBeNull();

    expect(logged).toHaveBeenCalledTimes(2);
    expect(logged.mock.calls.map((call: unknown[]) => (call[1] as { err: string }).err)).toEqual(['AvatarRejected', 'AvatarRejected']);
  });

  it('stops reading a body without content-length once it passes 2 MB', async () => {
    ctx.wa.profilePictures.set(PHONE, PIC_URL);
    const c = await insertContact();
    let pulled = 0;
    const chunk = new Uint8Array(64 * 1024);
    const body = new ReadableStream<Uint8Array>({
      pull(ctrl) {
        pulled += chunk.length;
        if (pulled > 10 * 1024 * 1024) ctrl.close();
        else ctrl.enqueue(chunk);
      },
    });
    fetchMock.mockResolvedValueOnce(new Response(body, { status: 200, headers: { 'content-type': 'image/jpeg' } }));

    await ingest(msg());
    expect((await contactRow(c.id)).avatarPath).toBeNull();
    expect(pulled).toBeLessThan(3 * 1024 * 1024);
    expect(logged).toHaveBeenCalledWith('avatar refresh failed', { contactId: c.id, err: 'AvatarRejected' });
  });

  it('only fetches https URLs and refuses redirects', async () => {
    const c = await insertContact();
    ctx.wa.profilePictures.set(PHONE, 'http://pps.whatsapp.test/v/maria.jpg');
    await ingest(msg());
    expect(fetchMock).not.toHaveBeenCalled();
    expect(logged).toHaveBeenCalledWith('avatar refresh failed', { contactId: c.id, err: 'AvatarRejected' });

    await ctx.db.update(contacts).set({ avatarCheckedAt: null }).where(eq(contacts.id, c.id));
    ctx.wa.profilePictures.set(PHONE, PIC_URL);
    await ingest(msg());
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]![1]?.redirect).toBe('error');
    expect((await contactRow(c.id)).avatarPath).toBe(`avatars/${c.id}.png`);
  });

  it('writes the file atomically (no .tmp left behind, existing picture replaced)', async () => {
    ctx.wa.profilePictures.set(PHONE, PIC_URL);
    const c = await insertContact();
    await mkdir(join(ctx.config.mediaDir, 'avatars'), { recursive: true });
    await writeFile(join(ctx.config.mediaDir, `avatars/${c.id}.png`), 'old');
    await ingest(msg());
    expect(await readFile(join(ctx.config.mediaDir, `avatars/${c.id}.png`))).toEqual(PNG);
    expect(existsSync(join(ctx.config.mediaDir, `avatars/${c.id}.png.tmp`))).toBe(false);
  });
});

describe('GET /api/contacts/:id/avatar and avatarUrl', () => {
  async function setup() {
    ({ app } = await makeTestApp(ctx));
    const auth = await loginAs(app, seed.agentB.email);
    const checkedAt = new Date('2026-10-15T12:00:00.000Z');
    const withPic = await insertContact({ avatarPath: null, avatarCheckedAt: checkedAt });
    await mkdir(join(ctx.config.mediaDir, 'avatars'), { recursive: true });
    await writeFile(join(ctx.config.mediaDir, `avatars/${withPic.id}.png`), PNG);
    await ctx.db.update(contacts).set({ avatarPath: `avatars/${withPic.id}.png` }).where(eq(contacts.id, withPic.id));
    const without = await insertContact({ phone: '5565999990002' });
    return { auth, withPic, without, checkedAt };
  }

  it('serves the picture to any logged-in user with private cache and nosniff', async () => {
    const { auth, withPic } = await setup();
    const res = await app!.inject({ method: 'GET', url: `/api/contacts/${withPic.id}/avatar`, headers: auth.headers });
    expect(res.statusCode).toBe(200);
    expect(res.rawPayload).toEqual(PNG);
    expect(res.headers['content-type']).toBe('image/png');
    expect(res.headers['cache-control']).toBe('private, max-age=86400');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  it('is 404 without a picture (or with a missing file) and 401 without a session', async () => {
    const { auth, withPic, without } = await setup();
    const get = (id: string, headers?: Record<string, string>) => app!.inject({ method: 'GET', url: `/api/contacts/${id}/avatar`, headers });
    expect((await get(without.id, auth.headers)).statusCode).toBe(404);
    expect((await get(randomUUID(), auth.headers)).statusCode).toBe(404);
    await ctx.db.update(contacts).set({ avatarPath: 'avatars/missing.png' }).where(eq(contacts.id, without.id));
    expect((await get(without.id, auth.headers)).statusCode).toBe(404);
    expect((await get(withPic.id)).statusCode).toBe(401);
  });

  it('ContactDto and the chat list ContactRef carry avatarUrl', async () => {
    const { auth, withPic, without, checkedAt } = await setup();
    const url = `/api/contacts/${withPic.id}/avatar?v=${checkedAt.getTime()}`;

    const one = await app!.inject({ method: 'GET', url: `/api/contacts/${withPic.id}`, headers: auth.headers });
    expect(one.json().avatarUrl).toBe(url);
    const none = await app!.inject({ method: 'GET', url: `/api/contacts/${without.id}`, headers: auth.headers });
    expect(none.json().avatarUrl).toBeNull();

    await findOrOpenChat(ctx.db, {
      contactId: withPic.id,
      channelId: seed.channelId,
      init: { sectorId: seed.sectorB, ownerId: null, waiting: true, triagePending: false, createdBy: null },
    });
    const list = await app!.inject({ method: 'GET', url: '/api/chats', headers: auth.headers });
    expect(list.json().items[0].contact).toEqual({ id: withPic.id, name: 'Maria', phone: PHONE, avatarUrl: url });
  });
});
