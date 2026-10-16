import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { channels, chats, contacts, messages } from '../../src/db/schema.js';
import { avatarRefreshesIdle, createAvatarSweep } from '../../src/contacts/avatar.js';
import { findOrOpenChat } from '../../src/inbox/chats.js';
import { handleInbound } from '../../src/messages/ingest.js';
import { sendAgentMessage } from '../../src/messages/send.js';
import type { InboundEvent } from '../../src/whatsapp/types.js';
import { loginAs, makeTestApp, makeTestCtx, seedBasics } from '../helpers.js';

type MessageEvent = Extract<InboundEvent, { type: 'message' }>;

const PHONE = '5565999990001';
const PIC_URL = 'https://pps.whatsapp.test/v/maria.jpg';
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
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

  it('outbound (fromMe) messages trigger it too', async () => {
    await ingest(msg({ direction: 'out' }));
    expect(ctx.wa.pictureLookups).toEqual([{ instance: 'talk-test', address: PHONE }]);
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
    // retried in about an hour, not locked out for 7 days
    expect(Math.abs(row.avatarCheckedAt!.getTime() - (Date.now() - 7 * DAY + HOUR))).toBeLessThan(5 * 60 * 1000);
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

  it('refuses a declared content-length over 2 MB before reading the body', async () => {
    ctx.wa.profilePictures.set(PHONE, PIC_URL);
    const c = await insertContact();
    // Small real body, but the header announces more than the cap: only the pre-check can reject it.
    fetchMock.mockResolvedValueOnce(
      new Response(new Uint8Array(PNG), {
        status: 200,
        headers: { 'content-type': 'image/png', 'content-length': String(2 * 1024 * 1024 + 1) },
      }),
    );
    await ingest(msg());
    expect((await contactRow(c.id)).avatarPath).toBeNull();
    expect(logged).toHaveBeenCalledWith('avatar refresh failed', { contactId: c.id, err: 'AvatarRejected' });
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

  it('replaces an existing picture file and leaves no .tmp behind', async () => {
    ctx.wa.profilePictures.set(PHONE, PIC_URL);
    const c = await insertContact();
    await mkdir(join(ctx.config.mediaDir, 'avatars'), { recursive: true });
    await writeFile(join(ctx.config.mediaDir, `avatars/${c.id}.png`), 'old');
    await ingest(msg());
    expect(await readFile(join(ctx.config.mediaDir, `avatars/${c.id}.png`))).toEqual(PNG);
    expect(existsSync(join(ctx.config.mediaDir, `avatars/${c.id}.png.tmp`))).toBe(false);
  });
});

async function chatFor(contactId: string, channelId = seed.channelId) {
  const { chat } = await findOrOpenChat(ctx.db, {
    contactId,
    channelId,
    init: { sectorId: seed.sectorB, ownerId: null, waiting: true, triagePending: false, createdBy: null },
  });
  return chat;
}

async function otherChannel(status: 'connected' | 'disconnected') {
  const [ch] = await ctx.db
    .insert(channels)
    .values({ name: `outro ${status}`, evolutionInstance: `talk-${status}`, status })
    .returning();
  return ch!;
}

describe('avatar refresh when sending and opening the conversation', () => {
  it('an agent send looks the picture up once (stale rule), after commit', async () => {
    ctx.wa.profilePictures.set(PHONE, PIC_URL);
    const c = await insertContact();
    const chat = await chatFor(c.id);
    await sendAgentMessage(ctx, { ...seed.agentB, signature: null }, chat.id, { text: 'oi', signature: false });
    await sendAgentMessage(ctx, { ...seed.agentB, signature: null }, chat.id, { text: 'oi de novo', signature: false });
    await avatarRefreshesIdle();
    expect(ctx.wa.pictureLookups).toEqual([{ instance: 'talk-test', address: PHONE }]);
    expect((await contactRow(c.id)).avatarPath).toBe(`avatars/${c.id}.png`);
  });

  it('GET /api/chats/:id looks the picture up only when never checked or stale', async () => {
    ({ app } = await makeTestApp(ctx));
    const auth = await loginAs(app, seed.agentB.email);
    const c = await insertContact();
    const chat = await chatFor(c.id);
    const open = () => app!.inject({ method: 'GET', url: `/api/chats/${chat.id}`, headers: auth.headers });

    expect((await open()).statusCode).toBe(200);
    await avatarRefreshesIdle();
    expect(ctx.wa.pictureLookups).toEqual([{ instance: 'talk-test', address: PHONE }]);

    await open();
    await avatarRefreshesIdle();
    expect(ctx.wa.pictureLookups).toHaveLength(1);
  });

  it('opening a conversation on a disconnected channel does not look it up', async () => {
    ({ app } = await makeTestApp(ctx));
    const auth = await loginAs(app, seed.agentB.email);
    const c = await insertContact();
    const chat = await chatFor(c.id, (await otherChannel('disconnected')).id);
    expect((await app.inject({ method: 'GET', url: `/api/chats/${chat.id}`, headers: auth.headers })).statusCode).toBe(200);
    await avatarRefreshesIdle();
    expect(ctx.wa.pictureLookups).toEqual([]);
    expect((await contactRow(c.id)).avatarCheckedAt).toBeNull();
  });
});

describe('avatar sweep of never-checked contacts', () => {
  it('looks up never-checked contacts through the channel of their latest chat, skipping disconnected ones', async () => {
    ctx.wa.profilePictures.set(PHONE, PIC_URL);
    const viaLatest = await insertContact();
    const other = await otherChannel('connected');
    const older = await chatFor(viaLatest.id);
    await ctx.db.update(chats).set({ lastMessageAt: new Date(Date.now() - DAY) }).where(eq(chats.id, older.id));
    await chatFor(viaLatest.id, other.id);
    await ctx.db.update(chats).set({ lastMessageAt: new Date() }).where(eq(chats.channelId, other.id));

    const offline = await insertContact({ phone: '5565999990002' });
    await chatFor(offline.id, (await otherChannel('disconnected')).id);
    const checked = await insertContact({ phone: '5565999990003', avatarCheckedAt: new Date(Date.now() - 30 * DAY) });
    await chatFor(checked.id);
    await insertContact({ phone: '5565999990004' }); // no chat: no channel to ask

    const sweep = createAvatarSweep(ctx, { gapMs: 0 });
    expect(await sweep.sweep()).toBe(1);
    expect(ctx.wa.pictureLookups).toEqual([{ instance: other.evolutionInstance, address: PHONE }]);
    expect((await contactRow(viaLatest.id)).avatarPath).toBe(`avatars/${viaLatest.id}.png`);
    expect(ctx.hub.events.filter((e) => e.type === 'chat').length).toBeGreaterThan(0);
    expect(await sweep.sweep()).toBe(0); // nothing left
  });

  it('caps a sweep at `limit` contacts and survives a failing lookup', async () => {
    for (let i = 0; i < 3; i++) await chatFor((await insertContact({ phone: `556599999100${i}` })).id);
    ctx.wa.profilePictures.set('5565999991000', new Error('Evolution 500'));
    const sweep = createAvatarSweep(ctx, { gapMs: 0, limit: 2 });
    expect(await sweep.sweep()).toBe(2);
    expect(await sweep.sweep()).toBe(1);
    expect(ctx.wa.pictureLookups).toHaveLength(3);
  });

  it('start runs a sweep right away, waits between lookups and stop ends it cleanly', async () => {
    for (let i = 0; i < 2; i++) await chatFor((await insertContact({ phone: `556599999200${i}` })).id);
    const sweep = createAvatarSweep(ctx, { gapMs: 60_000 });
    sweep.start();
    await vi.waitFor(() => expect(ctx.wa.pictureLookups).toHaveLength(1));
    await sweep.stop(); // resolves without waiting out the 60 s gap
    expect(ctx.wa.pictureLookups).toHaveLength(1);
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
    expect(res.headers['content-security-policy']).toBe('sandbox');
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

  it('is 404 for a stored path that escapes mediaDir, even when that file exists', async () => {
    const { auth, without } = await setup();
    const name = `${randomUUID()}.png`;
    const outside = join(ctx.config.mediaDir, '..', name);
    await writeFile(outside, PNG);
    try {
      await ctx.db.update(contacts).set({ avatarPath: `../${name}` }).where(eq(contacts.id, without.id));
      const res = await app!.inject({ method: 'GET', url: `/api/contacts/${without.id}/avatar`, headers: auth.headers });
      expect(res.statusCode).toBe(404);
    } finally {
      await rm(outside, { force: true });
    }
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
