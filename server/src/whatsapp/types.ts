export type ChannelStatus = 'disconnected' | 'connecting' | 'connected';
export type MessageKind = 'text' | 'image' | 'audio' | 'video' | 'document' | 'sticker' | 'note' | 'unsupported';
export interface QuotedRef { externalId: string; body: string | null; fromMe: boolean }
export interface SendResult { externalId: string }
export interface OutgoingMedia { kind: 'image' | 'video' | 'document'; base64: string; mime: string; fileName: string; caption?: string }
export interface DownloadedMedia { base64: string; mime: string; fileName?: string }
/** A message in a 1:1 chat. `address` as in waAddress: canonical phone digits or '<lid>@lid'. */
export interface MessageKeyRef { address: string; externalId: string; fromMe: boolean }

export interface WhatsAppGateway {
  createInstance(instance: string, webhookUrl: string): Promise<void>;
  connect(instance: string): Promise<{ qrBase64: string | null }>;
  connectionState(instance: string): Promise<ChannelStatus>;
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
}

export type InboundEvent =
  | { type: 'message'; instance: string; externalId: string; direction: 'in' | 'out';
      phone: string | null; lid: string | null; pushName: string | null;
      kind: MessageKind; body: string | null; hasMedia: boolean;
      mediaMime: string | null; mediaName: string | null;
      replyToExternalId: string | null; sentAt: Date; raw: unknown }
  | { type: 'reaction'; instance: string; targetExternalId: string; emoji: string | null }
  | { type: 'status'; instance: string; externalId: string; status: 'sent' | 'delivered' | 'read' | 'failed' }
  | { type: 'connection'; instance: string; status: ChannelStatus; phone: string | null } // phone from `wuid` (owner JID) via phoneFromJid, null when absent
  | { type: 'qrcode'; instance: string; qrBase64: string }
  | { type: 'ignored'; reason: string };
