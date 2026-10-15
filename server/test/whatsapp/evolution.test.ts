import { describe, it, expect, vi } from 'vitest';
import { createEvolutionGateway } from '../../src/whatsapp/evolution.js';

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
          events: ['MESSAGES_UPSERT', 'MESSAGES_UPDATE', 'CONNECTION_UPDATE', 'QRCODE_UPDATED'],
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
});
