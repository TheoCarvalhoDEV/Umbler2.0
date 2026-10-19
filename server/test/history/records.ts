// Rows as Evolution 2.3.7's POST /chat/findMessages returns them (the Message table): history rows have
// key { remoteJid, fromMe, id } only; live rows of LID chats add remoteJidAlt (the phone JID) and addressingMode.
// History push names are the JID's digits (Evolution's fallback), never a real name.

export const PHONE_JID = '556599999999@s.whatsapp.net'; // 12 digits, as WhatsApp sends a DDD ≥ 31 mobile
export const PHONE = '5565999999999'; // contacts.phone after normalizePhoneBR
export const LID = '201234567890123';
export const LID_JID = `${LID}@lid`;

/** Unix seconds, as Evolution stores messageTimestamp. */
export const sec = (iso: string) => Math.floor(Date.parse(iso) / 1000);

export interface RecOpts {
  id: string;
  at: string; // ISO
  jid?: string;
  alt?: string; // remoteJidAlt: present only on live rows of LID chats
  fromMe?: boolean;
  text?: string;
  pushName?: string;
  messageType?: string;
  message?: Record<string, unknown>;
  contextInfo?: Record<string, unknown> | null;
  timestamp?: unknown; // overrides messageTimestamp (pass undefined to leave it out)
}

export function rec(o: RecOpts): Record<string, unknown> {
  const key: Record<string, unknown> = { remoteJid: o.jid ?? PHONE_JID, fromMe: o.fromMe ?? false, id: o.id };
  if (o.alt) Object.assign(key, { remoteJidAlt: o.alt, addressingMode: 'lid', participant: '' });
  const jidUser = String(key.remoteJid).split('@')[0];
  return {
    id: `row-${o.id}`,
    key,
    pushName: o.pushName ?? (o.fromMe ? 'Você' : jidUser),
    messageType: o.messageType ?? 'conversation',
    message: o.message ?? { conversation: o.text ?? `texto ${o.id}` },
    messageTimestamp: 'timestamp' in o ? o.timestamp : sec(o.at),
    instanceId: 'inst-1',
    source: 'android',
    contextInfo: o.contextInfo ?? null,
    MessageUpdate: [],
  };
}

export function imageRec(o: Omit<RecOpts, 'message' | 'messageType'>): Record<string, unknown> {
  return rec({
    ...o,
    messageType: 'imageMessage',
    message: {
      imageMessage: { url: 'https://mmg.whatsapp.net/v/x.enc', mimetype: 'image/jpeg', mediaKey: 'a2V5', directPath: '/v/x.enc', fileLength: '1234' },
    },
  });
}
