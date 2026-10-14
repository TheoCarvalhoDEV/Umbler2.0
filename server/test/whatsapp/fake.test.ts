import { describe, it, expect } from 'vitest';
import { createFakeGateway } from '../../src/whatsapp/fake.js';
import { makeTestCtx } from '../helpers.js';

describe('createFakeGateway', () => {
  it('returns sequential fake external ids shared by all send methods and records each send', async () => {
    const wa = createFakeGateway();
    const quoted = { externalId: 'ABC', body: 'oi', fromMe: false };
    const media = { kind: 'document' as const, base64: 'JVBERi0=', mime: 'application/pdf', fileName: 'a.pdf' };

    expect(await wa.sendText('talk-test', '5565999999999', 'Olá', quoted)).toEqual({ externalId: 'fake-1' });
    expect(await wa.sendMedia('talk-test', '5565999999999', media)).toEqual({ externalId: 'fake-2' });
    expect(await wa.sendAudio('talk-test', '5565999999999', 'T2dnUw==')).toEqual({ externalId: 'fake-3' });

    expect(wa.sent).toEqual([
      { method: 'sendText', instance: 'talk-test', phone: '5565999999999', payload: { text: 'Olá', quoted } },
      { method: 'sendMedia', instance: 'talk-test', phone: '5565999999999', payload: { media, quoted: undefined } },
      { method: 'sendAudio', instance: 'talk-test', phone: '5565999999999', payload: { base64: 'T2dnUw==' } },
    ]);
  });

  it('records createInstance and connect but not read-only calls', async () => {
    const wa = createFakeGateway();
    await wa.createInstance('talk-test', 'http://app:3000/webhooks/evolution/s');
    await wa.connect('talk-test');
    await wa.connectionState('talk-test');
    await wa.downloadMedia('talk-test', { key: { id: 'X' } });

    expect(wa.sent).toEqual([
      { method: 'createInstance', instance: 'talk-test', payload: { webhookUrl: 'http://app:3000/webhooks/evolution/s' } },
      { method: 'connect', instance: 'talk-test', payload: null },
    ]);
  });

  it('failNext makes only the next call reject, with the given or a default error', async () => {
    const wa = createFakeGateway();
    const boom = new Error('evolution down');
    wa.failNext(boom);
    await expect(wa.sendText('talk-test', '5565999999999', 'a')).rejects.toBe(boom);
    expect(wa.sent).toEqual([]);
    expect(await wa.sendText('talk-test', '5565999999999', 'b')).toEqual({ externalId: 'fake-1' });

    wa.failNext();
    await expect(wa.downloadMedia('talk-test', {})).rejects.toThrow('fake gateway failure');
    await expect(wa.downloadMedia('talk-test', {})).resolves.toMatchObject({ mime: 'image/png' });
  });

  it('connectionState reflects the status map and defaults to disconnected', async () => {
    const wa = createFakeGateway();
    expect(await wa.connectionState('talk-test')).toBe('disconnected');
    wa.status.set('talk-test', 'connected');
    expect(await wa.connectionState('talk-test')).toBe('connected');
  });

  it('connect returns a PNG data URL unless already connected', async () => {
    const wa = createFakeGateway();
    const { qrBase64 } = await wa.connect('talk-test');
    expect(qrBase64).toMatch(/^data:image\/png;base64,/);
    wa.status.set('talk-test', 'connected');
    expect(await wa.connect('talk-test')).toEqual({ qrBase64: null });
  });

  it('downloadMedia returns a real 1x1 PNG', async () => {
    const wa = createFakeGateway();
    const media = await wa.downloadMedia('talk-test', {});
    expect(media.mime).toBe('image/png');
    const bytes = Buffer.from(media.base64, 'base64');
    expect(bytes.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  });
});

describe('makeTestCtx', () => {
  it('wires the fake gateway into ctx.wa', async () => {
    const ctx = await makeTestCtx();
    expect(ctx.wa.sent).toEqual([]);
    expect(await ctx.wa.sendText('talk-test', '5565999999999', 'x')).toEqual({ externalId: 'fake-1' });
    ctx.wa.failNext();
    await expect(ctx.wa.connectionState('talk-test')).rejects.toThrow('fake gateway failure');
  });
});
