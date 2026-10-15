// Light/dark theme. index.css keys the light palette on <html data-theme="light">; index.html runs the same
// resolution inline before first paint so the page never flashes dark. Keep the two in sync.
export type ThemePref = 'system' | 'light' | 'dark';

export const THEME_KEY = 'talk.theme';

export function readThemePref(): ThemePref {
  try {
    const v = localStorage.getItem(THEME_KEY);
    return v === 'light' || v === 'dark' ? v : 'system';
  } catch {
    return 'system'; // storage blocked (private window)
  }
}

function systemLight(): MediaQueryList | null {
  return typeof window.matchMedia === 'function' ? window.matchMedia('(prefers-color-scheme: light)') : null;
}

export function applyTheme(pref: ThemePref = readThemePref()): void {
  const light = pref === 'light' || (pref === 'system' && (systemLight()?.matches ?? false));
  document.documentElement.dataset.theme = light ? 'light' : 'dark';
}

export function setThemePref(pref: ThemePref): void {
  try {
    if (pref === 'system') localStorage.removeItem(THEME_KEY);
    else localStorage.setItem(THEME_KEY, pref);
  } catch {
    // storage blocked: the choice lasts until the page reloads
  }
  applyTheme(pref);
}

/** Follows the OS switching light/dark while the preference is "system". Call once at startup. */
export function watchSystemTheme(): void {
  systemLight()?.addEventListener('change', () => applyTheme());
}
