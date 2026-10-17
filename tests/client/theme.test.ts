/**
 * Phase 3 gate: theme and range preferences.
 *
 * Plan references: §6 "Theme preference and range may be stored locally; do not
 * persist returned session data. Handle unavailable local storage gracefully."
 * The storage surface is injected, so a blocked or failing `localStorage` is
 * exercised directly rather than assumed to work.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { StorageLike } from '../../src/client/theme.ts';

import {
  RANGE_STORAGE_KEY,
  THEME_STORAGE_KEY,
  isThemePreference,
  readRangePreference,
  readTheme,
  resolveTheme,
  writeRangePreference,
  writeTheme,
} from '../../src/client/theme.ts';

/** In-memory storage that behaves like the real one. */
function memoryStorage(initial: Record<string, string> = {}): StorageLike & { entries: Map<string, string> } {
  const entries = new Map<string, string>(Object.entries(initial));
  return {
    entries,
    getItem: (key) => entries.get(key) ?? null,
    setItem: (key, value) => void entries.set(key, value),
    removeItem: (key) => void entries.delete(key),
  };
}

/** Storage that throws on every access, as in private mode or a full quota. */
const blockedStorage: StorageLike = {
  getItem: () => {
    throw new Error('blocked');
  },
  setItem: () => {
    throw new Error('blocked');
  },
  removeItem: () => {
    throw new Error('blocked');
  },
};

describe('theme preference', () => {
  it('reads only the two recognized preferences', () => {
    assert.ok(isThemePreference('light'));
    assert.ok(isThemePreference('dark'));
    assert.ok(!isThemePreference('system'));
    assert.ok(!isThemePreference(null));
    assert.equal(readTheme(memoryStorage()), null);
    assert.equal(readTheme(memoryStorage({ [THEME_STORAGE_KEY]: 'dark' })), 'dark');
    assert.equal(readTheme(memoryStorage({ [THEME_STORAGE_KEY]: 'sepia' })), null);
  });

  it('persists a preference under the documented key', () => {
    const storage = memoryStorage();
    writeTheme(storage, 'dark');
    assert.equal(storage.entries.get(THEME_STORAGE_KEY), 'dark');
    assert.equal(readTheme(storage), 'dark');
  });

  it('falls back to the system answer when nothing is stored', () => {
    assert.equal(resolveTheme(null, true), 'dark');
    assert.equal(resolveTheme(null, false), 'light');
    assert.equal(resolveTheme('dark', false), 'dark');
    assert.equal(resolveTheme('light', true), 'light');
  });

  it('degrades to nothing-persisted when storage is unavailable', () => {
    assert.equal(readTheme(null), null);
    assert.equal(readTheme(blockedStorage), null);
    writeTheme(null, 'dark');
    writeTheme(blockedStorage, 'dark');
    assert.equal(resolveTheme(readTheme(blockedStorage), false), 'light');
  });
});

describe('range preference', () => {
  it('reads and writes the stored range string', () => {
    const storage = memoryStorage();
    assert.equal(readRangePreference(storage), null);
    writeRangePreference(storage, '90d');
    assert.equal(storage.entries.get(RANGE_STORAGE_KEY), '90d');
    assert.equal(readRangePreference(storage), '90d');
  });

  it('treats an empty value as unset and tolerates blocked storage', () => {
    assert.equal(readRangePreference(memoryStorage({ [RANGE_STORAGE_KEY]: '' })), null);
    writeRangePreference(blockedStorage, '7d');
    assert.equal(readRangePreference(blockedStorage), null);
    assert.equal(readRangePreference(null), null);
    writeRangePreference(null, '7d');
  });
});
