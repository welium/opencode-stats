/**
 * Human-readable formatting for dashboard values.
 *
 * Plan references: §6 "Show unavailable numeric values as `—`, not invented
 * zeros" and §4's measured/complete distinction. Every formatter accepts a
 * nullable value and reports `UNAVAILABLE` instead of fabricating a zero, and
 * every partial measurement keeps a visible marker so a subtotal is never
 * mistaken for a complete total.
 *
 * The module is deliberately free of DOM and Node APIs so the server test
 * project can exercise it directly under Node's type stripping.
 */

import type { MeasuredTotal, TokenTotals, UsageTotals } from '../shared/api.ts';

/** Placeholder for a value that was not measured, not a zero. */
export const UNAVAILABLE = '—';

function isUsableNumber(value: number | null | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

const integerFormat = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });

const COMPACT_UNITS: ReadonlyArray<readonly [number, string]> = [
  [1_000_000_000, 'B'],
  [1_000_000, 'M'],
  [1_000, 'k'],
];

/** Grouped integer, or `—` when the value is unavailable. */
export function formatInteger(value: number | null | undefined): string {
  if (!isUsableNumber(value)) return UNAVAILABLE;
  return integerFormat.format(value);
}

/**
 * Short magnitude such as `1.3k`. Used for token counts, where exact digits in
 * a dense table are noise. Values below 1,000 keep their exact digits.
 */
export function formatCompact(value: number | null | undefined): string {
  if (!isUsableNumber(value)) return UNAVAILABLE;
  const magnitude = Math.abs(value);
  if (magnitude < 1_000) return integerFormat.format(value);
  for (const [scale, suffix] of COMPACT_UNITS) {
    if (magnitude >= scale) return `${(value / scale).toFixed(1).replace(/\.0$/, '')}${suffix}`;
  }
  return integerFormat.format(value);
}

/** Ratio (0–1) as a percentage, or `—` when there is no valid ratio. */
export function formatPercent(value: number | null | undefined, digits = 1): string {
  if (!isUsableNumber(value)) return UNAVAILABLE;
  return `${(value * 100).toFixed(digits)}%`;
}

/**
 * USD amount. Sub-cent values keep extra digits so a real `$0.0004` is not
 * displayed as a decisive-looking `$0.00`.
 */
export function formatCost(value: number | null | undefined): string {
  if (!isUsableNumber(value)) return UNAVAILABLE;
  const magnitude = Math.abs(value);
  if (magnitude === 0) return '$0.00';
  if (magnitude < 0.01) return `$${value.toFixed(6).replace(/0+$/, '').replace(/\.$/, '')}`;
  return `$${value.toFixed(2)}`;
}

/** Compact duration: `840 ms`, `1.2 s`, `2m 05s`. */
export function formatDuration(value: number | null | undefined): string {
  if (!isUsableNumber(value) || value < 0) return UNAVAILABLE;
  if (value < 1_000) return `${Math.round(value)} ms`;
  if (value < 60_000) return `${(value / 1_000).toFixed(1)} s`;
  const totalSeconds = Math.round(value / 1_000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes)}m ${String(seconds).padStart(2, '0')}s`;
}

function partsToKey(parts: Intl.DateTimeFormatPart[]): string {
  const read = (type: Intl.DateTimeFormatPartTypes): string => parts.find((part) => part.type === type)?.value ?? '';
  return `${read('year')}-${read('month')}-${read('day')}`;
}

/** Local calendar date (`YYYY-MM-DD`) of an instant. */
export function formatDate(epochMs: number | null | undefined, timeZone?: string): string {
  if (!isUsableNumber(epochMs)) return UNAVAILABLE;
  const formatter = new Intl.DateTimeFormat('sv-SE', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    ...(timeZone === undefined ? {} : { timeZone }),
  });
  return partsToKey(formatter.formatToParts(new Date(epochMs)));
}

/** Local `YYYY-MM-DD HH:mm` of an instant. */
export function formatDateTime(epochMs: number | null | undefined, timeZone?: string): string {
  if (!isUsableNumber(epochMs)) return UNAVAILABLE;
  const formatter = new Intl.DateTimeFormat('sv-SE', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    ...(timeZone === undefined ? {} : { timeZone }),
  });
  return formatter.format(new Date(epochMs)).replace('T', ' ');
}

/** Local `HH:mm:ss` of an instant, used for freshness stamps. */
export function formatTime(epochMs: number | null | undefined, timeZone?: string): string {
  if (!isUsableNumber(epochMs)) return UNAVAILABLE;
  const formatter = new Intl.DateTimeFormat('sv-SE', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
    ...(timeZone === undefined ? {} : { timeZone }),
  });
  return formatter.format(new Date(epochMs));
}

/** `2026-06-15` becomes `06-15`, for compact chart axes. */
export function shortDateKey(dateKey: string): string {
  return dateKey.length === 10 ? dateKey.slice(5) : dateKey;
}

/** A measured value plus whether it covers every counted row. */
export interface FormattedValue {
  text: string;
  /** True when rows were counted but not all of them reported a value. */
  partial: boolean;
}

/**
 * Format a `MeasuredTotal`. A null value is unavailable; an incomplete total
 * keeps a `≥` marker so a measured subtotal cannot read as a complete total.
 */
export function formatMeasured(
  total: MeasuredTotal | undefined,
  format: (value: number) => string,
): FormattedValue {
  if (total === undefined || total.value === null) return { text: UNAVAILABLE, partial: false };
  return { text: format(total.value), partial: !total.complete };
}

/** Sum of every token category that reported a value, or null when none did. */
export function measuredTokenSum(tokens: TokenTotals): number | null {
  const values = [tokens.input, tokens.output, tokens.reasoning, tokens.cacheRead, tokens.cacheWrite]
    .map((category) => category.value)
    .filter((value): value is number => value !== null);
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0);
}

/**
 * Token total for a table cell. A complete total is exact; an incomplete one
 * becomes a labeled `≥` subtotal; nothing measurable is `—`.
 */
export function formatTokenTotal(tokens: TokenTotals, format: (value: number) => string = formatCompact): FormattedValue {
  if (tokens.total !== null) return { text: format(tokens.total), partial: false };
  const sum = measuredTokenSum(tokens);
  if (sum === null) return { text: UNAVAILABLE, partial: false };
  return { text: `≥ ${format(sum)}`, partial: true };
}

/** Token total plus recorded cost for one usage group, already formatted. */
export interface UsageValues {
  tokens: FormattedValue;
  cost: FormattedValue;
  cacheRate: string;
}

export function usageValues(usage: UsageTotals | undefined): UsageValues {
  if (usage === undefined) {
    return { tokens: { text: UNAVAILABLE, partial: false }, cost: { text: UNAVAILABLE, partial: false }, cacheRate: UNAVAILABLE };
  }
  return {
    tokens: formatTokenTotal(usage.tokens),
    cost: formatMeasured(usage.cost, formatCost),
    cacheRate: formatPercent(usage.cacheRate),
  };
}

/** Explanation shown beside a partial total so the marker is never unexplained. */
export const PARTIAL_TOTAL_HINT = 'Measured subtotal: some steps report no value for this metric';
