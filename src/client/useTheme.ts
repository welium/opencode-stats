/**
 * Theme binding: the stored preference, the system answer, and the attribute
 * the stylesheet keys on.
 *
 * Plan references: §6 "light/dark themes" with local persistence. The value is
 * written to `<html data-theme>`; `styles.css` defines one token block per
 * theme. Persistence goes through `theme.ts`, which tolerates unavailable
 * storage.
 */

import { useCallback, useEffect, useState } from 'react';

import type { ThemePreference } from './theme.ts';

import { safeLocalStorage } from './storage.ts';
import { readTheme, resolveTheme, writeTheme } from './theme.ts';

const DARK_QUERY = '(prefers-color-scheme: dark)';

function prefersDark(): boolean {
  return typeof window.matchMedia === 'function' && window.matchMedia(DARK_QUERY).matches;
}

function currentTheme(): ThemePreference {
  return resolveTheme(readTheme(safeLocalStorage()), prefersDark());
}

/** Apply the resolved theme before the first paint of the React tree. */
export function applyInitialTheme(): void {
  document.documentElement.dataset['theme'] = currentTheme();
}

export interface ThemeControls {
  theme: ThemePreference;
  toggle: () => void;
}

export function useTheme(): ThemeControls {
  const [theme, setTheme] = useState<ThemePreference>(() => currentTheme());

  useEffect(() => {
    document.documentElement.dataset['theme'] = theme;
  }, [theme]);

  useEffect(() => {
    // Only follow the system while the user has expressed no preference.
    if (readTheme(safeLocalStorage()) !== null) return;
    if (typeof window.matchMedia !== 'function') return;
    const query = window.matchMedia(DARK_QUERY);
    const onChange = (event: MediaQueryListEvent): void => {
      setTheme(event.matches ? 'dark' : 'light');
    };
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, [theme]);

  const toggle = useCallback(() => {
    setTheme((previous) => {
      const next: ThemePreference = previous === 'dark' ? 'light' : 'dark';
      writeTheme(safeLocalStorage(), next);
      return next;
    });
  }, []);

  return { theme, toggle };
}
