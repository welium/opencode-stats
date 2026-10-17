/**
 * Phase 2 gate: range and local-calendar helpers.
 *
 * Plan references: §4 "Time/filter contract", §8 required check 2. Pinned to
 * `America/New_York` so DST transitions, month/year boundaries, and leap days
 * are observable. Every expected instant is hand-calculated from the zone's UTC
 * offset (EST = UTC−5, EDT = UTC−4); none is derived from the implementation.
 */

process.env.TZ = 'America/New_York';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  DEFAULT_STATS_RANGE,
  STATS_RANGE_KEYS,
  addLocalDays,
  enumerateDateKeys,
  isWithinRange,
  localDateKey,
  localMidnight,
  parseDateKey,
  parseStatsRange,
  rangeDateKeys,
  rangeMeta,
  resolveRange,
  serverTimeZone,
} from '../src/server/range.ts';

const HOUR = 3_600_000;

/** 2026-06-15T12:00 EDT = 2026-06-15T16:00Z. */
const NOW = Date.UTC(2026, 5, 15, 16, 0, 0);

describe('parseStatsRange', () => {
  it('defaults an absent range and preserves supported keys', () => {
    assert.equal(DEFAULT_STATS_RANGE, '30d');
    assert.deepEqual([...STATS_RANGE_KEYS], ['7d', '30d', '90d', 'all']);
    assert.equal(parseStatsRange(null), '30d');
    assert.equal(parseStatsRange(undefined), '30d');
    for (const key of STATS_RANGE_KEYS) assert.equal(parseStatsRange(key), key);
  });

  it('rejects empty and unsupported values', () => {
    for (const value of ['', '1d', 'all ', 'ALL', '7D', '30', '365d']) {
      assert.equal(parseStatsRange(value), null, `expected ${JSON.stringify(value)} to be rejected`);
    }
  });
});

describe('local calendar arithmetic', () => {
  it('reports the server timezone', () => {
    assert.equal(serverTimeZone(), 'America/New_York');
  });

  it('parses only well-formed date keys', () => {
    assert.deepEqual(parseDateKey('2026-06-15'), { year: 2026, month: 6, day: 15 });
    assert.equal(parseDateKey('20260615'), null);
    assert.equal(parseDateKey('2026-6-15'), null);
    assert.equal(parseDateKey('2026-13-01'), null);
    assert.equal(parseDateKey('2026-06-00'), null);
    assert.equal(parseDateKey(''), null);
  });

  it('crosses month, year, and leap-day boundaries by whole calendar days', () => {
    assert.equal(addLocalDays('2026-06-15', -6), '2026-06-09');
    assert.equal(addLocalDays('2026-06-01', -1), '2026-05-31');
    assert.equal(addLocalDays('2026-01-31', 1), '2026-02-01');
    assert.equal(addLocalDays('2025-12-31', 1), '2026-01-01');
    assert.equal(addLocalDays('2024-02-28', 1), '2024-02-29');
    assert.equal(addLocalDays('2024-02-29', 1), '2024-03-01');
    assert.equal(addLocalDays('2023-02-28', 1), '2023-03-01');
    assert.throws(() => addLocalDays('nope', 1));
  });

  it('uses local midnight, not multiples of 24 hours, so DST days keep their date', () => {
    // Spring forward: 2026-03-08 is a 23-hour local day (EST -> EDT).
    const beforeSpring = localMidnight('2026-03-08');
    const afterSpring = localMidnight('2026-03-09');
    assert.equal(beforeSpring, Date.UTC(2026, 2, 8, 5, 0, 0), 'local midnight before spring forward is EST');
    assert.equal(afterSpring, Date.UTC(2026, 2, 9, 4, 0, 0), 'local midnight after spring forward is EDT');
    assert.equal(afterSpring - beforeSpring, 23 * HOUR, 'spring-forward local day must be 23 hours');

    // Fall back: 2026-11-01 is a 25-hour local day (EDT -> EST).
    const beforeFall = localMidnight('2026-11-01');
    const afterFall = localMidnight('2026-11-02');
    assert.equal(beforeFall, Date.UTC(2026, 10, 1, 4, 0, 0));
    assert.equal(afterFall, Date.UTC(2026, 10, 2, 5, 0, 0));
    assert.equal(afterFall - beforeFall, 25 * HOUR, 'fall-back local day must be 25 hours');

    // The calendar date is preserved across the shift, unlike 24h arithmetic.
    assert.equal(addLocalDays('2026-03-08', 1), '2026-03-09');
  });

  it('enumerates inclusive calendars across a year boundary', () => {
    const week = enumerateDateKeys('2026-06-09', '2026-06-15');
    assert.equal(week.length, 7);
    assert.equal(week[0], '2026-06-09');
    assert.equal(week[6], '2026-06-15');

    assert.deepEqual(enumerateDateKeys('2025-12-30', '2026-01-02'), [
      '2025-12-30',
      '2025-12-31',
      '2026-01-01',
      '2026-01-02',
    ]);
    assert.deepEqual(enumerateDateKeys('2024-02-28', '2024-03-01'), ['2024-02-28', '2024-02-29', '2024-03-01']);
    assert.deepEqual(enumerateDateKeys('2026-06-15', '2026-06-15'), ['2026-06-15']);
  });

  it('derives the local date of an instant', () => {
    assert.equal(localDateKey(NOW), '2026-06-15');
    // 2026-06-15T03:59Z is still 2026-06-14 in New York (EDT).
    assert.equal(localDateKey(Date.UTC(2026, 5, 15, 3, 59, 0)), '2026-06-14');
    assert.equal(localDateKey(Date.UTC(2026, 5, 15, 4, 0, 0)), '2026-06-15');
  });
});

