import assert from 'node:assert/strict';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { it } from 'node:test';
import { createDatabaseAdapter, DatabaseUnavailableError } from '../src/server/database.ts';
import { createDashboardServer } from '../src/server/http.ts';
import type { OverviewResponse } from '../src/shared/api.ts';
import { createTempDir, removeTempDir } from './helpers/fixtures.ts';
import { createPhase4Fixture } from './helpers/phase4-fixture.ts';
import { fetchJson, startHttpServer } from './helpers/server.ts';

it('checks warm health and statistics under an exclusive lock and recovers without restart', async () => {
  const dir = createTempDir('opencode-warm-lock-');
  const path = join(dir, 'db');
  createPhase4Fixture(path);
  const writer = new DatabaseSync(path);
  writer.exec('PRAGMA journal_mode = DELETE');
  const adapter = createDatabaseAdapter({ path, pathSource: 'flag', busyTimeoutMs: 1 });
  const server = await startHttpServer(createDashboardServer({ database: adapter, staticRoot: dir, logger: { info() {}, error() {} } }));
  try {
    for (const endpoint of ['health', 'stats/overview?range=all']) {
      assert.equal((await fetchJson(`${server.url}/api/${endpoint}`)).status, 200);
    }
    writer.exec('BEGIN EXCLUSIVE');
    // Exercise failure inside a warm read before inspect has closed the handle.
    assert.throws(() => adapter.withRead((db) => db.prepare('SELECT * FROM session_message').all()),
      (error: unknown) => error instanceof DatabaseUnavailableError && error.status.state === 'busy');
    for (const endpoint of ['health', 'stats/overview?range=all']) {
      const response = await fetchJson(`${server.url}/api/${endpoint}`);
      assert.equal(response.status, 503);
      assert.equal(response.headers.get('cache-control'), 'no-store');
      assert.match(JSON.stringify(response.body), /busy|locked/);
      assert.doesNotMatch(JSON.stringify(response.body), /internal_error/);
    }
    writer.exec('ROLLBACK');
    assert.equal(adapter.inspect().status.state, 'ready');
    // Also exercise inspect as the first operation against a warmed locked DB.
    writer.exec('BEGIN EXCLUSIVE');
    const health = await fetchJson(`${server.url}/api/health`);
    assert.equal(health.status, 503);
    assert.match(JSON.stringify(health.body), /busy/);
    writer.exec('ROLLBACK');
    assert.equal((await fetchJson(`${server.url}/api/health`)).status, 200);
    assert.equal((await fetchJson(`${server.url}/api/stats/overview?range=all`)).status, 200);
    const bug = new Error('callback bug');
    assert.throws(() => adapter.withRead(() => { throw bug; }), (error: unknown) => error === bug);
    const nonSqliteBug = Object.assign(new Error('not SQLite'), { errcode: 5 });
    assert.throws(() => adapter.withRead(() => { throw nonSqliteBug; }), (error: unknown) => error === nonSqliteBug);
    assert.throws(() => adapter.withRead((db) => db.prepare('SELECT nonexistent_column FROM session_message').all()),
      (error: unknown) => error instanceof Error && !(error instanceof DatabaseUnavailableError));
    // Extended operational codes retain their primary SQLite classification.
    assert.throws(() => adapter.withRead(() => { throw Object.assign(new Error('locked'), { code: 'ERR_SQLITE_ERROR', errcode: 262 }); }),
      (error: unknown) => error instanceof DatabaseUnavailableError && error.status.state === 'busy');
    assert.equal(adapter.inspect().status.state, 'ready');
  } finally {
    await server.close(); writer.close(); adapter.close(); removeTempDir(dir);
  }
});

