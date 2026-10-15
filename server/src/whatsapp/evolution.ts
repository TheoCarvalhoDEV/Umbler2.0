// HTTP client for Evolution API v2.3.7 (image evoapicloud/evolution-api:v2.3.7).
// Request and response shapes were checked against the 2.3.7 tag of the source:
// - Route prefixes /instance, /message, /chat:
//   https://github.com/EvolutionAPI/evolution-api/blob/2.3.7/src/api/routes/index.router.ts
// - routerPath(name) → "/<name>/:instanceName":
//   https://github.com/EvolutionAPI/evolution-api/blob/2.3.7/src/api/abstract/abstract.router.ts
// - Routes: POST /instance/create, GET /instance/connect/:i, GET /instance/connectionState/:i
//   https://github.com/EvolutionAPI/evolution-api/blob/2.3.7/src/api/routes/instance.router.ts
// - Routes: POST /message/sendText|sendMedia|sendWhatsAppAudio/:i (201)
//   https://github.com/EvolutionAPI/evolution-api/blob/2.3.7/src/api/routes/sendMessage.router.ts
// - Route: POST /chat/getBase64FromMediaMessage/:i (201); POST /chat/fetchProfilePictureUrl/:i (200, NumberDto)
//   https://github.com/EvolutionAPI/evolution-api/blob/2.3.7/src/api/routes/chat.router.ts
// - Auth header "apikey":
//   https://github.com/EvolutionAPI/evolution-api/blob/2.3.7/src/api/guards/auth.guard.ts
// - InstanceDto: webhook { enabled, url, byEvents, base64, events, headers }, integration, qrcode, groupsIgnore
//   https://github.com/EvolutionAPI/evolution-api/blob/2.3.7/src/api/dto/instance.dto.ts
//   https://github.com/EvolutionAPI/evolution-api/blob/2.3.7/src/api/integrations/event/event.manager.ts
// - SendTextDto { number, text, quoted? }, SendMediaDto { number, mediatype, mimetype, caption, fileName, media },
//   SendAudioDto { number, audio, quoted? } (quoted comes from the shared Metadata base), Quoted { key, message }:
//   https://github.com/EvolutionAPI/evolution-api/blob/2.3.7/src/api/dto/sendMessage.dto.ts
// - NumberDto { number }:
// - getBase64FromMediaMessageDto { message, convertToMp4 }:
//   https://github.com/EvolutionAPI/evolution-api/blob/2.3.7/src/api/dto/chat.dto.ts
// - Response shapes (instance.controller.ts):
//   connectionState → { instance: { instanceName, state } }
//   connect → { pairingCode, code, base64, count }, or the connectionState shape when already open
//   https://github.com/EvolutionAPI/evolution-api/blob/2.3.7/src/api/controllers/instance.controller.ts
// - fetchProfilePictureUrl: chat.controller.ts fetchProfilePicture → profilePicture(data.number) in
//   whatsapp.baileys.service.ts, which returns { wuid, profilePictureUrl } and { wuid, profilePictureUrl: null }
//   on any error (no picture, privacy); createJid keeps '...@lid' as-is:
//   https://raw.githubusercontent.com/EvolutionAPI/evolution-api/2.3.7/src/api/routes/chat.router.ts
//   https://raw.githubusercontent.com/EvolutionAPI/evolution-api/2.3.7/src/api/dto/chat.dto.ts
//   https://raw.githubusercontent.com/EvolutionAPI/evolution-api/2.3.7/src/api/controllers/chat.controller.ts
//   https://raw.githubusercontent.com/EvolutionAPI/evolution-api/2.3.7/src/api/integrations/channel/whatsapp/whatsapp.baileys.service.ts
//   https://raw.githubusercontent.com/EvolutionAPI/evolution-api/2.3.7/src/utils/createJid.ts
// - Response shapes (whatsapp.baileys.service.ts):
//   send* → prepared message with key.id
//   getBase64FromMediaMessage → { mediaType, fileName, caption, size, mimetype, base64 }
//   a quoted object that carries `message` is used as-is (no lookup in Evolution's database)
//   https://github.com/EvolutionAPI/evolution-api/blob/2.3.7/src/api/integrations/channel/whatsapp/whatsapp.baileys.service.ts
import type { ChannelStatus, DownloadedMedia, QuotedRef, SendResult, WhatsAppGateway } from './types.js';

