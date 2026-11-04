/**
 * Colour theme: the user's choice (localStorage), defaulting to the OS preference.
 * The resolved theme is written to <html data-theme>; styles.css keys the dark palette off it.
 * index.html applies the saved theme before first paint to avoid a light flash.
 */
export type ThemePref = 'light' | 'dark' | 'system';
export const THEME_KEY = 'blackbox.theme';
const ORDER: ThemePref[] = ['light', 'dark', 'system'];

const media = () => (typeof window !== 'undefined' && window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null);

export function getThemePref(): ThemePref {
  try {
    const saved = localStorage.getItem(THEME_KEY);
    if (saved === 'light' || saved === 'dark' || saved === 'system') return saved;
  } catch {
    /* no storage */
  }
  return 'system';
}

export function resolveTheme(pref: ThemePref): 'light' | 'dark' {
  if (pref !== 'system') return pref;
  return media()?.matches ? 'dark' : 'light';
}

export function applyTheme(pref: ThemePref = getThemePref()) {
  document.documentElement.dataset.theme = resolveTheme(pref);
}

export function setThemePref(pref: ThemePref) {
  try {
    localStorage.setItem(THEME_KEY, pref);
  } catch {
    /* no storage */
  }
  applyTheme(pref);
}

export const nextThemePref = (pref: ThemePref): ThemePref => ORDER[(ORDER.indexOf(pref) + 1) % ORDER.length];

/** Apply now and keep following the OS while the preference is "system". */
export function initTheme() {
  applyTheme();
  media()?.addEventListener?.('change', () => {
    if (getThemePref() === 'system') applyTheme('system');
  });
}
