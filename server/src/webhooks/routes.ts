import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { AppCtx } from '../ctx.js';
import { handleInbound } from '../messages/ingest.js';
import { parseEvolutionWebhook } from '../whatsapp/parse.js';

function secretMatches(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Evolution → app, internal Docker network only (Caddy does not proxy /webhooks/*). No session, no Origin check. */
export function registerWebhookRoutes(app: FastifyInstance, ctx: AppCtx): void {
  app.post<{ Params: { secret: string } }>('/webhooks/evolution/:secret', async (req, reply) => {
    if (!secretMatches(req.params.secret, ctx.config.webhookSecret)) {
      return reply.code(401).send({ error: 'Não autorizado' });
    }
    const events = parseEvolutionWebhook(req.body);
    for (const ev of events) {
      if (ev.type === 'ignored') req.log.warn({ reason: ev.reason }, 'evolution webhook ignorado'); // reason only, never the body
    }
    await handleInbound(ctx, events);
    return reply.code(200).send({ ok: true });
  });
}
