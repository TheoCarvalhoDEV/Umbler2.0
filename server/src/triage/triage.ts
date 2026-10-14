import { eq } from 'drizzle-orm';
import { z } from 'zod';
import type { Db, Tx } from '../db/client.js';
import { settings } from '../db/schema.js';

export interface TriageOption { key: string; label: string; sectorId: string }
export interface TriageMenu { enabled: boolean; welcomeText: string; invalidText: string; options: TriageOption[] }

// Stored shape is snake_case, exactly as spec §4.
const storedMenu = z.object({
  enabled: z.boolean(),
  welcome_text: z.string(),
  invalid_text: z.string(),
  options: z.array(z.object({ key: z.string(), label: z.string(), sector_id: z.string() })),
});

export async function getTriageMenu(db: Db | Tx): Promise<TriageMenu> {
  const [row] = await db.select({ value: settings.value }).from(settings).where(eq(settings.key, 'triage_menu'));
  const parsed = storedMenu.safeParse(row?.value);
  if (!parsed.success) return { enabled: false, welcomeText: '', invalidText: '', options: [] };
  const v = parsed.data;
  return {
    enabled: v.enabled,
    welcomeText: v.welcome_text,
    invalidText: v.invalid_text,
    options: v.options.map((o) => ({ key: o.key, label: o.label, sectorId: o.sector_id })),
  };
}

// Lowercase, strip accents, trim, drop surrounding punctuation, collapse inner spaces.
function normalize(s: string): string {
  return s
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '')
    .replace(/\s+/g, ' ');
}

export function matchTriageOption(text: string, menu: TriageMenu, sectorNames: Map<string, string>): TriageOption | null {
  const t = normalize(text);
  if (!t) return null;
  return (
    menu.options.find((o) => {
      const sectorName = sectorNames.get(o.sectorId);
      if (sectorName === undefined) return false; // sector was deleted
      return [o.key, o.label, sectorName].some((candidate) => normalize(candidate) === t);
    }) ?? null
  );
}
