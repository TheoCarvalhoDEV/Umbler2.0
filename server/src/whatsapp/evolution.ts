// HTTP client for Evolution API v2.3.7 (image evoapicloud/evolution-api:v2.3.7).
// Request and response shapes were checked against the 2.3.7 tag of the source:
// - Route prefixes /instance, /message, /chat:
//   https://github.com/EvolutionAPI/evolution-api/blob/2.3.7/src/api/routes/index.router.ts
// - routerPath(name) → "/<name>/:instanceName":
//   https://github.com/EvolutionAPI/evolution-api/blob/2.3.7/src/api/abstract/abstract.router.ts
// - Routes: POST /instance/create, GET /instance/connect/:i, GET /instance/connectionState/:i,
//   DELETE /instance/logout/:i, DELETE /instance/delete/:i
//   https://github.com/EvolutionAPI/evolution-api/blob/2.3.7/src/api/routes/instance.router.ts
// - Routes: POST /message/sendText|sendMedia|sendWhatsAppAudio|sendSticker|sendReaction/:i (201)
//   sendSticker: JSON { number, sticker: raw base64 } (multipart is buggy in 2.3.7); PNG/JPEG converted to WebP by sharp.
//   sendReaction: { key: { remoteJid, fromMe, id }, reaction } with '' removing it (sendMessage.controller.ts isEmoji).
// - Routes: DELETE /chat/deleteMessageForEveryone/:i { id, remoteJid, fromMe }; POST /chat/updateMessage/:i
//   { number, key, text } (rejects when the stored key.remoteJid differs from createJid(number) or the original is not
//   in Evolution's DB); POST /webhook/set/:i { webhook: { enabled, url, byEvents, base64, events } } (webhook.router.ts)
//   https://github.com/EvolutionAPI/evolution-api/blob/2.3.7/src/api/routes/chat.router.ts
//   https://github.com/EvolutionAPI/evolution-api/blob/2.3.7/src/api/integrations/event/webhook/webhook.schema.ts
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
// - Routes: POST /chat/findMessages/:i (200, { messages: { total, pages, currentPage, records } }), POST /chat/findContacts/:i
//   (200, Contact[]); the Baileys channel overrides findMessages (whatsapp.baileys.service.ts fetchMessages): the time filter
//   needs BOTH bounds, values go through new Date() (ISO with Z; epoch seconds would be read as ms), ORDER BY
//   messageTimestamp DESC, offset = page size, page 1-based. messageTimestamp is int4 seconds (lte past 2038 → 500).
// - getBase64FromMediaMessage with only { key: { id } } loads the row by key.id from Evolution's DB (getMessage(key, true));
//   expired media → 400 "Failed to fetch stream" after ~5.5 s (no working re-upload in 2.3.7).
import {
  GatewayError,
  type ChannelStatus,
  type DownloadedMedia,
  type EvolutionContact,
  type QuotedRef,
  type SendResult,
  type WhatsAppGateway,
} from './types.js';

// MESSAGES_DELETE carries revokes (contact, office phone, our own deleteMessageForEveryone). Never MESSAGES_EDITED:
// Evolution 2.3.7 awaits that delivery inside the instance's event queue (whatsapp.baileys.service.ts:1133), so while
// the app is down every later event of the instance waits ~20 min per protocol message. Edits still arrive as
// MESSAGES_UPDATE with message.editedMessage.
const WEBHOOK_EVENTS = ['MESSAGES_UPSERT', 'MESSAGES_UPDATE', 'MESSAGES_DELETE', 'CONNECTION_UPDATE', 'QRCODE_UPDATED'];
const webhookConfig = (url: string) => ({ enabled: true, url, byEvents: false, base64: false, events: WEBHOOK_EVENTS });

// Evolution keeps messageTimestamp as int4 seconds: a bound past 2038-01-19T03:14:07Z is an HTTP 500.
const MAX_TIMESTAMP_MS = Date.UTC(2038, 0, 19, 3, 14, 7);
const isoBound = (d: Date) => new Date(Math.min(d.getTime(), MAX_TIMESTAMP_MS)).toISOString();

function toMedia(res: { base64?: string; mimetype?: string; fileName?: string } | null): DownloadedMedia {
  if (!res?.base64) throw new Error('Evolution getBase64FromMediaMessage returned no media');
  return { base64: res.base64, mime: res.mimetype || 'application/octet-stream', fileName: res.fileName || undefined };
}

/**
 * The chat JID Evolution's createJid (src/utils/createJid.ts, formatBRNumber) builds from a number: a Brazilian
 * 13-digit mobile loses its 9th digit when the DDD is 31 or more and the subscriber number starts at 7 or more.
 * Needed where Evolution takes the JID as-is (deleteMessageForEveryone, reaction and edit keys); a '<lid>@lid' or any
 * full JID passes through.
 */
