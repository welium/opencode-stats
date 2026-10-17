/**
 * Range and local-calendar helpers for statistics requests.
 *
 * Plan references: §4 "Time/filter contract".
 *
 * Contract implemented here:
 *  - supported ranges are `7d`, `30d`, `90d`, and `all`
 *  - a finite range means N local calendar dates including today, from local
 *    midnight N−1 days ago to a captured current instant
 *  - boundaries are `[from, to)`
 *  - calendar arithmetic uses local calendar dates, never multiples of 24 hours,
 *    so DST transitions and month/year boundaries keep the requested date count
 *  - daily buckets and heatmaps use the server's local timezone
 */

import type { RangeMeta, StatsRangeKey } from '../shared/api.ts';

export const STATS_RANGE_KEYS: readonly StatsRangeKey[] = ['7d', '30d', '90d', 'all'];

/** Used when a request omits `range`. */
export const DEFAULT_STATS_RANGE: StatsRangeKey = '30d';

/**
 * Resolved boundaries for one request. `from` is the inclusive lower bound
 * (local midnight) and `to` is the exclusive upper bound (captured clock).
 */
export interface ResolvedRange {
  key: StatsRangeKey;
  from: number | null;
  to: number;
  fromDate: string | null;
  toDate: string;
  timezone: string;
  days: number | null;
}

/**
 * Parse a `range` query value. An absent value selects the default; anything
 * else must match a supported key exactly, so unknown ranges are rejected.
 */
export function parseStatsRange(value: string | null | undefined): StatsRangeKey | null {
  if (value === null || value === undefined) return DEFAULT_STATS_RANGE;
  return (STATS_RANGE_KEYS as readonly string[]).includes(value) ? (value as StatsRangeKey) : null;
}

/** Server timezone used for every calendar boundary and daily bucket. */
export function serverTimeZone(): string {
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return zone === undefined || zone === '' ? 'UTC' : zone;
}

function formatDateKey(year: number, month: number, day: number): string {
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

export interface LocalDateParts {
  year: number;
  /** 1-12. */
  month: number;
  /** 1-31. */
  day: number;
}

/** Local calendar components of an instant. */
export function localDateParts(epochMs: number): LocalDateParts {
  const date = new Date(epochMs);
  return { year: date.getFullYear(), month: date.getMonth() + 1, day: date.getDate() };
}

/** Local calendar date of an instant as `YYYY-MM-DD`. */
export function localDateKey(epochMs: number): string {
  const parts = localDateParts(epochMs);
  return formatDateKey(parts.year, parts.month, parts.day);
}

const DATE_KEY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Parse a `YYYY-MM-DD` key; returns null when it is not a calendar date. */
export function parseDateKey(key: string): LocalDateParts | null {
  const match = DATE_KEY_PATTERN.exec(key);
  if (match === null) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return { year, month, day };
}

/**
 * Add whole local calendar days to a `YYYY-MM-DD` key.
 *
 * The arithmetic runs on a UTC view of the same calendar date, so it never
 * depends on the length of a local day (DST) — 2026-03-08 plus one day is
 * 2026-03-09 even though that local day had 23 hours.
 */
export function addLocalDays(dateKey: string, delta: number): string {
  const parts = parseDateKey(dateKey);
  if (parts === null) throw new Error(`Invalid local date key: ${dateKey}`);
  const shifted = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + delta));
  return formatDateKey(shifted.getUTCFullYear(), shifted.getUTCMonth() + 1, shifted.getUTCDate());
}

/**
 * Local midnight of a calendar date.
 *
 * In the rare zones whose DST shift happens at midnight, `Date` normalizes a
 * nonexistent local time forward to the first instant of the day.
 */
export function localMidnight(dateKey: string): number {
  const parts = parseDateKey(dateKey);
  if (parts === null) throw new Error(`Invalid local date key: ${dateKey}`);
  return new Date(parts.year, parts.month - 1, parts.day, 0, 0, 0, 0).getTime();
}

/** Upper bound of the safety guard for date enumeration (about 55 years). */
const MAX_ENUMERATED_DATES = 20_000;

/** Every local calendar date from `fromDate` to `toDate`, inclusive. */
export function enumerateDateKeys(fromDate: string, toDate: string): string[] {
  const keys: string[] = [];
  let cursor = fromDate;
  for (let guard = 0; guard < MAX_ENUMERATED_DATES; guard += 1) {
    keys.push(cursor);
    if (cursor === toDate) return keys;
    const next = addLocalDays(cursor, 1);
    // Defensive: a malformed key must not loop forever.
    if (next <= cursor) return keys;
    cursor = next;
  }
  return keys;
}

/** Resolve a range key against a captured clock value. */
export function resolveRange(key: StatsRangeKey, now: number, timezone: string = serverTimeZone()): ResolvedRange {
  const toDate = localDateKey(now);
  if (key === 'all') {
    return { key, from: null, to: now, fromDate: null, toDate, timezone, days: null };
  }

  const days = Number.parseInt(key.slice(0, -1), 10);
  const fromDate = addLocalDays(toDate, -(days - 1));
  return { key, from: localMidnight(fromDate), to: now, fromDate, toDate, timezone, days };
}

/** True when an instant falls inside `[from, to)`. */
export function isWithinRange(epochMs: number, range: ResolvedRange): boolean {
  if (range.from !== null && epochMs < range.from) return false;
  return epochMs < range.to;
}

/**
 * Local dates the daily series and streak cover.
 *
 * A finite range always covers exactly its resolved dates. `all` has no lower
 * bound, so it starts at the earliest observed activity date supplied by the
 * caller (or is empty when nothing was observed).
 */
export function rangeDateKeys(range: ResolvedRange, earliestObservedDate: string | null): string[] {
  if (range.fromDate !== null) return enumerateDateKeys(range.fromDate, range.toDate);
  if (earliestObservedDate === null || earliestObservedDate > range.toDate) return [];
  const start = parseDateKey(earliestObservedDate) === null ? range.toDate : earliestObservedDate;
  return enumerateDateKeys(start, range.toDate);
}

/** Response metadata for a resolved range. */
export function rangeMeta(range: ResolvedRange): RangeMeta {
  return {
    key: range.key,
    from: range.from === null ? null : new Date(range.from).toISOString(),
    to: new Date(range.to).toISOString(),
    fromDate: range.fromDate,
    toDate: range.toDate,
    timezone: range.timezone,
    days: range.days,
  };
}
