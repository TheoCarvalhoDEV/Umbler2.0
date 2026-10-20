import { describe, it, expect, vi } from 'vitest';
import { createEvolutionGateway, jidOf } from '../../src/whatsapp/evolution.js';
import { GatewayError } from '../../src/whatsapp/types.js';

const PHONE = '5565999999999';
const JSON_HEADERS = { apikey: 'k-123', 'content-type': 'application/json' };

// Builds a gateway whose fetch always answers `status` + `body` and records each request.
function setup(status: number, body: unknown) {
  const fetchMock = vi.fn<typeof fetch>(async () =>
    new Response(typeof body === 'string' ? body : JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    }),
  );
  // Trailing slash on purpose: the gateway must not produce "//instance".
  const wa = createEvolutionGateway({ url: 'http://evolution:8080/', apiKey: 'k-123' }, fetchMock);
  const req = (i = 0) => {
    const [url, init] = fetchMock.mock.calls[i]!;
    return {
      url: String(url),
      method: init?.method,
      headers: init?.headers,
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : init?.body,
    };
  };
  return { wa, fetchMock, req };
}

const SENT_MESSAGE = {
  key: { remoteJid: `${PHONE}@s.whatsapp.net`, fromMe: true, id: '3EB0ABCDEF' },
  message: { conversation: 'Olá' },
  messageTimestamp: '1760440000',
  status: 'PENDING',
};

