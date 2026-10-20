// Spec 2026-10-19 §6: per-user preferences. users.preferences holds only what the user changed.
import { z } from 'zod';
import { BROWSER_NOTIFICATION_MODES, DEFAULT_PREFERENCES, type UserPreferences } from '@talk/shared';

/** Every field optional (a PUT names only what changed); an unknown field is refused. */
export const preferencesSchema = z
  .strictObject({
    enterSends: z.boolean(),
    sounds: z.boolean(),
    browserNotifications: z.enum(BROWSER_NOTIFICATION_MODES),
  })
  .partial();

/** The stored jsonb over the defaults. Anything the schema does not accept (an old value) falls back to the defaults. */
export function readPreferences(stored: unknown): UserPreferences {
  const parsed = preferencesSchema.safeParse(stored ?? {});
  return { ...DEFAULT_PREFERENCES, ...(parsed.success ? parsed.data : {}) };
}
