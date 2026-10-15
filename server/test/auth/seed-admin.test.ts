import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { seedAdmin } from '../../src/auth/seed-admin.js';
import type { AppCtx } from '../../src/ctx.js';
import { loginAs, makeTestApp } from '../helpers.js';

let app: FastifyInstance;
let ctx: AppCtx;

beforeEach(async () => {
  ({ app, ctx } = await makeTestApp());
});

afterEach(async () => {
  await app.close();
});

describe('seedAdmin', () => {
  it('creates an active admin (email lowercased) who can log in', async () => {
    const admin = await seedAdmin(ctx.db, { email: ' Dono@JVO.adv.br ', name: 'Dono', password: 'senha-do-dono' });
    expect(admin).toMatchObject({ email: 'dono@jvo.adv.br', name: 'Dono', role: 'admin', signature: null, sectorIds: [] });
    const { headers } = await loginAs(app, 'dono@jvo.adv.br', 'senha-do-dono');
    const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers });
    expect(me.json()).toMatchObject({ id: admin.id, role: 'admin' });
  });

  it('refuses a duplicate email', async () => {
    await seedAdmin(ctx.db, { email: 'dono@jvo.adv.br', name: 'Dono', password: 'senha-do-dono' });
    await expect(seedAdmin(ctx.db, { email: 'DONO@jvo.adv.br', name: 'Outro', password: 'outra-senha' })).rejects.toMatchObject({
      status: 409,
    });
  });

  it('refuses a short password or missing name/email', async () => {
    await expect(seedAdmin(ctx.db, { email: 'a@b.c', name: 'A', password: '1234567' })).rejects.toMatchObject({ status: 400 });
    await expect(seedAdmin(ctx.db, { email: '', name: 'A', password: 'senha-longa' })).rejects.toMatchObject({ status: 400 });
    await expect(seedAdmin(ctx.db, { email: 'a@b.c', name: ' ', password: 'senha-longa' })).rejects.toMatchObject({ status: 400 });
  });
});
