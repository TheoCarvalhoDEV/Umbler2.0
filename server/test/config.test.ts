import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

const base = {
  DATABASE_URL: 'postgres://talk:talk@localhost:5432/talk',
  APP_ORIGIN: 'http://localhost:5173',
  WEBHOOK_SECRET: 'x'.repeat(32),
  EVOLUTION_URL: 'http://evolution:8080',
  EVOLUTION_API_KEY: 'evo-key',
};

describe('loadConfig', () => {
  it('applies defaults', () => {
    const c = loadConfig(base);
    expect(c.port).toBe(3000);
    expect(c.databaseUrl).toBe(base.DATABASE_URL);
    expect(c.appOrigin).toBe('http://localhost:5173');
    expect(c.cookieSecure).toBe(true);
    expect(c.webhookSecret).toBe(base.WEBHOOK_SECRET);
    expect(c.webhookBaseUrl).toBe('http://app:3000');
    expect(c.mediaDir).toBe('/data/media');
    expect(c.webDistDir).toBe(path.resolve(import.meta.dirname, '../../web/dist'));
    expect(c.evolution).toEqual({ url: 'http://evolution:8080', apiKey: 'evo-key' });
    expect(c.sessionDays).toBe(30);
  });

  it('parses overrides and normalizes URLs', () => {
    const c = loadConfig({
      ...base,
      PORT: '8080',
      COOKIE_SECURE: 'false',
      APP_ORIGIN: 'https://talk.jvo.adv.br/',
      WEBHOOK_BASE_URL: 'http://app:3000/',
      EVOLUTION_URL: 'http://evolution:8080/',
      MEDIA_DIR: '/tmp/media',
      WEB_DIST_DIR: '',
    });
    expect(c.port).toBe(8080);
    expect(c.cookieSecure).toBe(false);
    expect(c.appOrigin).toBe('https://talk.jvo.adv.br');
    expect(c.webhookBaseUrl).toBe('http://app:3000');
    expect(c.evolution.url).toBe('http://evolution:8080');
    expect(c.mediaDir).toBe('/tmp/media');
    expect(c.webDistDir).toBeNull();
  });

  it('rejects a short webhook secret', () => {
    expect(() => loadConfig({ ...base, WEBHOOK_SECRET: 'curto' })).toThrow(/WEBHOOK_SECRET/);
  });

  it('rejects missing required variables', () => {
    const { DATABASE_URL: _omit, ...rest } = base;
    expect(() => loadConfig(rest)).toThrow(/DATABASE_URL/);
  });

  it('rejects an APP_ORIGIN that is not a URL', () => {
    expect(() => loadConfig({ ...base, APP_ORIGIN: 'talk.jvo.adv.br' })).toThrow(/APP_ORIGIN/);
  });
});
