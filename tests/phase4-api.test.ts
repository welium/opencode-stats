import assert from 'node:assert/strict';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, it } from 'node:test';
import { createDatabaseAdapter } from '../src/server/database.ts';
import { createDashboardServer } from '../src/server/http.ts';
import type { ErrorsResponse, ModelsResponse, OverviewResponse, ProjectsResponse, SessionDetailResponse, SessionsResponse } from '../src/shared/api.ts';
import { createTempDir, insertMessage, removeTempDir } from './helpers/fixtures.ts';
import { createPhase4Fixture, PHASE4_SECRET, setPhase4Catalog } from './helpers/phase4-fixture.ts';
import { fetchJson, startHttpServer } from './helpers/server.ts';

describe('Phase 4 real HTTP, read-only transactions and privacy', () => {
  it('reconciles estimates across every usage endpoint, rereads catalogs, and preserves recorded cost', async () => {
    const dir = createTempDir('opencode-phase4-');
    const path = join(dir, 'db');
    createPhase4Fixture(path);
    const adapter = createDatabaseAdapter({ path, pathSource: 'flag' });
    const writer = new DatabaseSync(path);
    writer.exec("UPDATE session_message SET data = json_set(data, '$.cost', 0) WHERE id = 'm1'");
    const server = await startHttpServer(createDashboardServer({ database: adapter, staticRoot: join(dir, 'static'), logger: { info() {}, error() {} } }));
    const get = async <T>(endpoint: string): Promise<T> => {
      const response = await fetchJson(`${server.url}${endpoint}`);
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('cache-control'), 'no-store');
      assert.ok(!JSON.stringify(response.body).includes(PHASE4_SECRET));
      return response.body as T;
    };
    try {
      const overview = await get<OverviewResponse>('/api/stats/overview?range=all');
      assert.equal(overview.usage.steps, 2);
      assert.equal(overview.usage.cost.value, 7);
      assert.equal(overview.estimate.status, 'complete');
      assert.equal(overview.estimate.cost, 7 + .00365);
      assert.equal(overview.dailyEstimates.reduce((sum, row) => sum + (row.estimate.cost ?? 0), 0), 7 + .00365);
      assert.equal(overview.agents[0]?.estimate?.cost, 7 + .00365);
      const models = await get<ModelsResponse>('/api/stats/models?range=all');
      assert.equal(models.models.reduce((sum, row) => sum + row.estimate.cost!, 0), 7 + .00365);
      const projects = await get<ProjectsResponse>('/api/stats/projects?range=all');
      assert.equal(projects.projects[0]?.estimate.cost, 7 + .00365);
      const sessions = await get<SessionsResponse>('/api/sessions?range=all');
      assert.equal(sessions.sessions[0]?.estimate.cost, 7 + .00365);
      const detail = await get<SessionDetailResponse>('/api/sessions/s?range=all');
      assert.equal(detail.estimate.cost, 7 + .00365);
      assert.equal(detail.steps.entries.reduce((sum, row) => sum + row.estimate.cost!, 0), 7 + .00365);
      const filtered = await get<OverviewResponse>('/api/stats/overview?range=all&projectId=missing');
      assert.equal(filtered.estimate.steps, 0);
      assert.equal(filtered.estimate.cost, 0);
      const inactive = await get<SessionDetailResponse>('/api/sessions/fork?range=all');
      assert.equal(inactive.estimate.steps, 0);

      setPhase4Catalog(writer, 'partial');
      const partial = await get<OverviewResponse>('/api/stats/overview?range=all');
      assert.equal(partial.estimate.status, 'partial');
      assert.equal(partial.estimate.cost, 7);
      assert.equal(partial.dailyEstimates.find((row) => row.estimate.steps > 0)?.estimate.status, 'partial');
      assert.equal(partial.estimate.unpricedSteps, 1);
      assert.equal(partial.estimate.unpricedModels[0]?.model, 'second');
      assert.deepEqual(partial.usage, overview.usage);

      setPhase4Catalog(writer, 'complete', 4);
      const updated = await get<OverviewResponse>('/api/stats/overview?range=all');
      assert.equal(updated.estimate.cost, 7 + .00485);
      assert.equal(updated.dailyEstimates.reduce((sum, row) => sum + (row.estimate.cost ?? 0), 0), 7 + .00485);
      assert.notEqual(updated.estimate.catalog.updatedAt, overview.estimate.catalog.updatedAt);
      assert.deepEqual(updated.usage, overview.usage);

      for (const mode of ['malformed', 'missing', 'absent-table'] as const) {
        if (mode === 'malformed') setPhase4Catalog(writer, 'unavailable');
        if (mode === 'missing') writer.exec('DELETE FROM kv');
        if (mode === 'absent-table') writer.exec('DROP TABLE kv');
        const unavailable = await get<OverviewResponse>('/api/stats/overview?range=all');
        assert.equal(unavailable.estimate.status, 'partial');
        assert.equal(unavailable.estimate.cost, 7);
        assert.ok(unavailable.dailyEstimates.filter((row) => row.estimate.steps > 0).every((row) => row.estimate.status === 'partial'));
        assert.deepEqual(unavailable.usage, overview.usage);
      }
      writer.exec("UPDATE session_message SET data = json_set(data, '$.cost', 7) WHERE id = 'm1'");
      const paid = await get<OverviewResponse>('/api/stats/overview?range=all');
      assert.equal(paid.estimate.catalog.available, false);
      assert.equal(paid.estimate.status, 'complete');
      assert.equal(paid.estimate.cost, 14);
    } finally {
      await server.close(); writer.close(); adapter.close(); removeTempDir(dir);
    }
  });

  it('returns only safe bounded error metadata, counts and session links with stable pagination', async () => {
    const dir = createTempDir('opencode-phase4-errors-');
    const path = join(dir, 'db');
    createPhase4Fixture(path);
    const adapter = createDatabaseAdapter({ path, pathSource: 'flag' });
    const writer = new DatabaseSync(path);
    const server = await startHttpServer(createDashboardServer({ database: adapter, staticRoot: dir, logger: { info() {}, error() {} } }));
    try {
      const response = await fetchJson(`${server.url}/api/stats/errors?range=all&limit=2`);
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('cache-control'), 'no-store');
      const body = response.body as ErrorsResponse;
      assert.equal(body.assistantErrors, 2);
      assert.equal(body.toolFailures, 2);
      assert.equal(body.total, 4);
      assert.equal(body.entries.length, 2);
      assert.ok(body.entries.every((entry) => entry.sessionId === 's'));
      assert.deepEqual(body.groups.map((group) => [group.kind, group.type, group.count]).sort(), [['assistant', 'APIError', 1], ['assistant', 'UnknownError', 1], ['tool', 'failed', 1], ['tool', 'failed', 1]].sort());
      assert.ok(!JSON.stringify(body).includes(PHASE4_SECRET));
      assert.ok(!JSON.stringify(body).includes('shell'));
      for (const entry of body.entries) assert.deepEqual(Object.keys(entry).sort(), ['kind', 'messageId', 'model', 'provider', 'sessionId', 'timeCreated', 'type']);
      const page2 = (await fetchJson(`${server.url}/api/stats/errors?range=all&limit=2&offset=2`)).body as ErrorsResponse;
      assert.ok(page2.entries.every((entry) => entry.messageId !== body.entries[0]?.messageId));
      const all = (await fetchJson(`${server.url}/api/stats/errors?range=all&limit=0`)).body as ErrorsResponse;
      assert.equal(all.entries.length, 0);
      assert.equal(all.total, 4);
      const filtered = (await fetchJson(`${server.url}/api/stats/errors?range=all&projectId=missing`)).body as ErrorsResponse;
      assert.equal(filtered.total, 0);
      for (const query of ['range=no', 'limit=201', 'limit=-1', 'limit=1.5', 'offset=1000001', 'offset=no', `projectId=${'x'.repeat(201)}`]) {
        assert.equal((await fetchJson(`${server.url}/api/stats/errors?${query}`)).status, 400, query);
      }
      assert.equal((await fetchJson(`${server.url}/api/stats/errors`, { method: 'POST' })).status, 405);
      writer.exec("DELETE FROM session_message WHERE id = 'm1'");
      const refreshed = (await fetchJson(`${server.url}/api/stats/errors?range=all`)).body as ErrorsResponse;
      assert.equal(refreshed.total, 2);
      assert.equal(refreshed.assistantErrors, 1);
      for (let index = 0; index < 220; index++) {
        insertMessage(writer, { id: `bounded-${index}`, sessionId: 's', type: 'assistant', seq: index + 10, timeCreated: Date.now() - 1000,
          data: { model: { providerID: 'provider', id: `model-${index}` }, error: { name: 'APIError', message: PHASE4_SECRET },
            content: [{ type: 'tool', state: { status: 'running' } }, { type: 'tool', state: { status: 'completed' } }] } });
      }
      const bounded = (await fetchJson(`${server.url}/api/stats/errors?range=all&limit=200`)).body as ErrorsResponse;
      assert.equal(bounded.entries.length, 200);
      assert.equal(bounded.groups.length, 100);
      assert.equal(bounded.groupsTruncated, true);
      assert.equal(bounded.assistantErrors, 221);
      assert.equal(bounded.toolFailures, 1);
      assert.ok(!JSON.stringify(bounded).includes(PHASE4_SECRET));
    } finally {
      await server.close(); writer.close(); adapter.close(); removeTempDir(dir);
    }
  });

  it('keeps the Errors shell API unavailable when the database is missing', async () => {
    const dir = createTempDir('opencode-phase4-missing-');
    const adapter = createDatabaseAdapter({ path: join(dir, 'missing.db'), pathSource: 'flag' });
    const server = await startHttpServer(createDashboardServer({ database: adapter, staticRoot: dir, logger: { info() {}, error() {} } }));
    try {
      const response = await fetchJson(`${server.url}/api/stats/errors`);
      assert.equal(response.status, 503);
      assert.equal((response.body as { error: { code: string } }).error.code, 'database_unavailable');
    } finally {
      await server.close(); adapter.close(); removeTempDir(dir);
    }
  });
});