export function jidOf(address: string): string {
  if (address.includes('@')) return address;
  const m = /^55(\d{2})\d(\d{8})$/.exec(address);
  const digits = m && Number(m[1]) >= 31 && Number(m[2]![0]) >= 7 ? `55${m[1]}${m[2]}` : address;
  return `${digits}@s.whatsapp.net`;
}

export function createEvolutionGateway(
  cfg: { url: string; apiKey: string },
  fetchImpl: typeof fetch = fetch,
): WhatsAppGateway {
  const base = cfg.url.replace(/\/+$/, '');

  async function call<T>(method: 'GET' | 'POST' | 'DELETE', path: string, body?: unknown, timeoutMs = 90_000): Promise<T | null> {
    const res = await fetchImpl(base + path, {
      method,
      headers: { apikey: cfg.apiKey, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      // ponytail: 90 s by default, just above Baileys' 60 s query timeout; a media lookup by id passes 30 s (§5.5)
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    if (!res.ok) throw new GatewayError(`Evolution ${method} ${path} failed: ${res.status} ${text.slice(0, 300)}`, res.status);
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
        webhook: webhookConfig(webhookUrl),
      });
    },

    async connect(instance) {
      const res = await call<{ base64?: string | null }>('GET', `/instance/connect/${seg(instance)}`);
      return { qrBase64: res?.base64 ?? null };
    },

    async deleteInstance(instance) {
      // Logout first, so the phone drops the linked device; a session that is not open answers an error here, which is fine.
      await call('DELETE', `/instance/logout/${seg(instance)}`).catch(() => undefined);
      await call('DELETE', `/instance/delete/${seg(instance)}`);
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
      return toMedia(
        await call<{ base64?: string; mimetype?: string; fileName?: string }>(
          'POST',
          `/chat/getBase64FromMediaMessage/${seg(instance)}`,
          { message: rawMessage, convertToMp4: false },
        ),
      );
    },

    async fetchProfilePicture(instance, address) {
      const res = await call<{ profilePictureUrl?: string | null }>('POST', `/chat/fetchProfilePictureUrl/${seg(instance)}`, {
        number: address,
      });
      return res?.profilePictureUrl || null;
    },

    async findMessages(instance, q) {
      const res = await call<{ messages?: { total?: unknown; pages?: unknown; records?: unknown } }>(
        'POST',
        `/chat/findMessages/${seg(instance)}`,
        // Both bounds, always: with only one, Evolution 2.3.7 silently drops the time filter.
        { where: { messageTimestamp: { gte: isoBound(q.gte), lte: isoBound(q.lte) } }, offset: q.offset, page: q.page },
      );
      const m = res?.messages;
      return {
        total: Number(m?.total) || 0,
        pages: Number(m?.pages) || 0,
        records: Array.isArray(m?.records) ? m.records : [],
      };
    },

    async findContacts(instance): Promise<EvolutionContact[]> {
      const res = await call<unknown>('POST', `/chat/findContacts/${seg(instance)}`, { where: {} });
      if (!Array.isArray(res)) return [];
      return res.flatMap((row: unknown) => {
        const c = row as { remoteJid?: unknown; pushName?: unknown } | null;
        if (typeof c?.remoteJid !== 'string') return [];
        return [{ remoteJid: c.remoteJid, pushName: typeof c.pushName === 'string' && c.pushName ? c.pushName : null }];
      });
    },

    async downloadMediaById(instance, externalId): Promise<DownloadedMedia> {
      return toMedia(
        await call<{ base64?: string; mimetype?: string; fileName?: string }>(
          'POST',
          `/chat/getBase64FromMediaMessage/${seg(instance)}`,
          { message: { key: { id: externalId } }, convertToMp4: false },
          30_000,
        ),
      );
    },

    async sendReaction(instance, key, emoji) {
      await call('POST', `/message/sendReaction/${seg(instance)}`, {
        key: { remoteJid: jidOf(key.address), fromMe: key.fromMe, id: key.externalId },
        reaction: emoji,
      });
    },

    async deleteForEveryone(instance, key) {
      await call('DELETE', `/chat/deleteMessageForEveryone/${seg(instance)}`, {
        id: key.externalId,
        remoteJid: jidOf(key.address),
        fromMe: key.fromMe,
      });
    },

    async editText(instance, key, text) {
      // `number` goes through Evolution's own createJid; the key's remoteJid must already be that JID.
      await call('POST', `/chat/updateMessage/${seg(instance)}`, {
        number: key.address,
        key: { remoteJid: jidOf(key.address), fromMe: key.fromMe, id: key.externalId },
        text,
      });
    },

    sendSticker(instance, phone, base64, quoted) {
      return send(`/message/sendSticker/${seg(instance)}`, { number: phone, sticker: base64, quoted: quotedPayload(phone, quoted) });
    },

    async setWebhook(instance, webhookUrl) {
      await call('POST', `/webhook/set/${seg(instance)}`, { webhook: webhookConfig(webhookUrl) });
    },
  };
}
