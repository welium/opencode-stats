/**
 * Safe access to `localStorage`.
 *
 * Plan references: §6 "Handle unavailable local storage gracefully." A browser
 * that blocks storage (private mode, disabled cookies, a full quota) must still
 * get a working dashboard, so every access is wrapped and a failure degrades to
 * "nothing persisted" rather than an exception.
 */

import type { StorageLike } from './theme.ts';

export function safeLocalStorage(): StorageLike | null {
  try {
    const storage = window.localStorage;
    const probe = 'opencode-dashboard.probe';
    storage.setItem(probe, '1');
    storage.removeItem(probe);
    return storage;
  } catch {
    return null;
  }
}
