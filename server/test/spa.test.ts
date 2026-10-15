import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { loginAs, makeTestCtx, seedBasics } from './helpers.js';

let app: FastifyInstance;

afterEach(async () => {
  await app.close();
});

async function appWithDist(webDistDir: string | null) {
  const ctx = await makeTestCtx();
  const seed = await seedBasics(ctx);
  app = await buildApp({ ...ctx, config: { ...ctx.config, webDistDir } });
  return { app, seed };
}

function fakeBuild(): string {
  const dir = mkdtempSync(join(tmpdir(), 'talk-web-'));
  writeFileSync(join(dir, 'index.html'), '<!doctype html><div id="root"></div><script type="module" src="/assets/app.js"></script>');
  mkdirSync(join(dir, 'assets'));
  writeFileSync(join(dir, 'assets', 'app.js'), 'console.log("talk")');
  return dir;
}

describe('SPA static serving', () => {
  it('serves index.html at / and on client-side routes', async () => {
    await appWithDist(fakeBuild());
    for (const url of ['/', '/conversas/abc']) {
      const res = await app.inject({ method: 'GET', url });
      expect(res.statusCode, url).toBe(200);
      expect(res.headers['content-type'], url).toMatch(/^text\/html/);
      expect(res.body, url).toContain('<script type="module"');
    }
  });

  it('serves the built assets', async () => {
    await appWithDist(fakeBuild());
    const res = await app.inject({ method: 'GET', url: '/assets/app.js' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('console.log("talk")');
  });

  it('keeps unknown /api and /webhooks paths and non-GET requests as JSON 404', async () => {
    const { seed } = await appWithDist(fakeBuild());
    // The auth hook (Task 6) answers anonymous /api/* with 401 before routing, so the 404 needs a session.
    const admin = await loginAs(app, seed.admin.email);
    const cases = [
      ['GET', '/api/nope', admin.headers],
      ['GET', '/webhooks/nope', {}],
      ['POST', '/conversas', {}],
    ] as const;
    for (const [method, url, headers] of cases) {
      const res = await app.inject({ method, url, headers });
      expect(res.statusCode, url).toBe(404);
      expect(res.json(), url).toEqual({ error: 'Não encontrado' });
    }
    // anonymous: still never the SPA shell
    const anonymous = await app.inject({ method: 'GET', url: '/api/nope' });
    expect(anonymous.statusCode).toBe(401);
    expect(anonymous.headers['content-type']).toMatch(/^application\/json/);
  });

  it('without a build, every unknown path is JSON 404', async () => {
    await appWithDist(null);
    const res = await app.inject({ method: 'GET', url: '/conversas' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'Não encontrado' });
  });
});
