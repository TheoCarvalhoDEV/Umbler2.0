import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import type { AppCtx } from '../src/ctx.js';
import { notFound } from '../src/lib/http-error.js';

// Task 1 stub: AppCtx only has `config` until Tasks 2/4/8 add db, wa and hub.
const ctx: AppCtx = {
  config: loadConfig({
    DATABASE_URL: 'postgres://unused',
    APP_ORIGIN: 'http://localhost:5173',
    WEBHOOK_SECRET: 'x'.repeat(32),
    EVOLUTION_URL: 'http://evolution:8080',
    EVOLUTION_API_KEY: 'evo-key',
  }),
};

let app: FastifyInstance;
afterEach(async () => {
  await app.close();
});

describe('buildApp', () => {
  it('GET /api/health returns ok', async () => {
    app = await buildApp(ctx);
    const res = await app.inject({ method: 'GET', url: '/api/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
  });

  it('maps HttpError to its status and message', async () => {
    app = await buildApp(ctx);
    app.get('/t/http', async () => {
      throw notFound();
    });
    const res = await app.inject({ method: 'GET', url: '/t/http' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'Não encontrado' });
  });

  it('maps zod errors to 400', async () => {
    app = await buildApp(ctx);
    app.get('/t/zod', async () => z.object({ a: z.string() }).parse({}));
    const res = await app.inject({ method: 'GET', url: '/t/zod' });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'Requisição inválida' });
  });

  it('keeps Fastify 4xx errors (malformed JSON body) as 4xx', async () => {
    app = await buildApp(ctx);
    app.post('/t/echo', async (req) => req.body);
    const res = await app.inject({
      method: 'POST',
      url: '/t/echo',
      headers: { 'content-type': 'application/json' },
      payload: '{not json',
    });
    expect(res.statusCode).toBe(400);
    expect(typeof res.json().error).toBe('string');
  });

  it('hides unexpected errors behind a correlation id', async () => {
    app = await buildApp(ctx);
    app.get('/t/boom', async () => {
      throw new Error('segredo interno');
    });
    const res = await app.inject({ method: 'GET', url: '/t/boom' });
    expect(res.statusCode).toBe(500);
    const body = res.json();
    expect(body.error).toBe('Ocorreu um erro');
    expect(typeof body.correlationId).toBe('string');
    expect(res.body).not.toContain('segredo');
  });
});