describe('createEvolutionGateway', () => {
  it('createInstance posts a Baileys instance with QR, groups ignored and our webhook', async () => {
    const { wa, req } = setup(201, { instance: { instanceName: 'talk-abc', status: 'connecting' }, hash: 'x' });
    await expect(wa.createInstance('talk-abc', 'http://app:3000/webhooks/evolution/s3cr3t')).resolves.toBeUndefined();
    expect(req()).toEqual({
      url: 'http://evolution:8080/instance/create',
      method: 'POST',
      headers: JSON_HEADERS,
      body: {
        instanceName: 'talk-abc',
        integration: 'WHATSAPP-BAILEYS',
        qrcode: true,
        groupsIgnore: true,
        webhook: {
          enabled: true,
          url: 'http://app:3000/webhooks/evolution/s3cr3t',
          byEvents: false,
          base64: false,
          events: ['MESSAGES_UPSERT', 'MESSAGES_UPDATE', 'MESSAGES_DELETE', 'CONNECTION_UPDATE', 'QRCODE_UPDATED'],
        },
      },
    });
  });

  it('connect GETs /instance/connect and returns the QR data URL', async () => {
    const { wa, req } = setup(200, { pairingCode: null, code: '2@abc', base64: 'data:image/png;base64,QRDATA', count: 1 });
    expect(await wa.connect('talk-abc')).toEqual({ qrBase64: 'data:image/png;base64,QRDATA' });
    expect(req()).toEqual({ url: 'http://evolution:8080/instance/connect/talk-abc', method: 'GET', headers: JSON_HEADERS, body: undefined });
  });

  it('connect returns null when the instance is already open', async () => {
    const { wa } = setup(200, { instance: { instanceName: 'talk-abc', state: 'open' } });
    expect(await wa.connect('talk-abc')).toEqual({ qrBase64: null });
  });

  it.each([
    ['open', 'connected'],
    ['connecting', 'connecting'],
    ['close', 'disconnected'],
  ] as const)('connectionState maps %s to %s', async (state, expected) => {
    const { wa, req } = setup(200, { instance: { instanceName: 'talk-abc', state } });
    expect(await wa.connectionState('talk-abc')).toBe(expected);
    expect(req()).toEqual({ url: 'http://evolution:8080/instance/connectionState/talk-abc', method: 'GET', headers: JSON_HEADERS, body: undefined });
  });

  it('sendText posts number + text and returns key.id', async () => {
    const { wa, req } = setup(201, SENT_MESSAGE);
    expect(await wa.sendText('talk-abc', PHONE, 'Olá')).toEqual({ externalId: '3EB0ABCDEF' });
    expect(req()).toEqual({
      url: 'http://evolution:8080/message/sendText/talk-abc',
      method: 'POST',
      headers: JSON_HEADERS,
      body: { number: PHONE, text: 'Olá' },
    });
  });

  it('sendText sends quoted with key and inline message', async () => {
    const { wa, req } = setup(201, SENT_MESSAGE);
    await wa.sendText('talk-abc', PHONE, 'Resposta', { externalId: 'QUOTED1', body: 'Pergunta', fromMe: false });
    expect(req().body).toEqual({
      number: PHONE,
      text: 'Resposta',
      quoted: {
        key: { id: 'QUOTED1', fromMe: false, remoteJid: `${PHONE}@s.whatsapp.net` },
        message: { conversation: 'Pergunta' },
      },
    });
  });

  it('sendMedia posts base64 media with mediatype, mimetype, fileName, caption and quoted', async () => {
    const { wa, req } = setup(201, SENT_MESSAGE);
    const res = await wa.sendMedia(
      'talk-abc',
      PHONE,
      { kind: 'document', base64: 'JVBERi0=', mime: 'application/pdf', fileName: 'contrato.pdf', caption: 'Segue' },
      { externalId: 'QUOTED2', body: null, fromMe: true },
    );
    expect(res).toEqual({ externalId: '3EB0ABCDEF' });
    expect(req()).toEqual({
      url: 'http://evolution:8080/message/sendMedia/talk-abc',
      method: 'POST',
      headers: JSON_HEADERS,
      body: {
        number: PHONE,
        mediatype: 'document',
        mimetype: 'application/pdf',
        media: 'JVBERi0=',
        fileName: 'contrato.pdf',
        caption: 'Segue',
        quoted: {
          key: { id: 'QUOTED2', fromMe: true, remoteJid: `${PHONE}@s.whatsapp.net` },
          message: { conversation: '' },
        },
      },
    });
  });

  it('sendAudio posts to sendWhatsAppAudio with base64 audio', async () => {
    const { wa, req } = setup(201, SENT_MESSAGE);
    expect(await wa.sendAudio('talk-abc', PHONE, 'T2dnUw==')).toEqual({ externalId: '3EB0ABCDEF' });
    expect(req()).toEqual({
      url: 'http://evolution:8080/message/sendWhatsAppAudio/talk-abc',
      method: 'POST',
      headers: JSON_HEADERS,
      body: { number: PHONE, audio: 'T2dnUw==' },
    });
  });

  it('sendAudio sends quoted when replying', async () => {
    const { wa, req } = setup(201, SENT_MESSAGE);
    await wa.sendAudio('talk-abc', PHONE, 'T2dnUw==', { externalId: 'QUOTED3', body: 'Pergunta', fromMe: false });
    expect(req().body).toEqual({
      number: PHONE,
      audio: 'T2dnUw==',
      quoted: {
        key: { id: 'QUOTED3', fromMe: false, remoteJid: `${PHONE}@s.whatsapp.net` },
        message: { conversation: 'Pergunta' },
      },
    });
  });

  it('addresses a LID contact as-is, including the quoted remoteJid', async () => {
    const { wa, req } = setup(201, SENT_MESSAGE);
    await wa.sendText('talk-abc', '123456789@lid', 'Oi', { externalId: 'Q4', body: 'x', fromMe: false });
    expect(req().body).toMatchObject({ number: '123456789@lid', quoted: { key: { remoteJid: '123456789@lid' } } });
  });

  it('every call carries an abort signal (timeout)', async () => {
    const { wa, fetchMock } = setup(201, SENT_MESSAGE);
    await wa.sendText('talk-abc', PHONE, 'Oi');
    expect(fetchMock.mock.calls[0]![1]?.signal).toBeInstanceOf(AbortSignal);
  });

  it('downloadMedia posts the raw webhook message and maps the response', async () => {
    const raw = { key: { id: 'IN1', remoteJid: `${PHONE}@s.whatsapp.net`, fromMe: false }, message: { imageMessage: { mimetype: 'image/jpeg' } } };
    const { wa, req } = setup(201, {
      mediaType: 'imageMessage',
      fileName: 'IN1.jpeg',
      caption: null,
      size: { fileLength: { low: 10, high: 0, unsigned: true }, height: 1, width: 1 },
      mimetype: 'image/jpeg',
      base64: '/9j/4AAQ',
      buffer: null,
    });
    expect(await wa.downloadMedia('talk-abc', raw)).toEqual({ base64: '/9j/4AAQ', mime: 'image/jpeg', fileName: 'IN1.jpeg' });
    expect(req()).toEqual({
      url: 'http://evolution:8080/chat/getBase64FromMediaMessage/talk-abc',
      method: 'POST',
      headers: JSON_HEADERS,
      body: { message: raw, convertToMp4: false },
    });
  });

  it('fetchProfilePicture posts { number } and returns profilePictureUrl', async () => {
    const { wa, req } = setup(200, { wuid: `${PHONE}@s.whatsapp.net`, profilePictureUrl: 'https://pps.whatsapp.net/v/x.jpg' });
    expect(await wa.fetchProfilePicture('talk-abc', PHONE)).toBe('https://pps.whatsapp.net/v/x.jpg');
    expect(req()).toEqual({
      url: 'http://evolution:8080/chat/fetchProfilePictureUrl/talk-abc',
      method: 'POST',
      headers: JSON_HEADERS,
      body: { number: PHONE },
    });
  });

  it('fetchProfilePicture returns null when the contact has no picture (field absent or null)', async () => {
    // Real 2.3.7 answer for a LID without a picture: {"wuid":"123@lid"} (profilePictureUrl undefined, dropped by JSON).
    expect(await setup(200, { wuid: '123@lid' }).wa.fetchProfilePicture('talk-abc', '123@lid')).toBeNull();
    expect(await setup(200, { wuid: 'x', profilePictureUrl: null }).wa.fetchProfilePicture('talk-abc', PHONE)).toBeNull();
  });

  it('downloadMedia throws when Evolution returns no base64', async () => {
    const { wa } = setup(201, '');
    await expect(wa.downloadMedia('talk-abc', {})).rejects.toThrow(/no media/);
  });

  it('throws with status and a truncated body on non-2xx', async () => {
    const { wa } = setup(400, 'x'.repeat(1000));
    const err = (await wa.sendText('talk-abc', PHONE, 'Olá').catch((e: unknown) => e)) as Error;
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toContain('Evolution POST /message/sendText/talk-abc failed: 400');
    expect(err.message).toContain('x'.repeat(300));
    expect(err.message).not.toContain('x'.repeat(301));
  });

  it('throws when a send response has no key.id', async () => {
    const { wa } = setup(201, { error: true, message: 'whatever' });
    await expect(wa.sendText('talk-abc', PHONE, 'Olá')).rejects.toThrow(/no key\.id/);
  });

  it('encodes the instance name in the path', async () => {
    const { wa, req } = setup(200, { instance: { state: 'open' } });
    await wa.connectionState('a b');
    expect(req().url).toBe('http://evolution:8080/instance/connectionState/a%20b');
  });

  it('deleteInstance logs the session out, then deletes the instance; a failed logout (session not open) does not stop it', async () => {
    const { wa, req, fetchMock } = setup(200, { status: 'SUCCESS', error: false });
    fetchMock.mockResolvedValueOnce(new Response('{"status":400,"error":"Bad Request"}', { status: 400 }));
    await expect(wa.deleteInstance('talk-abc')).resolves.toBeUndefined();
    expect(req(0)).toEqual({ url: 'http://evolution:8080/instance/logout/talk-abc', method: 'DELETE', headers: JSON_HEADERS, body: undefined });
    expect(req(1)).toEqual({ url: 'http://evolution:8080/instance/delete/talk-abc', method: 'DELETE', headers: JSON_HEADERS, body: undefined });
  });

  it('deleteInstance rejects with the status when the delete itself fails', async () => {
    const { wa } = setup(404, { status: 404, error: 'Not Found' });
    await expect(wa.deleteInstance('talk-abc')).rejects.toMatchObject({ name: 'GatewayError', status: 404 });
  });

  it('findMessages posts both ISO bounds, the offset and the page, and reads the page', async () => {
    const record = { key: { id: 'A1', remoteJid: '556599999999@s.whatsapp.net', fromMe: false }, messageTimestamp: 1790000000 };
    const { wa, req } = setup(200, { messages: { total: 1, pages: 1, currentPage: 2, records: [record] } });
    await expect(
      wa.findMessages('talk-abc', { gte: new Date('2026-09-01T00:00:00Z'), lte: new Date('2026-09-30T23:59:59Z'), page: 2, offset: 500 }),
    ).resolves.toEqual({ total: 1, pages: 1, records: [record] });
    expect(req()).toEqual({
      url: 'http://evolution:8080/chat/findMessages/talk-abc',
      method: 'POST',
      headers: JSON_HEADERS,
      body: { where: { messageTimestamp: { gte: '2026-09-01T00:00:00.000Z', lte: '2026-09-30T23:59:59.000Z' } }, offset: 500, page: 2 },
    });
  });

  it("findMessages caps lte at Evolution's int4 seconds limit", async () => {
    const { wa, req } = setup(200, { messages: { total: 0, pages: 0, currentPage: 1, records: [] } });
    await wa.findMessages('talk-abc', { gte: new Date('2009-01-01T00:00:00Z'), lte: new Date('2100-01-01T00:00:00Z'), page: 1, offset: 500 });
    expect(req().body.where.messageTimestamp.lte).toBe('2038-01-19T03:14:07.000Z');
  });

  it('findMessages answers an empty page for an answer without records', async () => {
    const { wa } = setup(200, {});
    await expect(
      wa.findMessages('talk-abc', { gte: new Date(0), lte: new Date(1000), page: 1, offset: 500 }),
    ).resolves.toEqual({ total: 0, pages: 0, records: [] });
  });

  it('findContacts returns the remoteJid and push name of each Contact row', async () => {
    const { wa, req } = setup(200, [
      { id: 'c1', remoteJid: '201234567890123@lid', pushName: 'Maria Souza', profilePicUrl: null },
      { id: 'c2', remoteJid: '556599999999@s.whatsapp.net', pushName: '' },
      { id: 'c3' },
    ]);
    await expect(wa.findContacts('talk-abc')).resolves.toEqual([
      { remoteJid: '201234567890123@lid', pushName: 'Maria Souza' },
      { remoteJid: '556599999999@s.whatsapp.net', pushName: null },
    ]);
    expect(req()).toMatchObject({ url: 'http://evolution:8080/chat/findContacts/talk-abc', method: 'POST', body: { where: {} } });
  });

  it('downloadMediaById asks Evolution by key.id only', async () => {
    const { wa, req } = setup(201, { mediaType: 'imageMessage', fileName: 'x.jpeg', mimetype: 'image/jpeg', base64: 'QUJD' });
    await expect(wa.downloadMediaById('talk-abc', '3EB0FOTO')).resolves.toEqual({ base64: 'QUJD', mime: 'image/jpeg', fileName: 'x.jpeg' });
    expect(req()).toMatchObject({
      url: 'http://evolution:8080/chat/getBase64FromMediaMessage/talk-abc',
      method: 'POST',
      body: { message: { key: { id: '3EB0FOTO' } }, convertToMp4: false },
    });
  });

  it('a non-2xx answer throws GatewayError carrying the HTTP status', async () => {
    const { wa } = setup(400, { status: 400, error: 'Bad Request', response: { message: ['Error: Failed to fetch stream from https://mmg.whatsapp.net/x'] } });
    const err = await wa.downloadMediaById('talk-abc', '3EB0VELHA').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GatewayError);
    expect(err).toMatchObject({ name: 'GatewayError', status: 400 });
  });
});

