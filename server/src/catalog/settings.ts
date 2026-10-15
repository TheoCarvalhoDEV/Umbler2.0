import { eq, inArray } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { SettingsDto } from '@talk/shared';
import type { AppCtx } from '../ctx.js';
import type { Db } from '../db/client.js';
import { sectors, settings } from '../db/schema.js';
import { badRequest, forbidden } from '../lib/http-error.js';
import { getTriageMenu } from '../triage/triage.js';

const Body = z.object({
  closingMessage: z.string().trim().max(2000),
  triageMenu: z
    .object({
      enabled: z.boolean(),
      welcomeText: z.string().trim().max(2000),
      invalidText: z.string().trim().max(2000),
      options: z
        .array(z.object({ key: z.string().trim().min(1).max(10), label: z.string().trim().min(1).max(60), sectorId: z.uuid() }))
        .max(20),
    })
    .refine((m) => !m.enabled || m.options.length > 0, { error: 'O menu ativo precisa de pelo menos uma opção' })
    .refine((m) => new Set(m.options.map((o) => o.key.toLowerCase())).size === m.options.length, {
      error: 'Há opções com o mesmo número',
    }),
});

async function readSettings(db: Db): Promise<SettingsDto> {
  const [row] = await db.select({ value: settings.value }).from(settings).where(eq(settings.key, 'closing_message'));
  return { closingMessage: typeof row?.value === 'string' ? row.value : '', triageMenu: await getTriageMenu(db) };
}

export function registerSettingsRoutes(app: FastifyInstance, ctx: AppCtx): void {
  app.get('/api/settings', async () => readSettings(ctx.db));

  app.put('/api/settings', async (req) => {
    if (req.user.role !== 'admin') throw forbidden();
    const b = Body.parse(req.body);
    const sectorIds = [...new Set(b.triageMenu.options.map((o) => o.sectorId))];
    if (sectorIds.length && (await ctx.db.$count(sectors, inArray(sectors.id, sectorIds))) !== sectorIds.length) {
      throw badRequest('O menu de triagem aponta para um setor que não existe');
    }
    // Stored snake_case exactly as spec §4; triage/getTriageMenu reads it back.
    const triage = {
      enabled: b.triageMenu.enabled,
      welcome_text: b.triageMenu.welcomeText,
      invalid_text: b.triageMenu.invalidText,
      options: b.triageMenu.options.map((o) => ({ key: o.key, label: o.label, sector_id: o.sectorId })),
    };
    await ctx.db.transaction(async (tx) => {
      await tx
        .insert(settings)
        .values({ key: 'closing_message', value: b.closingMessage })
        .onConflictDoUpdate({ target: settings.key, set: { value: b.closingMessage } });
      await tx
        .insert(settings)
        .values({ key: 'triage_menu', value: triage })
        .onConflictDoUpdate({ target: settings.key, set: { value: triage } });
    });
    return readSettings(ctx.db);
  });
}
