// Personal preferences (spec 2026-10-19 §6), stored per user on the server (users.preferences jsonb).
// Runtime code with no imports: tsx (server) and Vite (web) load this source directly.

export const BROWSER_NOTIFICATION_MODES = ['always', 'background', 'never'] as const;
/** "Sempre" | "Só quando a aba está em segundo plano" | "Nunca". */
export type BrowserNotificationMode = (typeof BROWSER_NOTIFICATION_MODES)[number];

/** "Som da notificação", in the order the Preferências select shows them. */
export const SOUNDS = [
  { value: 'soft', label: 'Suave' },
  { value: 'drop', label: 'Gota' },
  { value: 'bell', label: 'Sino' },
] as const;
export type NotificationSound = (typeof SOUNDS)[number]['value'];
export const SOUND_VALUES = SOUNDS.map((s) => s.value) as [NotificationSound, ...NotificationSound[]];

export interface UserPreferences {
  /** On: Enter sends, Shift+Enter breaks the line. Off: Enter breaks the line, Ctrl/Cmd+Enter sends. */
  enterSends: boolean;
  /** A short sound for a new contact message (never for the chat on screen in a visible tab). */
  sounds: boolean;
  /** Which sound; optional so older literals compile, readers fall back to 'soft'. */
  sound?: NotificationSound;
  browserNotifications: BrowserNotificationMode;
}

/** What a user who never changed anything gets. 'background' keeps the old message behavior. */
export const DEFAULT_PREFERENCES: Readonly<UserPreferences> = {
  enterSends: true,
  sounds: true,
  sound: 'soft',
  browserNotifications: 'background',
};
