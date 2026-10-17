/**
 * Client-side table sorting for the breakdown tables.
 *
 * Plan references: §6 "Tables are sortable where useful". Sessions sorting is
 * server-side against an allowlist (§5); the model, project, agent, and tool
 * tables are already fully in memory, so they sort locally and keep the request
 * shape unchanged.
 */

import { useCallback, useState } from 'react';

export interface SortState {
  key: string;
  dir: 'asc' | 'desc';
}

export interface SortControls {
  sort: SortState;
  /** Toggle the direction when the column is already active. */
  toggle: (key: string, initialDir?: 'asc' | 'desc') => void;
}

export function useSort(initialKey: string, initialDir: 'asc' | 'desc' = 'desc'): SortControls {
  const [sort, setSort] = useState<SortState>({ key: initialKey, dir: initialDir });
  const toggle = useCallback((key: string, initialDir: 'asc' | 'desc' = 'desc') => {
    setSort((previous) =>
      previous.key === key ? { key, dir: previous.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: initialDir },
    );
  }, []);
  return { sort, toggle };
}

export type SortValue = number | string | null;

/**
 * Compare two values with unmeasured values always at the end, so a `—` never
 * displaces a real measurement at the top of a ranking.
 */
export function compareSortValues(left: SortValue, right: SortValue, dir: 'asc' | 'desc'): number {
  if (left === null && right === null) return 0;
  if (left === null) return 1;
  if (right === null) return -1;
  let ranked: number;
  if (typeof left === 'number' && typeof right === 'number') {
    ranked = left === right ? 0 : left < right ? -1 : 1;
  } else {
    ranked = String(left).localeCompare(String(right));
  }
  return dir === 'asc' ? ranked : -ranked;
}

/** Sort a copy of `rows` by the extracted value for `key`. */
export function sortRows<T>(rows: readonly T[], sort: SortState, value: (row: T, key: string) => SortValue): T[] {
  return [...rows].sort((left, right) => {
    const ranked = compareSortValues(value(left, sort.key), value(right, sort.key), sort.dir);
    return ranked;
  });
}
