import { afterEach, describe, expect, it, vi } from 'vitest';
import { THEME_KEY, applyTheme, readThemePref, setThemePref } from './theme';

function mockSystem(light: boolean) {
  vi.stubGlobal('matchMedia', (q: string) => ({ matches: light && q.includes('light'), addEventListener() {} }));
}

afterEach(() => {
  localStorage.clear();
  vi.unstubAllGlobals();
});

describe('theme', () => {
  it('follows the system while no choice is saved', () => {
    mockSystem(true);
    applyTheme();
    expect(document.documentElement.dataset.theme).toBe('light');
    mockSystem(false);
    applyTheme();
    expect(document.documentElement.dataset.theme).toBe('dark');
  });

  it('a saved choice wins over the system and "system" clears it', () => {
    mockSystem(true);
    setThemePref('dark');
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(localStorage.getItem(THEME_KEY)).toBe('dark');
    setThemePref('system');
    expect(readThemePref()).toBe('system');
    expect(document.documentElement.dataset.theme).toBe('light');
  });
});
