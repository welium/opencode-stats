/**
 * Phase 3 gate: hash routing.
 *
 * Plan references: §6 "Hash navigation with back/forward support and preserved
 * filters". Because the fragment is the only navigation state, these tests pin
 * the parse/build round trip, the filter-carrying rules between pages, and the
 * bounded pagination/sort parsing that keeps a hand-edited URL from breaking a
 * page.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  DEFAULT_RANGE_KEY,
  MAX_LIMIT,
  RANGE_OPTIONS,
  SESSION_SORT_KEYS,
  allActivityFromQuery,
  buildHash,
  carryFilters,
  isRangeKey,
  pageHash,
  parseBoundedInteger,
  parseHash,
  parseLimit,
  parseSessionSort,
  parseSortDir,
  rangeFromQuery,
  rangeLabel,
  routePath,
} from '../../src/client/route.ts';

/** Mirrors `MAX_OFFSET` in `route.ts`; used to prove the bound is enforced. */
const LIVE_MAX = 1_000_000;

/** Mirrors `MAX_OFFSET` in `route.ts`; used to prove the bound is enforced. */

describe('parseHash', () => {
  it('treats an empty fragment as Overview with no query', () => {
    assert.deepEqual(parseHash(''), { name: 'overview', sessionId: null, query: {} });
    assert.deepEqual(parseHash('#'), { name: 'overview', sessionId: null, query: {} });
  });

  it('parses each page and its query', () => {
    assert.deepEqual(parseHash('#/models?range=7d&model=prov-a%2Fmodel-x'), {
      name: 'models',
      sessionId: null,
      query: { range: '7d', model: 'prov-a/model-x' },
    });
    assert.deepEqual(parseHash('#/projects'), { name: 'projects', sessionId: null, query: {} });
    assert.deepEqual(parseHash('#/tools?range=all'), { name: 'tools', sessionId: null, query: { range: 'all' } });
    assert.deepEqual(parseHash('#/errors?range=all&offset=50'), { name: 'errors', sessionId: null, query: { range: 'all', offset: '50' } });
    assert.equal(pageHash(parseHash('#/models?range=7d&projectId=p&offset=50'), 'errors'), '#/errors?range=7d&projectId=p');
    assert.deepEqual(parseHash('#/sessions'), { name: 'sessions', sessionId: null, query: {} });
  });

  it('parses a session detail route, decoding the identifier', () => {
    assert.deepEqual(parseHash('#/sessions/ses-1?range=90d'), {
      name: 'session',
      sessionId: 'ses-1',
      query: { range: '90d' },
    });
    assert.deepEqual(parseHash('#/sessions/ses%20a%2Fb').sessionId, 'ses a/b');
  });

  it('rejects unknown paths and malformed identifiers instead of guessing', () => {
    for (const hash of ['#/nope', '#/overview/extra', '#/sessions/a/b', '#/sessions/%']) {
      assert.equal(parseHash(hash).name, 'unknown', `expected ${hash} to be unknown`);
      assert.equal(parseHash(hash).sessionId, null);
    }
    // A trailing slash and an empty query are tolerated, not treated as errors.
    assert.equal(parseHash('#/sessions/').name, 'sessions');
    assert.equal(parseHash('#/sessions/?').name, 'sessions');
  });

  it('keeps the last value of a repeated key', () => {
    assert.deepEqual(parseHash('#/models?range=7d&range=90d').query, { range: '90d' });
  });
});

describe('buildHash', () => {
  it('omits the query separator when there is no query', () => {
    assert.equal(buildHash({ name: 'tools', sessionId: null }), '#/tools');
  });

  it('round-trips through parseHash', () => {
    const hash = buildHash({ name: 'session', sessionId: 'ses 1', query: { range: '7d', activity: 'all' } });
    assert.equal(hash, '#/sessions/ses%201?range=7d&activity=all');
    assert.deepEqual(parseHash(hash), { name: 'session', sessionId: 'ses 1', query: { range: '7d', activity: 'all' } });
  });

  it('routes a session without an identifier back to the session list', () => {
    assert.equal(routePath({ name: 'session', sessionId: null }), '/sessions');
    assert.equal(routePath({ name: 'unknown', sessionId: null }), '/unknown');
  });
});

