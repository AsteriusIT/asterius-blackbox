import { afterEach, describe, expect, it, vi } from 'vitest';
import { THEME_KEY, applyTheme, getThemePref, setThemePref } from '../src/lib/theme';

const mockOsDark = (dark: boolean) => vi.stubGlobal('matchMedia', (q: string) => ({ matches: dark && q.includes('dark'), addEventListener: () => undefined }));

afterEach(() => {
  localStorage.clear();
  vi.unstubAllGlobals();
  delete document.documentElement.dataset.theme;
});

describe('theme', () => {
  it('defaults to following the OS', () => {
    expect(getThemePref()).toBe('system');
    mockOsDark(true);
    applyTheme();
    expect(document.documentElement.dataset.theme).toBe('dark');
    mockOsDark(false);
    applyTheme();
    expect(document.documentElement.dataset.theme).toBe('light');
  });

  it('persists an explicit choice over the OS preference', () => {
    mockOsDark(true);
    setThemePref('light');
    expect(localStorage.getItem(THEME_KEY)).toBe('light');
    expect(getThemePref()).toBe('light');
    expect(document.documentElement.dataset.theme).toBe('light');
  });

  it('ignores garbage in storage', () => {
    localStorage.setItem(THEME_KEY, 'purple');
    expect(getThemePref()).toBe('system');
  });
});
