import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { makeTestCtx } from '../helpers.js';
import { settings } from '../../src/db/schema.js';
import { getTriageMenu, matchTriageOption, type TriageMenu } from '../../src/triage/triage.js';

const sectorNames = new Map<string, string>([
  ['s-fin', 'Financeiro'],
  ['s-jur', 'Jurídico'],
]);

const menu: TriageMenu = {
  enabled: true,
  welcomeText: 'Olá! Escolha uma opção:',
  invalidText: 'Opção inválida.',
  options: [
    { key: '1', label: 'Financeiro e boletos', sectorId: 's-fin' },
    { key: '2', label: 'Processos', sectorId: 's-jur' },
    { key: '3', label: 'Setor apagado', sectorId: 's-gone' },
  ],
};

describe('matchTriageOption', () => {
  it.each([
    ['1', '1'],
    [' 2 ', '2'],
    ['1.', '1'],
    ['(2)', '2'],
    ['2)', '2'],
    ['financeiro', '1'],
    ['FINANCEIRO!', '1'],
    ['Financeiro e boletos', '1'],
    ['financeiro   e  boletos', '1'],
    ['Jurídico', '2'],
    ['juridico', '2'],
    ['JURIDICO.', '2'],
    ['processos', '2'],
    ['"Processos"', '2'],
  ])('%j matches option %s', (text, key) => {
    expect(matchTriageOption(text, menu, sectorNames)?.key).toBe(key);
  });

  it.each([
    ['3'], // option whose sector no longer exists
    ['setor apagado'],
    ['12'],
    [''],
    ['   '],
    ['...'],
    ['oi, quero falar com o financeiro'],
  ])('%j matches nothing', (text) => {
    expect(matchTriageOption(text, menu, sectorNames)).toBeNull();
  });
});

describe('getTriageMenu', () => {
  it('returns a disabled empty menu when the setting is missing', async () => {
    const ctx = await makeTestCtx();
    await ctx.db.delete(settings).where(eq(settings.key, 'triage_menu'));
    expect(await getTriageMenu(ctx.db)).toEqual({ enabled: false, welcomeText: '', invalidText: '', options: [] });
  });

  it('returns a disabled empty menu when the stored value is malformed', async () => {
    const ctx = await makeTestCtx();
    await ctx.db
      .insert(settings)
      .values({ key: 'triage_menu', value: { enabled: 'sim' } })
      .onConflictDoUpdate({ target: settings.key, set: { value: { enabled: 'sim' } } });
    expect(await getTriageMenu(ctx.db)).toEqual({ enabled: false, welcomeText: '', invalidText: '', options: [] });
  });

  it('maps the snake_case jsonb to TriageMenu', async () => {
    const ctx = await makeTestCtx();
    const value = {
      enabled: true,
      welcome_text: 'Olá!',
      invalid_text: 'Não entendi.',
      options: [{ key: '1', label: 'Financeiro', sector_id: 's-fin' }],
    };
    await ctx.db
      .insert(settings)
      .values({ key: 'triage_menu', value })
      .onConflictDoUpdate({ target: settings.key, set: { value } });
    expect(await getTriageMenu(ctx.db)).toEqual({
      enabled: true,
      welcomeText: 'Olá!',
      invalidText: 'Não entendi.',
      options: [{ key: '1', label: 'Financeiro', sectorId: 's-fin' }],
    });
  });
});