describe('query updates', () => {
  it('adds, replaces, and removes parameters', () => {
    const base = { range: '30d', projectId: 'proj-a' };
    assert.deepEqual(buildHash({ name: 'tools', sessionId: null, query: { ...base, limit: '25' } }), '#/tools?range=30d&projectId=proj-a&limit=25');
  });

  it('carries only range and project between pages', () => {
    const carried = carryFilters({ range: '7d', projectId: 'proj-a', search: 'x', offset: '50', sort: 'cost' });
    assert.deepEqual(carried, { range: '7d', projectId: 'proj-a' });
    assert.deepEqual(pageHash({ query: { range: '7d', projectId: 'proj-a', search: 'x' } }, 'models'), '#/models?range=7d&projectId=proj-a');
  });

  it('applies changes on top of carried filters and drops cleared ones', () => {
    const current = { query: { range: '90d', projectId: 'proj-a' } };
    assert.equal(pageHash(current, 'tools', { projectId: null }), '#/tools?range=90d');
    assert.equal(pageHash(current, 'models', { model: 'prov-a/model-x' }), '#/models?range=90d&projectId=proj-a&model=prov-a%2Fmodel-x');
  });

  it('keeps only the range when opening a session detail page', () => {
    const current = { query: { range: '7d', projectId: 'proj-a', search: 'x', offset: '50' } };
    assert.equal(pageHash(current, 'sessions'), '#/sessions?range=7d&projectId=proj-a');
    assert.equal(pageHash(current, 'sessions', { projectId: null }), '#/sessions?range=7d');
    assert.equal(pageHash(current, 'sessions', { projectId: null, search: null }), '#/sessions?range=7d');
  });
});

describe('bounded query parsing', () => {
  it('falls back for anything that is not a bounded non-negative integer', () => {
    assert.equal(parseBoundedInteger('50', 10, LIVE_MAX), 50);
    assert.equal(parseBoundedInteger('0', 10, LIVE_MAX), 0);
    for (const raw of [undefined, '', '-1', '1.5', 'abc', '1e3', String(LIVE_MAX + 1)]) {
      assert.equal(parseBoundedInteger(raw, 10, LIVE_MAX), 10, `expected ${String(raw)} to fall back`);
    }
  });

  it('accepts only offered page sizes for limit', () => {
    assert.equal(parseLimit('25', 50, [25, 50, 100]), 25);
    assert.equal(parseLimit('50', 25, [25, 50, 100]), 50);
    assert.equal(parseLimit('75', 50, [25, 50, 100]), 50);
    assert.equal(parseLimit(undefined, 50, [25, 50, 100]), 50);
    assert.equal(parseLimit(String(MAX_LIMIT + 1), 50, [25, 50, 100]), 50);
  });

  it('accepts only allowlisted session sort keys and directions', () => {
    for (const key of SESSION_SORT_KEYS) assert.equal(parseSessionSort(key), key);
    for (const raw of [undefined, '', 'model', 'TITLE', 'DROP TABLE']) {
      assert.equal(parseSessionSort(raw), 'updated');
    }
    assert.equal(parseSortDir('asc'), 'asc');
    assert.equal(parseSortDir('desc'), 'desc');
    assert.equal(parseSortDir(undefined), 'desc');
    assert.equal(parseSortDir('ASC'), 'desc');
  });
});

describe('range selection', () => {
  it('defaults to the documented range and rejects unsupported keys', () => {
    assert.equal(DEFAULT_RANGE_KEY, '30d');
    assert.deepEqual(
      RANGE_OPTIONS.map((option) => option.value),
      ['7d', '30d', '90d', 'all'],
    );
    assert.equal(rangeFromQuery({}), '30d');
    assert.equal(rangeFromQuery({ range: '7d' }), '7d');
    assert.equal(rangeFromQuery({ range: '365d' }), '30d');
    assert.ok(isRangeKey('all'));
    assert.ok(!isRangeKey('1d'));
  });

  it('labels every offered range', () => {
    for (const option of RANGE_OPTIONS) assert.equal(rangeLabel(option.value), option.label);
  });
});

describe('session activity mode', () => {
  it('is opt-in through the URL, so the range stays meaningful by default', () => {
    assert.equal(allActivityFromQuery({}), false);
    assert.equal(allActivityFromQuery({ activity: 'all' }), true);
    assert.equal(allActivityFromQuery({ activity: 'range' }), false);
  });
});
