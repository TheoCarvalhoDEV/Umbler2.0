import type { ChannelStatus, SendResult, WhatsAppGateway } from './types.js';

// 1×1 transparent PNG.
const PNG_1X1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

export function createFakeGateway(): WhatsAppGateway & {
  sent: Array<{ method: string; instance: string; phone?: string; payload: unknown }>;
  failNext(err?: Error): void;
  status: Map<string, ChannelStatus>;
} {
  const sent: Array<{ method: string; instance: string; phone?: string; payload: unknown }> = [];
  const status = new Map<string, ChannelStatus>();
  let pendingError: Error | null = null;
  let n = 0;

  // Throws (once) the error armed by failNext. Called first in every method.
  function guard(): void {
    if (pendingError) {
      const err = pendingError;
      pendingError = null;
      throw err;
    }
  }

  function send(method: string, instance: string, phone: string, payload: unknown): SendResult {
    guard();
    sent.push({ method, instance, phone, payload });
    n += 1;
    return { externalId: `fake-${n}` };
  }

  return {
    sent,
    status,
    failNext(err = new Error('fake gateway failure')) {
      pendingError = err;
    },
    async createInstance(instance, webhookUrl) {
      guard();
      sent.push({ method: 'createInstance', instance, payload: { webhookUrl } });
    },
    async connect(instance) {
      guard();
      sent.push({ method: 'connect', instance, payload: null });
      return { qrBase64: status.get(instance) === 'connected' ? null : `data:image/png;base64,${PNG_1X1}` };
    },
    async connectionState(instance) {
      guard();
      return status.get(instance) ?? 'disconnected';
    },
    async sendText(instance, phone, text, quoted) {
      return send('sendText', instance, phone, { text, quoted });
    },
    async sendMedia(instance, phone, media, quoted) {
      return send('sendMedia', instance, phone, { media, quoted });
    },
    async sendAudio(instance, phone, base64, quoted) {
      return send('sendAudio', instance, phone, { base64, quoted });
    },
    async downloadMedia() {
      guard();
      return { base64: PNG_1X1, mime: 'image/png' };
    },
  };
}
