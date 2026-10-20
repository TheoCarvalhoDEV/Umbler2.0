import { loadConfig } from './config.js';
import { createPgDb } from './db/client.js';
import { runMigrations } from './db/migrate.js';
import { createEvolutionGateway } from './whatsapp/evolution.js';
import { createHub } from './realtime/hub.js';
import { buildApp } from './app.js';
import { syncChannelStatuses, syncWebhooks } from './channels/service.js';
import { failInterruptedSends } from './messages/send.js';
import { createBotRuntime } from './bots/runtime.js';
import { failInterruptedRuns } from './bots/engine.js';
import { createScheduler } from './bots/scheduler.js';
import { createAvatarSweep } from './contacts/avatar.js';
import { createHistoryWorker } from './history/jobs.js';
import type { AppCtx } from './ctx.js';

const config = loadConfig(process.env);
const db = createPgDb(config.databaseUrl);
await runMigrations(db);
await failInterruptedSends(db); // before listen: nothing can be mid-send yet
await failInterruptedRuns(db); // same: a bot run still 'running' died with the previous process; frees its chat

const ctx: AppCtx = {
  db,
  wa: createEvolutionGateway(config.evolution),
  hub: createHub(() => db),
  config,
  botRuntime: createBotRuntime(),
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

// Boot (§5.6) and then every minute: a connection.update Evolution sent while the app was down is lost, which left a
// channel on "connecting" while the instance was open. setChannelStatus only writes and publishes when the status changes.
const syncStatuses = () => syncChannelStatuses(ctx).catch((err: unknown) => app.log.error({ err }, 'falha ao sincronizar status dos canais'));
void syncStatuses();
setInterval(syncStatuses, 60_000).unref();
// Once per boot: existing instances get today's webhook events (MESSAGES_DELETE since "ações de mensagem"). Never throws
// per channel; only a failing DB read reaches this catch.
syncWebhooks(ctx).catch((err: unknown) => app.log.error({ err }, 'falha ao atualizar os webhooks dos canais'));

await app.listen({ host: '0.0.0.0', port: config.port });

// Waiting bot runs live in the DB; every 5 s this wakes the due ones (wait_interval timers and reply timeouts).
const scheduler = createScheduler(ctx);
scheduler.start();

// Contacts never checked for a WhatsApp picture (e.g. only written to): now, then hourly, one every 3 s.
const avatarSweep = createAvatarSweep(ctx);
avatarSweep.start();

// History spec §5-6: import passes (repeated every 2 min after a QR), the 5-min back-fill (also now, at boot) and the
// media queue (<= 21 days, one at a time). State lives in the DB: a restart resumes.
const history = createHistoryWorker(ctx);
history.start();

// Node as PID 1 in Docker ignores SIGTERM unless handled; close cleanly so `docker compose stop` is fast
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    scheduler.stop();
    void avatarSweep.stop();
    void history.stop();
    void app.close().then(() => process.exit(0));
  });
}
