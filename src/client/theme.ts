/**
 * Theme preference: reading, resolving, and persisting light/dark.
 *
 * Plan references: §6 "Theme preference and range may be stored locally; do not
 * persist returned session data. Handle unavailable local storage gracefully."
 *
 * The module is pure: it takes a `StorageLike` (or null) and a
 * `prefers-color-scheme` answer rather than reaching for `window`, so the
 * server test project can exercise the fallbacks under Node's type stripping.
 */

export type ThemePreference = 'light' | 'dark';

/** Only the two preferences are stored; "follow the system" is the absence of a value. */
export const THEME_STORAGE_KEY = 'opencode-dashboard.theme';
export const RANGE_STORAGE_KEY = 'opencode-dashboard.range';

/** Minimal storage surface, so tests can substitute a failing implementation. */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export function isThemePreference(value: unknown): value is ThemePreference {
  return value === 'light' || value === 'dark';
}

/** Stored preference, or null when unset or unrecognized. */
export function readTheme(storage: StorageLike | null): ThemePreference | null {
  if (storage === null) return null;
  try {
    const raw = storage.getItem(THEME_STORAGE_KEY);
    return isThemePreference(raw) ? raw : null;
  } catch {
    return null;
  }
}

/** Persist a preference; a storage failure is ignored, never surfaced. */
export function writeTheme(storage: StorageLike | null, theme: ThemePreference): void {
  if (storage === null) return;
  try {
    storage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // Private browsing or a full quota: the session keeps its in-memory theme.
  }
}

/** Resolve the theme to apply: the stored preference, else the system answer. */
export function resolveTheme(stored: ThemePreference | null, prefersDark: boolean): ThemePreference {
  if (stored !== null) return stored;
  return prefersDark ? 'dark' : 'light';
}

/** Read an arbitrary preference string, used for the stored range fallback. */
export function readRangePreference(storage: StorageLike | null): string | null {
  if (storage === null) return null;
  try {
    const raw = storage.getItem(RANGE_STORAGE_KEY);
    return raw === null || raw === '' ? null : raw;
  } catch {
    return null;
  }
}

export function writeRangePreference(storage: StorageLike | null, range: string): void {
  if (storage === null) return;
  try {
    storage.setItem(RANGE_STORAGE_KEY, range);
  } catch {
    // Ignored for the same reason as `writeTheme`.
  }
}