for (const invalid of [-1, true, false, '100', {}, [], null, 1e999]) {
  it(`preserves unavailable coverage for malformed usage ${String(invalid)}`, async () => {
    const dir = createTempDir('opencode-invalid-usage-');
    const path = join(dir, 'db');
    createPhase4Fixture(path);
    const writer = new DatabaseSync(path);
    const adapter = createDatabaseAdapter({ path, pathSource: 'flag' });
    const server = await startHttpServer(createDashboardServer({ database: adapter, staticRoot: dir, logger: { info() {}, error() {} } }));
    try {
      // Keep one fully measured 1250-token/$7 step on the same local date.
      const payload = JSON.stringify({
        model: { providerID: 'provider', id: 'second' }, cost: invalid,
        tokens: { input: invalid, output: invalid, reasoning: invalid, cache: { read: invalid, write: invalid } },
      }, (_key, value: unknown) => value === Infinity ? '__infinite_number__' : value)
        .replaceAll('"__infinite_number__"', '1e999');
      writer.prepare('UPDATE session_message SET data = ? WHERE id = ?').run(payload, 'm1');
      const response = await fetchJson(`${server.url}/api/stats/overview?range=all`);
      assert.equal(response.status, 200);
      const data = response.body as OverviewResponse;
      assert.equal(data.steps, 2);
      assert.equal(data.usage.cost.value, 7);
      assert.equal(data.usage.cost.complete, false);
      assert.equal(data.usage.cost.measured, 1);
      assert.equal(data.usage.tokens.total, null);
      for (const category of ['input', 'output', 'reasoning', 'cacheRead', 'cacheWrite'] as const) {
        assert.equal(data.usage.tokens[category].complete, false);
        assert.equal(data.usage.tokens[category].measured, 1);
      }
      const day = data.daily.find((point) => point.steps > 0)!;
      assert.equal(day.tokens, 1250);
      assert.equal(day.tokenCompleteSteps, 1);
      assert.equal(day.cost, null);
      assert.equal(data.estimate.status, 'partial');
      assert.equal(data.estimate.pricedSteps, 1);
      assert.equal(data.dailyEstimates.find((point) => point.estimate.steps > 0)?.estimate.status, 'partial');
      // Real numeric zero is measured, not missing, in every category and cost.
      writer.prepare('UPDATE session_message SET data = ? WHERE id = ?').run(JSON.stringify({
        model: { providerID: 'provider', id: 'second' }, cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      }), 'm1');
      const zero = (await fetchJson(`${server.url}/api/stats/overview?range=all`)).body as OverviewResponse;
      assert.equal(zero.usage.cost.complete, true);
      assert.equal(zero.usage.tokens.total, 1250);
      assert.equal(zero.daily.find((point) => point.steps > 0)?.tokens, 1250);
      assert.equal(zero.daily.find((point) => point.steps > 0)?.tokenCompleteSteps, 2);
      assert.equal(zero.daily.find((point) => point.steps > 0)?.cost, 7);
      assert.equal(zero.estimate.status, 'complete');
    } finally {
      await server.close(); writer.close(); adapter.close(); removeTempDir(dir);
    }
  });
}

it('retains input-only usage in a daily subtotal with incomplete coverage', async () => {
  const dir = createTempDir('opencode-partial-day-');
  const path = join(dir, 'db');
  createPhase4Fixture(path);
  const writer = new DatabaseSync(path);
  writer.prepare('UPDATE session_message SET data = ? WHERE id = ?').run(JSON.stringify({ tokens: { input: 100 } }), 'm1');
  const adapter = createDatabaseAdapter({ path, pathSource: 'flag' });
  const server = await startHttpServer(createDashboardServer({ database: adapter, staticRoot: dir, logger: { info() {}, error() {} } }));
  try {
    const data = (await fetchJson(`${server.url}/api/stats/overview?range=all`)).body as OverviewResponse;
    assert.equal(data.usage.tokens.input.value, 700);
    assert.equal(data.usage.tokens.total, null);
    assert.equal(data.usage.cost.complete, false);
    assert.equal(data.daily.find((point) => point.steps > 0)?.tokens, 1350);
    assert.equal(data.daily.find((point) => point.steps > 0)?.tokenCompleteSteps, 1);
    assert.equal(data.daily.find((point) => point.steps > 0)?.cost, null);
  } finally {
    await server.close(); writer.close(); adapter.close(); removeTempDir(dir);
  }
});
