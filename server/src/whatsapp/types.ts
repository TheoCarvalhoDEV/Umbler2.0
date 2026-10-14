export type ChannelStatus = 'disconnected' | 'connecting' | 'connected';
export type MessageKind = 'text' | 'image' | 'audio' | 'video' | 'document' | 'sticker' | 'note' | 'unsupported';
export interface QuotedRef { externalId: string; body: string | null; fromMe: boolean }
export interface SendResult { externalId: string }
export interface OutgoingMedia { kind: 'image' | 'video' | 'document'; base64: string; mime: string; fileName: string; caption?: string }
export interface DownloadedMedia { base64: string; mime: string; fileName?: string }

export interface WhatsAppGateway {
  createInstance(instance: string, webhookUrl: string): Promise<void>;
  connect(instance: string): Promise<{ qrBase64: string | null }>;
  connectionState(instance: string): Promise<ChannelStatus>;
  sendText(instance: string, phone: string, text: string, quoted?: QuotedRef): Promise<SendResult>;
  sendMedia(instance: string, phone: string, media: OutgoingMedia, quoted?: QuotedRef): Promise<SendResult>;
  sendAudio(instance: string, phone: string, base64: string): Promise<SendResult>;
  downloadMedia(instance: string, rawMessage: unknown): Promise<DownloadedMedia>;
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
