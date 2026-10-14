import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { AppCtx } from '../ctx.js';
import { HttpError } from '../lib/http-error.js';
import { handleInbound } from '../messages/ingest.js';
import { parseEvolutionWebhook } from '../whatsapp/parse.js';
import type { InboundEvent } from '../whatsapp/types.js';

const sha256 = (value: string) => createHash('sha256').update(value).digest();

const eventName = (body: unknown) =>
  body && typeof body === 'object' && 'event' in body ? String((body as { event: unknown }).event) : null;

export function registerWebhookRoutes(app: FastifyInstance, ctx: AppCtx): void {
  const expected = sha256(ctx.config.webhookSecret);

  app.post<{ Params: { secret: string } }>(
    '/webhooks/evolution/:secret',
    { bodyLimit: 16 * 1024 * 1024 },
    async (request, reply) => {
      // hashing both sides makes the lengths equal, so the compare is constant-time and never throws
      if (!timingSafeEqual(sha256(request.params.secret), expected)) throw new HttpError(401, 'Não autorizado');

      let events: InboundEvent[];
      try {
        events = parseEvolutionWebhook(request.body);
      } catch {
        // §7: unknown payload → 200 + warning, never crash; log only the event name, never the body
        request.log.warn({ event: eventName(request.body) }, 'webhook: payload não reconhecido');
        return { ok: true };
      }
      for (const e of events) {
        if (e.type === 'ignored') request.log.info({ reason: e.reason }, 'webhook: evento ignorado');
      }

      try {
        await handleInbound(ctx, events);
      } catch (err) {
        // 500 makes Evolution retry (it does not retry 4xx); ingest is idempotent on (channel_id, external_id).
        // Log only the error code: driver/Drizzle messages may carry query params, i.e. message bodies.
        const e = err as { code?: unknown; cause?: { code?: unknown } };
        request.log.error({ code: e.code ?? e.cause?.code ?? null, event: eventName(request.body) }, 'webhook: falha ao gravar');
        return reply.code(500).send({ error: 'Ocorreu um erro' });
      }
      return { ok: true };
    },
  );
}
