import assert from 'node:assert/strict';
import { renameSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { it } from 'node:test';
import { createDatabaseAdapter } from '../src/server/database.ts';
import { createDashboardServer } from '../src/server/http.ts';
import type { OverviewResponse, SessionDetailResponse } from '../src/shared/api.ts';
import { assistantPayload, createTempDir, insertMessage, removeTempDir } from './helpers/fixtures.ts';
import { createPhase4Fixture } from './helpers/phase4-fixture.ts';
import { fetchJson, startHttpServer } from './helpers/server.ts';

it('refreshes committed inserts, unfinished-step updates, deletions, missing files and replacements over HTTP', async () => {
  const dir = createTempDir('opencode-refresh-');
  const path = join(dir, 'db');
  const adapter = createDatabaseAdapter({ path, pathSource: 'flag' });
  const server = await startHttpServer(createDashboardServer({ database: adapter, staticRoot: dir, logger: { info() {}, error() {} } }));
  let writer: DatabaseSync | undefined;
  const overview = async (): Promise<OverviewResponse> => {
    const response = await fetchJson(`${server.url}/api/stats/overview?range=all`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    return response.body as OverviewResponse;
  };
  try {
    assert.equal((await fetchJson(`${server.url}/api/stats/overview?range=all`)).status, 503);
    createPhase4Fixture(path);
    writer = new DatabaseSync(path);
    // DELETE mode permits safe fixture replacement without live WAL sidecars.
    // Separate adapter/transaction tests exercise concurrent WAL commits.
    writer.exec('PRAGMA journal_mode = DELETE');
    assert.equal((await overview()).usage.cost.value, 14);
    insertMessage(writer, { id: 'unfinished', sessionId: 's', seq: 3, type: 'assistant', timeCreated: Date.now() - 1000,
      data: assistantPayload({ cost: null, tokens: null }) });
    assert.equal((await overview()).usage.steps, 3);
    assert.equal((await overview()).usage.cost.complete, false);
    writer.prepare('UPDATE session_message SET data = ? WHERE id = ?').run(JSON.stringify(assistantPayload({ cost: 5,
      tokens: { input: 10, output: 20, reasoning: 30, cache: { read: 40, write: 50 } } })), 'unfinished');
    const completed = await overview();
    assert.equal(completed.usage.cost.value, 19);
    assert.equal(completed.usage.cost.complete, true);
    assert.equal(completed.usage.tokens.total, 2650);
    const detail = (await fetchJson(`${server.url}/api/sessions/s?range=all`)).body as SessionDetailResponse;
    assert.deepEqual(detail.usage, completed.usage);
    writer.exec("DELETE FROM session_message WHERE id IN ('m0', 'unfinished')");
    const deleted = await overview();
    assert.equal(deleted.usage.steps, 1);
    assert.equal(deleted.usage.cost.value, 7);
    assert.equal(deleted.usage.tokens.total, 1250);
    writer.close();
    writer = undefined;
    // Rename complete, closed databases only; never replace an actively written WAL file.
    createPhase4Fixture(join(dir, 'replacement'));
    renameSync(path, join(dir, 'old'));
    renameSync(join(dir, 'replacement'), path);
    // No intervening failed request: the healthy handle must detect new identity.
    assert.equal((await overview()).usage.cost.value, 14);
    assert.equal((await overview()).usage.steps, 2);
    renameSync(path, join(dir, 'temporarily-missing'));
    assert.equal((await fetchJson(`${server.url}/api/stats/overview?range=all`)).status, 503);
    renameSync(join(dir, 'temporarily-missing'), path);
    assert.equal((await overview()).usage.cost.value, 14);
  } finally {
    await server.close(); writer?.close(); adapter.close(); removeTempDir(dir);
  }
});