describe('resolveRange', () => {
  it('resolves finite ranges as N local dates ending today', () => {
    const week = resolveRange('7d', NOW);
    assert.equal(week.key, '7d');
    assert.equal(week.fromDate, '2026-06-09');
    assert.equal(week.toDate, '2026-06-15');
    assert.equal(week.from, Date.UTC(2026, 5, 9, 4, 0, 0));
    assert.equal(week.to, NOW);
    assert.equal(week.days, 7);
    assert.equal(week.timezone, 'America/New_York');

    const month = resolveRange('30d', NOW);
    assert.equal(month.fromDate, '2026-05-17');
    assert.equal(month.from, Date.UTC(2026, 4, 17, 4, 0, 0));
    assert.equal(month.days, 30);

    const quarter = resolveRange('90d', NOW);
    assert.equal(quarter.fromDate, '2026-03-18');
    assert.equal(quarter.from, Date.UTC(2026, 2, 18, 4, 0, 0));
    assert.equal(quarter.days, 90);
    assert.equal(enumerateDateKeys(quarter.fromDate as string, quarter.toDate).length, 90);
  });

  it('resolves a range spanning a year boundary with the requested date count', () => {
    // 2026-01-01T00:00 EST = 05:00Z.
    const range = resolveRange('7d', Date.UTC(2026, 0, 1, 5, 0, 0));
    assert.equal(range.toDate, '2026-01-01');
    assert.equal(range.fromDate, '2025-12-26');
    assert.equal(range.from, Date.UTC(2025, 11, 26, 5, 0, 0));
    assert.equal(rangeDateKeys(range, null).length, 7);
  });

  it('resolves all with no lower bound', () => {
    const all = resolveRange('all', NOW);
    assert.equal(all.from, null);
    assert.equal(all.fromDate, null);
    assert.equal(all.days, null);
    assert.equal(all.to, NOW);
    assert.equal(all.toDate, '2026-06-15');
  });
});

describe('isWithinRange', () => {
  it('is inclusive of the lower bound and exclusive of the upper bound', () => {
    const range = resolveRange('7d', NOW);
    assert.equal(isWithinRange(range.from as number, range), true);
    assert.equal(isWithinRange((range.from as number) - 1, range), false);
    assert.equal(isWithinRange(range.to - 1, range), true);
    assert.equal(isWithinRange(range.to, range), false);

    const all = resolveRange('all', NOW);
    assert.equal(isWithinRange(0, all), true);
    assert.equal(isWithinRange(all.to - 1, all), true);
    assert.equal(isWithinRange(all.to, all), false);
  });
});

describe('rangeDateKeys', () => {
  it('covers exactly the resolved dates for a finite range', () => {
    const range = resolveRange('7d', NOW);
    assert.deepEqual(rangeDateKeys(range, null), enumerateDateKeys('2026-06-09', '2026-06-15'));
  });

  it('starts at the earliest observed date for all, or is empty when nothing was observed', () => {
    const all = resolveRange('all', NOW);
    assert.deepEqual(rangeDateKeys(all, '2026-06-13'), ['2026-06-13', '2026-06-14', '2026-06-15']);
    assert.deepEqual(rangeDateKeys(all, '2026-06-15'), ['2026-06-15']);
    assert.deepEqual(rangeDateKeys(all, null), []);
    assert.deepEqual(rangeDateKeys(all, '2026-06-16'), [], 'an observation after the clock cannot start a series');
  });
});

describe('rangeMeta', () => {
  it('serializes boundaries, timezone, and day count', () => {
    assert.deepEqual(rangeMeta(resolveRange('7d', NOW)), {
      key: '7d',
      from: '2026-06-09T04:00:00.000Z',
      to: '2026-06-15T16:00:00.000Z',
      fromDate: '2026-06-09',
      toDate: '2026-06-15',
      timezone: 'America/New_York',
      days: 7,
    });
  });

  it('leaves all without a lower bound', () => {
    assert.deepEqual(rangeMeta(resolveRange('all', NOW)), {
      key: 'all',
      from: null,
      to: '2026-06-15T16:00:00.000Z',
      fromDate: null,
      toDate: '2026-06-15',
      timezone: 'America/New_York',
      days: null,
    });
  });
});