const WEBHOOK_EVENTS = ['MESSAGES_UPSERT', 'MESSAGES_UPDATE', 'CONNECTION_UPDATE', 'QRCODE_UPDATED'];

export function createEvolutionGateway(
  cfg: { url: string; apiKey: string },
  fetchImpl: typeof fetch = fetch,
): WhatsAppGateway {
  const base = cfg.url.replace(/\/+$/, '');

  async function call<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T | null> {
    const res = await fetchImpl(base + path, {
      method,
      headers: { apikey: cfg.apiKey, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      // ponytail: one timeout for every call, just above Baileys' 60 s default query timeout; split per route if media uploads need longer
      signal: AbortSignal.timeout(90_000),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`Evolution ${method} ${path} failed: ${res.status} ${text.slice(0, 300)}`);
    return text ? (JSON.parse(text) as T) : null;
  }

  const seg = (instance: string) => encodeURIComponent(instance);

  // `phone` is our canonical digits or, for a LID-only contact, an already-complete '<lid>@lid' address.
  function quotedPayload(phone: string, q: QuotedRef | undefined) {
    if (!q) return undefined;
    // ponytail: remoteJid uses our canonical 13-digit phone. If WhatsApp knows the contact by its 12-digit JID,
    // the quote still threads by key.id; only the quoted author label may differ. Upgrade: store the real JID per contact.
    return {
      key: { id: q.externalId, fromMe: q.fromMe, remoteJid: phone.includes('@') ? phone : `${phone}@s.whatsapp.net` },
      message: { conversation: q.body ?? '' },
    };
  }

  async function send(path: string, body: unknown): Promise<SendResult> {
    const res = await call<{ key?: { id?: string } }>('POST', path, body);
    const id = res?.key?.id;
    if (!id) throw new Error(`Evolution POST ${path} returned no key.id`);
    return { externalId: id };
  }

  return {
    async createInstance(instance, webhookUrl) {
      await call('POST', '/instance/create', {
        instanceName: instance,
        integration: 'WHATSAPP-BAILEYS',
        qrcode: true,
        groupsIgnore: true,
        webhook: { enabled: true, url: webhookUrl, byEvents: false, base64: false, events: WEBHOOK_EVENTS },
      });
    },

    async connect(instance) {
      const res = await call<{ base64?: string | null }>('GET', `/instance/connect/${seg(instance)}`);
      return { qrBase64: res?.base64 ?? null };
    },

    async connectionState(instance): Promise<ChannelStatus> {
      const res = await call<{ instance?: { state?: string } }>('GET', `/instance/connectionState/${seg(instance)}`);
      const state = res?.instance?.state;
      if (state === 'open') return 'connected';
      if (state === 'connecting') return 'connecting';
      return 'disconnected';
    },

    sendText(instance, phone, text, quoted) {
      return send(`/message/sendText/${seg(instance)}`, { number: phone, text, quoted: quotedPayload(phone, quoted) });
    },

    sendMedia(instance, phone, media, quoted) {
      return send(`/message/sendMedia/${seg(instance)}`, {
        number: phone,
        mediatype: media.kind,
        mimetype: media.mime,
        media: media.base64,
        fileName: media.fileName,
        caption: media.caption,
        quoted: quotedPayload(phone, quoted),
      });
    },

    sendAudio(instance, phone, base64, quoted) {
      return send(`/message/sendWhatsAppAudio/${seg(instance)}`, { number: phone, audio: base64, quoted: quotedPayload(phone, quoted) });
    },

    async downloadMedia(instance, rawMessage): Promise<DownloadedMedia> {
      const res = await call<{ base64?: string; mimetype?: string; fileName?: string }>(
        'POST',
        `/chat/getBase64FromMediaMessage/${seg(instance)}`,
        { message: rawMessage, convertToMp4: false },
      );
      if (!res?.base64) throw new Error('Evolution getBase64FromMediaMessage returned no media');
      return { base64: res.base64, mime: res.mimetype || 'application/octet-stream', fileName: res.fileName || undefined };
    },

    async fetchProfilePicture(instance, address) {
      const res = await call<{ profilePictureUrl?: string | null }>('POST', `/chat/fetchProfilePictureUrl/${seg(instance)}`, {
        number: address,
      });
      return res?.profilePictureUrl || null;
    },
  };
}
