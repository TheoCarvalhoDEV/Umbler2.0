import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

export interface Config {
  port: number;
  databaseUrl: string;
  appOrigin: string;
  cookieSecure: boolean;
  webhookSecret: string;
  webhookBaseUrl: string;
  mediaDir: string;
  webDistDir: string | null;
  evolution: { url: string; apiKey: string };
  sessionDays: number;
  /** Spec 2026-10-21 importar-umbler §10: the Umbler access token; null = not configured. Never logged, stored or sent to the web. */
  umblerToken: string | null;
}

const baseUrl = z.url().transform((u) => u.replace(/\/+$/, ''));

const envSchema = z.object({
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.string().min(1),
  // Compared byte-for-byte with the browser's Origin header, so keep only scheme://host[:port].
  APP_ORIGIN: z.url().transform((u) => new URL(u).origin),
  COOKIE_SECURE: z.stringbool().default(true),
  WEBHOOK_SECRET: z.string().min(32),
  WEBHOOK_BASE_URL: baseUrl.default('http://app:3000'),
  MEDIA_DIR: z.string().min(1).default('/data/media'),
  WEB_DIST_DIR: z.string().optional(),
  EVOLUTION_URL: baseUrl,
  EVOLUTION_API_KEY: z.string().min(1),
  // optional; empty = absent (docker-compose passes UMBLER_TOKEN: ${UMBLER_TOKEN:-})
  UMBLER_TOKEN: z.string().optional().transform((v) => v?.trim() || null),
});

const defaultWebDist = fileURLToPath(new URL('../../web/dist', import.meta.url));

export function loadConfig(env: NodeJS.ProcessEnv): Config {
  const parsed = envSchema.safeParse(env);
  // prettifyError lists paths and messages only, never the (secret) values.
  if (!parsed.success) throw new Error(`Configuração inválida:\n${z.prettifyError(parsed.error)}`);
  const e = parsed.data;
  return {
    port: e.PORT,
    databaseUrl: e.DATABASE_URL,
    appOrigin: e.APP_ORIGIN,
    cookieSecure: e.COOKIE_SECURE,
    webhookSecret: e.WEBHOOK_SECRET,
    webhookBaseUrl: e.WEBHOOK_BASE_URL,
    mediaDir: e.MEDIA_DIR,
    webDistDir: e.WEB_DIST_DIR === undefined ? defaultWebDist : e.WEB_DIST_DIR === '' ? null : path.resolve(e.WEB_DIST_DIR),
    evolution: { url: e.EVOLUTION_URL, apiKey: e.EVOLUTION_API_KEY },
    sessionDays: 30,
    umblerToken: e.UMBLER_TOKEN,
  };
}
