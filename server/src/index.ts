import { loadConfig } from './config.js';
import { createPgDb } from './db/client.js';
import { runMigrations } from './db/migrate.js';
import { createEvolutionGateway } from './whatsapp/evolution.js';
import { createHub } from './realtime/hub.js';
import { buildApp } from './app.js';
import { syncChannelStatuses } from './channels/service.js';
import type { AppCtx } from './ctx.js';

const config = loadConfig(process.env);
const db = createPgDb(config.databaseUrl);
await runMigrations(db);

const ctx: AppCtx = {
  db,
  wa: createEvolutionGateway(config.evolution),
  hub: createHub(() => db),
  config,
};
const app = await buildApp(ctx, {
  // Only Caddy is in front (§6), over the private Docker network: req.ip is the client's, so the login limit is
  // per client IP. Fastify 5.12 fails closed on a hop count (trustProxy: 1 is a type error and trusts nobody),
  // so trust the private ranges instead: a public peer can never spoof X-Forwarded-For.
  trustProxy: 'loopback,linklocal,uniquelocal',
  logger: {
    level: 'info',
    serializers: {
      // the webhook secret sits in the URL path; never write it to the request log
      req: (r) => ({ method: r.method, url: r.url?.replace(/^\/webhooks\/evolution\/[^/?]+/, '/webhooks/evolution/***') }),
    },
  },
});

// ponytail: one-shot correction at boot (§5.6), no periodic polling; on failure the stored status stays until the next connection.update
syncChannelStatuses(ctx).catch((err: unknown) => app.log.error({ err }, 'falha ao sincronizar status dos canais'));

await app.listen({ host: '0.0.0.0', port: config.port });

// Node as PID 1 in Docker ignores SIGTERM unless handled; close cleanly so `docker compose stop` is fast
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    void app.close().then(() => process.exit(0));
  });
}