const EVENTS = ['MESSAGES_UPSERT', 'MESSAGES_UPDATE', 'MESSAGES_DELETE', 'CONNECTION_UPDATE', 'QRCODE_UPDATED'];

describe('createEvolutionGateway: message actions', () => {
  const key = { address: PHONE, externalId: '3EB0ABCDEF', fromMe: true };
  const JID = '556599999999@s.whatsapp.net';

  it('sendReaction posts the key with the JID Evolution would build; an empty reaction removes it', async () => {
    const { wa, req } = setup(201, SENT_MESSAGE);
    await wa.sendReaction('talk-abc', { ...key, fromMe: false }, '👍');
    await wa.sendReaction('talk-abc', key, '');
    expect(req(0)).toEqual({
      url: 'http://evolution:8080/message/sendReaction/talk-abc',
      method: 'POST',
      headers: JSON_HEADERS,
      body: { key: { remoteJid: JID, fromMe: false, id: '3EB0ABCDEF' }, reaction: '👍' },
    });
    expect(req(1).body).toEqual({ key: { remoteJid: JID, fromMe: true, id: '3EB0ABCDEF' }, reaction: '' });
  });

  it('deleteForEveryone sends DELETE with id, remoteJid and fromMe', async () => {
    const { wa, req } = setup(201, SENT_MESSAGE);
    await expect(wa.deleteForEveryone('talk-abc', key)).resolves.toBeUndefined();
    expect(req()).toEqual({
      url: 'http://evolution:8080/chat/deleteMessageForEveryone/talk-abc',
      method: 'DELETE',
      headers: JSON_HEADERS,
      body: { id: '3EB0ABCDEF', remoteJid: JID, fromMe: true },
    });
  });

  it('editText posts our number, the key and the new text', async () => {
    const { wa, req } = setup(201, SENT_MESSAGE);
    await wa.editText('talk-abc', key, 'Novo texto');
    expect(req()).toEqual({
      url: 'http://evolution:8080/chat/updateMessage/talk-abc',
      method: 'POST',
      headers: JSON_HEADERS,
      body: { number: PHONE, key: { remoteJid: JID, fromMe: true, id: '3EB0ABCDEF' }, text: 'Novo texto' },
    });
  });

  it('sendSticker posts raw base64 as JSON (never multipart) and returns the key id', async () => {
    const { wa, req } = setup(201, SENT_MESSAGE);
    const quoted = { externalId: 'Q1', body: 'oi', fromMe: false };
    await expect(wa.sendSticker('talk-abc', PHONE, 'UklGRg==', quoted)).resolves.toEqual({ externalId: '3EB0ABCDEF' });
    expect(req()).toEqual({
      url: 'http://evolution:8080/message/sendSticker/talk-abc',
      method: 'POST',
      headers: JSON_HEADERS,
      body: {
        number: PHONE,
        sticker: 'UklGRg==',
        quoted: { key: { id: 'Q1', fromMe: false, remoteJid: `${PHONE}@s.whatsapp.net` }, message: { conversation: 'oi' } },
      },
    });
  });

  it('setWebhook replaces the webhook with the same events as createInstance, never MESSAGES_EDITED', async () => {
    const { wa, req } = setup(201, { webhook: {} });
    await wa.setWebhook('talk-abc', 'http://app:3000/webhooks/evolution/s3cr3t');
    expect(req()).toEqual({
      url: 'http://evolution:8080/webhook/set/talk-abc',
      method: 'POST',
      headers: JSON_HEADERS,
      body: { webhook: { enabled: true, url: 'http://app:3000/webhooks/evolution/s3cr3t', byEvents: false, base64: false, events: EVENTS } },
    });
    expect(req().body.webhook.events).not.toContain('MESSAGES_EDITED');
  });

  it('uses a LID address as-is', async () => {
    const { wa, req } = setup(201, SENT_MESSAGE);
    await wa.deleteForEveryone('talk-abc', { ...key, address: '201234567890123@lid' });
    expect(req().body).toEqual({ id: '3EB0ABCDEF', remoteJid: '201234567890123@lid', fromMe: true });
  });

  it('throws on a non-2xx answer, like every call', async () => {
    const { wa } = setup(400, { message: 'Message not found' });
    await expect(wa.editText('talk-abc', key, 'x')).rejects.toThrow(/Evolution POST \/chat\/updateMessage\/talk-abc failed: 400/);
  });
});

describe('jidOf', () => {
  it('drops the 9th digit like Evolution createJid (Review Focus 2)', () => {
    expect(jidOf('5565999999999')).toBe('556599999999@s.whatsapp.net');
    expect(jidOf('5531987654321')).toBe('553187654321@s.whatsapp.net');
    expect(jidOf('5511987654321')).toBe('5511987654321@s.whatsapp.net'); // DDD below 31 keeps it
    expect(jidOf('5565961234567')).toBe('5565961234567@s.whatsapp.net'); // subscriber starting below 7 keeps it
    expect(jidOf('556532221111')).toBe('556532221111@s.whatsapp.net'); // 12 digits: untouched
    expect(jidOf('201234567890123@lid')).toBe('201234567890123@lid');
  });
});
