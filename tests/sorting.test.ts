import assert from 'node:assert/strict';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { sortRows } from '../src/client/components/sorting.ts';
import { formatTokenTotal } from '../src/client/format.ts';
import { createDatabaseAdapter } from '../src/server/database.ts';
import { createDashboardServer } from '../src/server/http.ts';
import { compareUsage } from '../src/server/metrics.ts';
import type { MeasuredTotal, SessionsResponse, TokenTotals, UsageTotals } from '../src/shared/api.ts';
import { tokenSortValue } from '../src/shared/usage.ts';
import { applySchema, createTempDir, insertMessage, insertSession, removeTempDir } from './helpers/fixtures.ts';
import { fetchJson, startHttpServer } from './helpers/server.ts';

const measured = (value: number | null): MeasuredTotal => ({ value, measured: value === null ? 0 : 1, counted: 1, complete: value !== null });
function tokens(input: number | null, total: number | null): TokenTotals {
  return { input: measured(input), output: measured(total === null ? null : 0), reasoning: measured(total === null ? null : 0),
    cacheRead: measured(total === null ? null : 0), cacheWrite: measured(total === null ? null : 0), total };
}
const rows = [
  { id: 'mid', tokens: tokens(1250, 1250) },
  { id: 'missing', tokens: tokens(null, null) },
  { id: 'low', tokens: tokens(100, null) },
  { id: 'high', tokens: tokens(2000, null) },
  { id: 'zero', tokens: tokens(0, 0) },
];

test('client token sorting interleaves partial subtotals numerically and leaves unavailable last in both directions', () => {
  const value = (row: typeof rows[number]) => tokenSortValue(row.tokens);
  assert.deepEqual(sortRows(rows, { key: 'tokens', dir: 'desc' }, value).map((row) => row.id), ['high', 'mid', 'low', 'zero', 'missing']);
  assert.deepEqual(sortRows(rows, { key: 'tokens', dir: 'asc' }, value).map((row) => row.id), ['zero', 'low', 'mid', 'high', 'missing']);
  assert.equal(formatTokenTotal(rows[3]!.tokens).text, '2k');
  assert.equal(formatTokenTotal(rows[3]!.tokens).partial, true);
  assert.equal(tokenSortValue(rows[1]!.tokens), null);
});

test('default API usage rankings include measured partial token subtotals', () => {
  const groups = rows.map((row) => ({ id: row.id, steps: 1,
    usage: { steps: 1, tokens: row.tokens, cost: measured(null), cacheRate: null } satisfies UsageTotals }));
  assert.deepEqual(groups.sort(compareUsage).map((row) => row.id), ['high', 'mid', 'low', 'zero', 'missing']);
});

test('session token/cost sorting uses partial measurements before pagination, with unavailable last', async () => {
  const dir = createTempDir('opencode-sorting-');
  const path = join(dir, 'fixture.db');
  const writer = new DatabaseSync(path);
  applySchema(writer);
  const now = Date.now() - 1000;
  const complete = (input: number) => ({ input, output: 0, reasoning: 0, cache: { read: 0, write: 0 } });
  for (const [id, data] of [
    ['high', { tokens: { input: 2000 }, cost: 20 }],
    ['mid', { tokens: complete(1250), cost: 7 }],
    ['low', { tokens: { input: 100 }, cost: 1 }],
    ['zero', { tokens: complete(0), cost: 0 }],
    ['missing', {}],
  ] as const) {
    insertSession(writer, { id, title: id, timeCreated: now });
    insertMessage(writer, { id: `${id}-step`, sessionId: id, type: 'assistant', seq: 0, timeCreated: now, data });
  }
  // Missing second step makes the recorded $20 a partial cost subtotal too.
  insertMessage(writer, { id: 'high-missing', sessionId: 'high', type: 'assistant', seq: 1, timeCreated: now, data: {} });
  writer.close();
  const database = createDatabaseAdapter({ path, pathSource: 'flag' });
  const server = await startHttpServer(createDashboardServer({ database, staticRoot: join(dir, 'client') }));
  try {
    for (const sort of ['tokens', 'cost']) {
      for (const [direction, expected] of [
        ['desc', ['high', 'mid', 'low', 'zero', 'missing']],
        ['asc', ['zero', 'low', 'mid', 'high', 'missing']],
      ] as const) {
        const response = await fetchJson(`${server.url}/api/sessions?range=all&sort=${sort}&dir=${direction}`);
        assert.equal(response.status, 200);
        assert.deepEqual((response.body as SessionsResponse).sessions.map((row) => row.id), expected);
      }
    }
    const response = await fetchJson(`${server.url}/api/sessions?range=all&sort=tokens&dir=desc&offset=1&limit=2`);
    const page = response.body as SessionsResponse;
    assert.equal(page.total, 5);
    assert.deepEqual(page.sessions.map((row) => row.id), ['mid', 'low']);
  } finally {
    await server.close();
    database.close();
    removeTempDir(dir);
  }
});
