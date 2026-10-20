export type ChannelStatus = 'disconnected' | 'connecting' | 'connected';
export type MessageKind = 'text' | 'image' | 'audio' | 'video' | 'document' | 'sticker' | 'note' | 'unsupported';
export interface QuotedRef { externalId: string; body: string | null; fromMe: boolean }
export interface SendResult { externalId: string }
export interface OutgoingMedia { kind: 'image' | 'video' | 'document'; base64: string; mime: string; fileName: string; caption?: string }
export interface DownloadedMedia { base64: string; mime: string; fileName?: string }
/** A message in a 1:1 chat. `address` as in waAddress: canonical phone digits or '<lid>@lid'. */
export interface MessageKeyRef { address: string; externalId: string; fromMe: boolean }
/** One page of Evolution's POST /chat/findMessages; records are raw Message rows (key, pushName, message, messageType, messageTimestamp, contextInfo…). */
export interface MessagePage { total: number; pages: number; records: unknown[] }
/** A row of Evolution's Contact table (DATABASE_SAVE_DATA_CONTACTS=true): the phone's address-book or push name. */
export interface EvolutionContact { remoteJid: string; pushName: string | null }

/** A non-2xx answer from Evolution. `status` tells "media expired" (400) from a temporary failure. */
export class GatewayError extends Error {
  override name = 'GatewayError';
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export interface WhatsAppGateway {
  createInstance(instance: string, webhookUrl: string): Promise<void>;
  connect(instance: string): Promise<{ qrBase64: string | null }>;
  connectionState(instance: string): Promise<ChannelStatus>;
  /** Logs the WhatsApp session out (the phone drops the linked device) and removes the instance; GatewayError 404 = already gone. */
  deleteInstance(instance: string): Promise<void>;
  sendText(instance: string, phone: string, text: string, quoted?: QuotedRef): Promise<SendResult>;
  sendMedia(instance: string, phone: string, media: OutgoingMedia, quoted?: QuotedRef): Promise<SendResult>;
  sendAudio(instance: string, phone: string, base64: string, quoted?: QuotedRef): Promise<SendResult>;
  downloadMedia(instance: string, rawMessage: unknown): Promise<DownloadedMedia>;
  /** URL of the contact's profile picture, or null when there is none. `address` as in waAddress (phone or '<lid>@lid'). */
  fetchProfilePicture(instance: string, address: string): Promise<string | null>;
  /** '' removes the reaction (spec §3). */
  sendReaction(instance: string, key: MessageKeyRef, emoji: string): Promise<void>;
  deleteForEveryone(instance: string, key: MessageKeyRef): Promise<void>;
  /** Text or caption of a message the office sent. Evolution needs the original in its own DB (DATABASE_SAVE_DATA_NEW_MESSAGE). */
  editText(instance: string, key: MessageKeyRef, text: string): Promise<void>;
  /** PNG, JPEG or WebP as raw base64; Evolution converts it to WebP. */
  sendSticker(instance: string, phone: string, base64: string, quoted?: QuotedRef): Promise<SendResult>;
  /** Replaces the instance's webhook URL and event list (createInstance only sets them at creation). */
  setWebhook(instance: string, webhookUrl: string): Promise<void>;
  /** Evolution's stored messages with messageTimestamp in [gte, lte] (inclusive, whole seconds), newest first; `page` is 1-based. */
  findMessages(instance: string, q: { gte: Date; lte: Date; page: number; offset: number }): Promise<MessagePage>;
  /** Every Contact row Evolution keeps for the instance. */
  findContacts(instance: string): Promise<EvolutionContact[]>;
  /** Media of a message Evolution has stored, looked up by key.id; GatewayError 400 when WhatsApp no longer has the file. */
  downloadMediaById(instance: string, externalId: string): Promise<DownloadedMedia>;
}

export type InboundEvent =
  | { type: 'message'; instance: string; externalId: string; direction: 'in' | 'out';
      phone: string | null; lid: string | null; pushName: string | null;
      kind: MessageKind; body: string | null; hasMedia: boolean;
      mediaMime: string | null; mediaName: string | null;
      replyToExternalId: string | null; sentAt: Date; raw: unknown }
  // fromMe: the office reacted (from its phone, or the echo of our own sendReaction). parse.ts always fills it.
  | { type: 'reaction'; instance: string; targetExternalId: string; emoji: string | null; fromMe?: boolean }
  // Deleted for everyone: by the contact, or (fromMe) by the office phone or our own deleteMessageForEveryone.
  | { type: 'revoke'; instance: string; targetExternalId: string; fromMe: boolean }
  // An edit; text null = WhatsApp's encrypted edit format, the new text is unknown.
  | { type: 'edit'; instance: string; targetExternalId: string; fromMe: boolean; text: string | null }
  | { type: 'status'; instance: string; externalId: string; status: 'sent' | 'delivered' | 'read' | 'failed' }
  | { type: 'connection'; instance: string; status: ChannelStatus; phone: string | null } // phone from `wuid` (owner JID) via phoneFromJid, null when absent
  | { type: 'qrcode'; instance: string; qrBase64: string }
  | { type: 'ignored'; reason: string };
