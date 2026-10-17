/**
 * Phase 3 gate: value formatting.
 *
 * Plan references: §6 "Show unavailable numeric values as `—`, not invented
 * zeros" and §4's measured-versus-complete distinction. The key property under
 * test is that a missing measurement never renders as a zero, and that a
 * measured subtotal is always visibly marked as partial.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { MeasuredTotal, TokenTotals } from '../../src/shared/api.ts';

import {
  PARTIAL_TOTAL_HINT,
  UNAVAILABLE,
  formatCompact,
  formatCost,
  formatDate,
  formatDateTime,
  formatDuration,
  formatInteger,
  formatMeasured,
  formatPercent,
  formatTime,
  formatTokenTotal,
  measuredTokenSum,
  shortDateKey,
  usageValues,
} from '../../src/client/format.ts';

function measured(value: number | null, complete: boolean): MeasuredTotal {
  return {
    value,
    complete,
    measured: value === null ? 0 : 1,
    counted: complete ? 1 : 2,
  };
}

function tokens(overrides: Partial<Record<keyof Omit<TokenTotals, 'total'>, MeasuredTotal>> = {}, total: number | null = null): TokenTotals {
  const zero = measured(0, true);
  return {
    input: overrides.input ?? zero,
    output: overrides.output ?? zero,
    reasoning: overrides.reasoning ?? zero,
    cacheRead: overrides.cacheRead ?? zero,
    cacheWrite: overrides.cacheWrite ?? zero,
    total,
  };
}

describe('unavailable values', () => {
  it('renders `—` for null, undefined, NaN, and Infinity', () => {
    assert.equal(UNAVAILABLE, '—');
    for (const value of [null, undefined, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      assert.equal(formatInteger(value), UNAVAILABLE);
      assert.equal(formatCompact(value), UNAVAILABLE);
      assert.equal(formatPercent(value), UNAVAILABLE);
      assert.equal(formatCost(value), UNAVAILABLE);
      assert.equal(formatDuration(value), UNAVAILABLE);
      assert.equal(formatDate(value), UNAVAILABLE);
      assert.equal(formatDateTime(value), UNAVAILABLE);
      assert.equal(formatTime(value), UNAVAILABLE);
    }
  });

  it('never renders an unavailable value as a zero', () => {
    assert.notEqual(formatInteger(null), '0');
    assert.notEqual(formatCost(null), '$0.00');
    assert.notEqual(formatPercent(undefined), '0.0%');
    assert.equal(formatInteger(0), '0');
    assert.equal(formatCost(0), '$0.00');
  });
});

describe('formatInteger and formatCompact', () => {
  it('groups integers and keeps exact digits below one thousand', () => {
    assert.equal(formatInteger(1_234_567), '1,234,567');
    assert.equal(formatInteger(0), '0');
    assert.equal(formatCompact(999), '999');
  });

  it('shortens large magnitudes and drops a trailing .0', () => {
    assert.equal(formatCompact(1_000), '1k');
    assert.equal(formatCompact(1_250), '1.3k');
    assert.equal(formatCompact(2_000_000), '2M');
    assert.equal(formatCompact(3_400_000_000), '3.4B');
  });

  it('keeps the sign of a negative value', () => {
    assert.equal(formatCompact(-1_500), '-1.5k');
    assert.equal(formatInteger(-42), '-42');
  });
});

describe('formatPercent and formatCost', () => {
  it('formats ratios as percentages and leaves unusable ratios unavailable', () => {
    assert.equal(formatPercent(0.5), '50.0%');
    assert.equal(formatPercent(0.1234, 2), '12.34%');
    assert.equal(formatPercent(0), '0.0%');
  });

  it('keeps a real sub-cent cost from reading as zero', () => {
    assert.equal(formatCost(0.0004), '$0.0004');
    assert.equal(formatCost(0.01), '$0.01');
    assert.equal(formatCost(12.5), '$12.50');
    assert.notEqual(formatCost(0.0001), '$0.00');
  });
});

describe('formatDuration', () => {
  it('scales from milliseconds to minutes and rejects negatives', () => {
    assert.equal(formatDuration(0), '0 ms');
    assert.equal(formatDuration(840), '840 ms');
    assert.equal(formatDuration(1_200), '1.2 s');
    assert.equal(formatDuration(125_000), '2m 05s');
    assert.equal(formatDuration(-1), UNAVAILABLE);
  });
});

describe('formatDate, formatDateTime, and formatTime', () => {
  const instant = Date.UTC(2026, 5, 15, 16, 4, 5);

  it('formats in the requested zone', () => {
    assert.equal(formatDate(instant, 'UTC'), '2026-06-15');
    assert.equal(formatDateTime(instant, 'UTC'), '2026-06-15 16:04');
    assert.equal(formatTime(instant, 'UTC'), '16:04:05');
    assert.equal(formatDate(instant, 'America/New_York'), '2026-06-15');
  });

  it('shortens date keys for chart axes only when they look like keys', () => {
    assert.equal(shortDateKey('2026-06-15'), '06-15');
    assert.equal(shortDateKey('06-15'), '06-15');
  });
});

describe('measured totals', () => {
  it('marks an incomplete total as partial and leaves a missing one unavailable', () => {
    assert.deepEqual(formatMeasured(measured(120, true), (value) => String(value)), { text: '120', partial: false });
    assert.deepEqual(formatMeasured(measured(120, false), (value) => String(value)), { text: '120', partial: true });
    assert.deepEqual(formatMeasured(measured(null, false), (value) => String(value)), { text: UNAVAILABLE, partial: false });
    assert.deepEqual(formatMeasured(undefined, (value) => String(value)), { text: UNAVAILABLE, partial: false });
    assert.match(PARTIAL_TOTAL_HINT, /subtotal/);
  });

  it('sums only categories that reported a value', () => {
    assert.equal(measuredTokenSum(tokens()), 0);
    assert.equal(measuredTokenSum(tokens({ input: measured(10, true), output: measured(null, false) })), 10);
    assert.equal(
      measuredTokenSum(tokens({ input: measured(null, false), output: measured(null, false), reasoning: measured(null, false), cacheRead: measured(null, false), cacheWrite: measured(null, false) })),
      null,
    );
  });
});

describe('formatTokenTotal', () => {
  it('uses the exact total when the API reports one', () => {
    assert.deepEqual(formatTokenTotal(tokens({}, 5_000)), { text: '5k', partial: false });
  });

  it('falls back to a labelled subtotal when the total is incomplete', () => {
    const partial = formatTokenTotal(tokens({ input: measured(4_000, true), output: measured(1_000, true) }));
    assert.deepEqual(partial, { text: '5k', partial: true });
    assert.doesNotMatch(partial.text, /≥/);
  });

  it('reports unavailable instead of a zero subtotal', () => {
    assert.deepEqual(
      formatTokenTotal(
        tokens({
          input: measured(null, false),
          output: measured(null, false),
          reasoning: measured(null, false),
          cacheRead: measured(null, false),
          cacheWrite: measured(null, false),
        }),
      ),
      { text: UNAVAILABLE, partial: false },
    );
  });
});

describe('usageValues', () => {
  it('formats a full usage group', () => {
    const values = usageValues({
      steps: 3,
      tokens: tokens({ input: measured(1_000, true) }, 1_000),
      cost: measured(0.0025, true),
      cacheRate: 0.25,
    });
    assert.deepEqual(values.tokens, { text: '1k', partial: false });
    assert.deepEqual(values.cost, { text: '$0.0025', partial: false });
    assert.equal(values.cacheRate, '25.0%');
  });

  it('keeps every field unavailable for a missing record', () => {
    const values = usageValues(undefined);
    assert.equal(values.tokens.text, UNAVAILABLE);
    assert.equal(values.cost.text, UNAVAILABLE);
    assert.equal(values.cacheRate, UNAVAILABLE);
  });
});
