/**
 * Shared in-flight read counter.
 *
 * Plan references: §3's refresh contract and §6's "explicit Refresh … no
 * automatic polling". The Refresh action replaces the active page's values, so
 * it should say when a read is still running. Each `useQuery` instance registers
 * its own read here; the shell renders the aggregate, which keeps the progress
 * label honest without threading a callback through every page.
 */

import { useSyncExternalStore } from 'react';

let pending = 0;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

/** Register a read; the returned function must be called exactly once when it settles. */
export function beginRead(): () => void {
  pending += 1;
  emit();
  let settled = false;
  return () => {
    if (settled) return;
    settled = true;
    pending -= 1;
    emit();
  };
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function snapshot(): number {
  return pending;
}

/** Number of reads currently in flight. */
export function usePendingReads(): number {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}
