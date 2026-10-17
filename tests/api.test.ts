/**
 * Phase 2 gate: statistics HTTP surface.
 *
 * Plan references: §5 (endpoints, validation, error envelope, security),
 * §7 Phase 2 gate, §8 required checks 1, 3, 4, and 5.
 *
 * Every request runs against the real server over a real socket with the clock
 * frozen at `TEST_NOW` (2026-06-15T12:00:00Z, TZ=UTC), so ranges and expected
 * values are deterministic and hand-calculated from `helpers/stats-fixture.ts`.
 */

process.env.TZ = 'UTC';

import assert from 'node:assert/strict';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, before, describe, it } from 'node:test';

import { createDatabaseAdapter } from '../src/server/database.ts';
import { createDashboardServer } from '../src/server/http.ts';
import { createQueryRunner } from '../src/server/metrics.ts';
import { prepareStatsRequest } from '../src/server/stats.ts';

import type { DatabaseAdapter } from '../src/server/database.ts';
import type {
  ErrorEnvelope,
  ModelsResponse,
  OverviewResponse,
  ProjectsResponse,
  SessionDetailResponse,
  SessionsResponse,
  ToolsResponse,
} from '../src/shared/api.ts';
import type { RunningServer } from './helpers/server.ts';

import { createTempDir, removeTempDir } from './helpers/fixtures.ts';
import { fetchJson, fetchText, startHttpServer } from './helpers/server.ts';
import { TEST_NOW, appendConcurrentSession, createStatsFixture } from './helpers/stats-fixture.ts';

const realNow = Date.now;

let dir: string;
let database: DatabaseAdapter;
let server: RunningServer;
let base: string;

before(async () => {
  // Freeze the server clock so `Date.now()` resolves the same ranges the fixture
  // was built for.
  Date.now = () => TEST_NOW;

  dir = createTempDir('opencode-stats-api-');
  const path = join(dir, 'opencode.db');
  createStatsFixture(path);
  database = createDatabaseAdapter({ path, pathSource: 'flag' });
  server = await startHttpServer(
    createDashboardServer({
      database,
      staticRoot: join(dir, 'dist', 'client'),
      logger: { info: () => undefined, error: () => undefined },
    }),
  );
  base = server.url;
});

after(async () => {
  await server.close();
  database.close();
  removeTempDir(dir);
  Date.now = realNow;
});

async function get(path: string): Promise<{ status: number; headers: Headers; body: unknown }> {
  return fetchJson(`${base}${path}`);
}

/** A token total shape for compact assertions. */
function total(value: number | null, complete: boolean, measured: number, counted: number): {
  value: number | null;
  complete: boolean;
  measured: number;
  counted: number;
} {
  return { value, complete, measured, counted };
}

function assertClose(actual: number | null, expected: number, label: string): void {
  assert.ok(actual !== null, `${label}: expected ${String(expected)}, got null`);
  assert.ok(Math.abs(actual - expected) < 1e-9, `${label}: expected ${String(expected)}, got ${String(actual)}`);
}

describe('GET /api/stats/overview', () => {
  it('returns the headline metrics with a captured clock and resolved range', async () => {
    const response = await get('/api/stats/overview?range=7d');
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') ?? '', /^application\/json/);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');

    const body = response.body as OverviewResponse;
    assert.equal(body.generatedAt, '2026-06-15T12:00:00.000Z');
    assert.equal(body.range.key, '7d');
    assert.equal(body.range.from, '2026-06-09T00:00:00.000Z');
    assert.equal(body.range.to, '2026-06-15T12:00:00.000Z');
    assert.equal(body.range.fromDate, '2026-06-09');
    assert.equal(body.range.toDate, '2026-06-15');
    assert.equal(body.range.timezone, 'UTC');
    assert.equal(body.range.days, 7);
  });

  it('computes each metric exactly', async () => {
    const body = (await get('/api/stats/overview?range=7d')).body as OverviewResponse;

    assert.deepEqual(body.sessions, { total: 6, root: 5, subagent: 1 });
    assert.equal(body.prompts, 5);
    assert.equal(body.steps, 11);
    assert.equal(body.assistantErrors, 1);
    assert.deepEqual(body.coverage, { steps: 11, unreadableSteps: 1, costComplete: false, tokensComplete: false });

    assert.equal(body.usage.steps, 11);
    assert.deepEqual(body.usage.tokens.input, total(755, false, 10, 11));
    assert.deepEqual(body.usage.tokens.output, total(246, false, 10, 11));
    assert.deepEqual(body.usage.tokens.reasoning, total(50, false, 10, 11));
    assert.deepEqual(body.usage.tokens.cacheRead, total(300, false, 10, 11));
    assert.deepEqual(body.usage.tokens.cacheWrite, total(100, false, 10, 11));
    assert.equal(body.usage.tokens.total, null, 'an unreadable step makes the combined total unavailable');
    assert.equal(body.usage.cacheRate, null);
    assert.deepEqual(body.usage.cost, total(2.011, false, 9, 11));
    assertClose(body.usage.cost.value, 2.011, 'recorded cost');

    assert.deepEqual(body.activity, { activeDays: 6, longestStreak: 6 });
  });

  it('fills the daily series for exactly the resolved dates', async () => {
    const body = (await get('/api/stats/overview?range=7d')).body as OverviewResponse;
    assert.equal(body.daily.length, 7);
    assert.deepEqual(
      body.daily.map((point) => point.date),
      ['2026-06-09', '2026-06-10', '2026-06-11', '2026-06-12', '2026-06-13', '2026-06-14', '2026-06-15'],
    );
    assert.deepEqual(body.daily[0], { date: '2026-06-09', steps: 3, prompts: 1, tokens: 1251, cost: 1.251 });
    assert.deepEqual(body.daily[1], { date: '2026-06-10', steps: 2, prompts: 0, tokens: 45, cost: 0.55 });
    assert.deepEqual(body.daily[2], { date: '2026-06-11', steps: 3, prompts: 0, tokens: null, cost: null });
    assert.deepEqual(body.daily[3], { date: '2026-06-12', steps: 1, prompts: 1, tokens: 10, cost: 0.07 });
    assert.deepEqual(body.daily[4], { date: '2026-06-13', steps: 1, prompts: 1, tokens: 10, cost: 0.02 });
    assert.deepEqual(body.daily[5], { date: '2026-06-14', steps: 1, prompts: 2, tokens: 33, cost: 0.11 });
    assert.deepEqual(body.daily[6], { date: '2026-06-15', steps: 0, prompts: 0, tokens: 0, cost: 0 });
  });

  it('ranks agent groups and retains unknown agent names', async () => {
    const body = (await get('/api/stats/overview?range=7d')).body as OverviewResponse;
    assert.deepEqual(
      body.agents.map((agent) => [agent.agent, agent.steps, agent.usage.tokens.total]),
      [
        ['build', 4, 1293],
        ['plan', 3, 103],
        ['general', 2, 45],
        [null, 2, null],
      ],
    );
  });

  it('applies a project filter through the owning session', async () => {
    const body = (await get('/api/stats/overview?range=7d&projectId=proj-a')).body as OverviewResponse;
    assert.deepEqual(body.sessions, { total: 2, root: 1, subagent: 1 });
    assert.equal(body.prompts, 2);
    assert.equal(body.steps, 4);
    assert.equal(body.usage.tokens.total, 1295);
    assert.equal(body.usage.cost.value, 1.8);
    assertClose(body.usage.cacheRate, 300 / 1030, 'proj-a cache rate');
  });

  it('starts an all-range series at the earliest observed activity', async () => {
    const body = (await get('/api/stats/overview?range=all')).body as OverviewResponse;
    assert.equal(body.range.from, null);
    assert.equal(body.range.days, null);
    assert.equal(body.steps, 12);
    assert.equal(body.daily.length, 46);
    assert.equal(body.daily[0]?.date, '2026-05-01');
    assert.equal(body.daily[0]?.tokens, 1000, 'the pre-range step is included in all');
    assert.deepEqual(body.activity, { activeDays: 7, longestStreak: 6 });
    assert.equal(body.usage.tokens.input.value, 1755);
    assertClose(body.usage.cost.value, 2.111, 'all-range recorded cost');
  });

  it('returns measured zeros, not unavailable values, for an empty filter', async () => {
    const body = (await get('/api/stats/overview?range=7d&projectId=proj-none')).body as OverviewResponse;
    assert.deepEqual(body.sessions, { total: 0, root: 0, subagent: 0 });
    assert.equal(body.prompts, 0);
    assert.equal(body.steps, 0);
    assert.deepEqual(body.coverage, { steps: 0, unreadableSteps: 0, costComplete: true, tokensComplete: true });
    assert.deepEqual(body.usage.tokens.input, total(0, true, 0, 0));
    assert.equal(body.usage.tokens.total, 0);
    assert.equal(body.usage.cacheRate, null, 'no denominator means unavailable, never zero percent');
    assert.equal(body.daily.length, 7);
    assert.ok(body.daily.every((point) => point.steps === 0 && point.tokens === 0));
  });
});

describe('GET /api/stats/models', () => {
  it('groups by provider/model and combines variants', async () => {
    const body = (await get('/api/stats/models?range=7d')).body as ModelsResponse;
    assert.deepEqual(
      body.models.map((row) => [row.provider, row.model, row.steps, row.sessions, row.usage.tokens.total]),
      [
        ['prov-a', 'model-x', 4, 2, 1293],
        ['prov-a', 'model-z', 3, 1, 103],
        ['prov-b', 'model-y', 2, 1, 45],
        ['prov-c', 'model-w', 1, 1, 10],
        [null, null, 1, 1, null],
      ],
    );

    const modelX = body.models[0];
    assert.ok(modelX !== undefined);
    assert.deepEqual(modelX.usage.tokens.cacheWrite, total(100, true, 4, 4));
    assertClose(modelX.usage.cacheRate, 300 / 1016, 'model-x cache rate uses summed categories');

    const unknown = body.models[4];
    assert.ok(unknown !== undefined, 'unknown identities stay a group rather than being dropped');
    assert.deepEqual(unknown.usage.cost, total(null, false, 0, 1));
  });

  it('filters by model or provider/model without splitting remaining groups', async () => {
    const byModel = (await get('/api/stats/models?range=7d&model=model-x')).body as ModelsResponse;
    assert.deepEqual(byModel.models.map((row) => [row.provider, row.model, row.steps]), [['prov-a', 'model-x', 4]]);

    const byPair = (await get('/api/stats/models?range=7d&model=prov-a/model-x')).body as ModelsResponse;
    assert.equal(byPair.models.length, 1);

    const wrongProvider = (await get('/api/stats/models?range=7d&model=prov-b/model-x')).body as ModelsResponse;
    assert.deepEqual(wrongProvider.models, [], 'a same-name model at another provider must not match');
  });

  it('reports the filtered daily series without prompts', async () => {
    const body = (await get('/api/stats/models?range=7d')).body as ModelsResponse;
    assert.equal(body.daily.length, 7);
    assert.deepEqual(body.daily[0], { date: '2026-06-09', steps: 3, prompts: 0, tokens: 1251, cost: 1.251 });
    assert.deepEqual(body.daily[5], { date: '2026-06-14', steps: 1, prompts: 0, tokens: 33, cost: 0.11 });
  });
});

describe('GET /api/stats/projects', () => {
  it('labels projects by name, worktree, or ID and keeps an unknown group', async () => {
    const body = (await get('/api/stats/projects?range=7d')).body as ProjectsResponse;
    assert.deepEqual(
      body.projects.map((row) => [row.projectId, row.label, row.sessions, row.steps, row.usage.tokens.total]),
      [
        ['proj-a', 'alpha', 2, 4, 1295],
        [null, 'Unknown project', 1, 2, 20],
        ['proj-c', 'gamma', 1, 0, 0],
        ['proj-b', 'Beta Project', 2, 5, null],
      ],
    );

    const projectB = body.projects[3];
    assert.ok(projectB !== undefined);
    assert.equal(projectB.name, 'Beta Project');
    assert.equal(projectB.worktree, '/srv/work/beta');
    assert.deepEqual(projectB.usage.tokens.input, total(113, false, 4, 5));
    assert.equal(projectB.usage.cacheRate, null);
  });
});

describe('GET /api/stats/tools', () => {
  it('reports outcomes, failure rate, and duration percentiles', async () => {
    const body = (await get('/api/stats/tools?range=7d')).body as ToolsResponse;
    assert.deepEqual(body.totals, {
      calls: 8,
      succeeded: 6,
      failed: 1,
      unfinished: 1,
      failureRate: 1 / 7,
      duration: { count: 6, p50: 250, p95: 500 },
    });

    assert.deepEqual(
      body.tools.map((row) => [row.name, row.calls, row.succeeded, row.failed, row.unfinished]),
      [
        ['bash', 1, 0, 1, 0],
        ['edit', 1, 0, 0, 1],
        ['glob', 1, 1, 0, 0],
        ['grep', 1, 1, 0, 0],
        ['read', 1, 1, 0, 0],
        ['task', 1, 1, 0, 0],
        ['webfetch', 1, 1, 0, 0],
        ['write', 1, 1, 0, 0],
      ],
    );

    const edit = body.tools.find((row) => row.name === 'edit');
    assert.ok(edit !== undefined);
    assert.equal(edit.failureRate, null, 'no terminal call means an unavailable rate');
    assert.equal(edit.duration, null);
  });

  it('reports unavailable totals for an empty selection', async () => {
    const body = (await get('/api/stats/tools?range=7d&projectId=proj-none')).body as ToolsResponse;
    assert.deepEqual(body.totals, { calls: 0, succeeded: 0, failed: 0, unfinished: 0, failureRate: null, duration: null });
    assert.deepEqual(body.tools, []);
  });
});

describe('GET /api/sessions', () => {
  it('lists the active cohort with per-range usage and stable default ordering', async () => {
    const body = (await get('/api/sessions?range=7d')).body as SessionsResponse;
    assert.equal(body.total, 6);
    assert.equal(body.limit, 50);
    assert.equal(body.offset, 0);
    assert.equal(body.sort, 'updated');
    assert.equal(body.dir, 'desc');
    assert.deepEqual(body.coverage, { steps: 11, unreadableSteps: 1, costComplete: false, tokensComplete: false });

    assert.deepEqual(
      body.sessions.map((row) => row.id),
      ['ses-root-1', 'ses-fork', 'ses-user-only', 'ses-old-root', 'ses-root-2', 'ses-sub-1'],
    );

    const rootOne = body.sessions[0];
    assert.ok(rootOne !== undefined);
    assert.equal(rootOne.title, 'Root One');
    assert.equal(rootOne.projectLabel, 'alpha');
    assert.equal(rootOne.parentId, null);
    assert.equal(rootOne.isSubagent, false);
    assert.equal(rootOne.prompts, 2);
    assert.equal(rootOne.steps, 2);
    assert.equal(rootOne.usage.tokens.total, 1250);
    assert.equal(rootOne.usage.cacheRate, 0.3);

    const sub = body.sessions[5];
    assert.ok(sub !== undefined);
    assert.equal(sub.parentId, 'ses-root-1');
    assert.equal(sub.isSubagent, true);
  });

  it('sorts by an allowlisted key with a stable id tie-break', async () => {
    const bySteps = (await get('/api/sessions?range=7d&sort=steps&dir=asc')).body as SessionsResponse;
    assert.deepEqual(
      bySteps.sessions.map((row) => row.id),
      ['ses-user-only', 'ses-fork', 'ses-old-root', 'ses-root-1', 'ses-sub-1', 'ses-root-2'],
    );

    const byPrompts = (await get('/api/sessions?range=7d&sort=prompts&dir=desc')).body as SessionsResponse;
    assert.deepEqual(
      byPrompts.sessions.map((row) => [row.id, row.prompts]),
      [
        ['ses-root-1', 2],
        ['ses-fork', 1],
        ['ses-old-root', 1],
        ['ses-user-only', 1],
        ['ses-root-2', 0],
        ['ses-sub-1', 0],
      ],
    );

    const byTitle = (await get('/api/sessions?range=7d&sort=title&dir=asc')).body as SessionsResponse;
    assert.deepEqual(
      byTitle.sessions.map((row) => row.title),
      ['Fork', 'Old Root', 'Root One', 'Root Two', 'Sub One', 'User Only'],
    );
  });

  it('paginates without repeating or skipping rows', async () => {
    const pages: string[][] = [];
    for (const offset of [0, 2, 4]) {
      const page = (await get(`/api/sessions?range=7d&limit=2&offset=${String(offset)}`)).body as SessionsResponse;
      assert.equal(page.limit, 2);
      assert.equal(page.offset, offset);
      pages.push(page.sessions.map((row) => row.id));
    }
    assert.deepEqual(pages, [
      ['ses-root-1', 'ses-fork'],
      ['ses-user-only', 'ses-old-root'],
      ['ses-root-2', 'ses-sub-1'],
    ]);
    assert.equal(new Set(pages.flat()).size, 6, 'pages must not repeat a session');
  });

  it('searches titles and IDs but never message content', async () => {
    const body = (await get('/api/sessions?range=7d&search=fork')).body as SessionsResponse;
    assert.deepEqual(
      body.sessions.map((row) => row.id),
      ['ses-fork'],
    );

    const byId = (await get('/api/sessions?range=7d&search=ses-sub')).body as SessionsResponse;
    assert.deepEqual(
      byId.sessions.map((row) => row.id),
      ['ses-sub-1'],
    );

    const byContent = (await get('/api/sessions?range=7d&search=ignored by metrics')).body as SessionsResponse;
    assert.equal(byContent.total, 0, 'prompt bodies must not be searchable');
  });

  it('reconciles with the overview and excludes orphan steps from the list', async () => {
    const overview = (await get('/api/stats/overview?range=7d')).body as OverviewResponse;
    const list = (await get('/api/sessions?range=7d')).body as SessionsResponse;

    assert.equal(list.total, overview.sessions.total);
    const listSteps = list.sessions.reduce((sum, row) => sum + row.steps, 0);
    const listPrompts = list.sessions.reduce((sum, row) => sum + row.prompts, 0);
    assert.equal(listSteps, overview.steps - 1, 'the orphan step has no session row to list');
    assert.equal(listPrompts, overview.prompts);
  });
});

describe('GET /api/sessions/:id', () => {
  it('returns session statistics reconciling with the list row', async () => {
    const detail = (await get('/api/sessions/ses-root-1?range=7d')).body as SessionDetailResponse;
    assert.equal(detail.allActivity, false);
    assert.equal(detail.session.id, 'ses-root-1');
    assert.equal(detail.session.title, 'Root One');
    assert.equal(detail.session.projectLabel, 'alpha');
    assert.equal(detail.session.model, JSON.stringify({ id: 'model-x', providerID: 'prov-a', variant: 'high' }));
    assert.equal(detail.prompts, 2);
    assert.equal(detail.usage.tokens.total, 1250, 'the §4 example: 1,250 tokens');
    assert.equal(detail.usage.cacheRate, 0.3, 'the §4 example: 30% cache rate');
    assert.deepEqual(detail.activity, { activeDays: 1, longestStreak: 1 });
    assert.equal(detail.parent, null);
    assert.deepEqual(detail.children, [
      { id: 'ses-sub-1', title: 'Sub One', timeCreated: Date.UTC(2026, 5, 10, 7, 0, 0), steps: 2 },
    ]);

    const list = (await get('/api/sessions?range=7d')).body as SessionsResponse;
    const row = list.sessions.find((entry) => entry.id === 'ses-root-1');
    assert.ok(row !== undefined);
    assert.deepEqual(detail.usage, row.usage, 'detail and list usage must agree');
  });

  it('paginates steps in stable seq order with tool metadata', async () => {
    const body = (await get('/api/sessions/ses-root-1?range=7d')).body as SessionDetailResponse;
    assert.equal(body.steps.total, 2);
    assert.deepEqual(
      body.steps.entries.map((entry) => [entry.id, entry.seq, entry.hasError]),
      [
        ['msg-a1', 1, false],
        ['msg-a2', 2, true],
      ],
    );

    const first = body.steps.entries[0];
    assert.ok(first !== undefined);
    assert.equal(first.agent, 'build');
    assert.equal(first.provider, 'prov-a');
    assert.equal(first.model, 'model-x');
    assert.equal(first.usage.tokens.total, 1250);
    assert.deepEqual(first.tools, [
      { name: 'bash', status: 'failed', durationMs: 100 },
      { name: 'read', status: 'succeeded', durationMs: 500 },
      { name: 'write', status: 'succeeded', durationMs: 500 },
    ]);

    const page = (await get('/api/sessions/ses-root-1?range=7d&limit=1&offset=1')).body as SessionDetailResponse;
    assert.equal(page.steps.limit, 1);
    assert.equal(page.steps.offset, 1);
    assert.deepEqual(
      page.steps.entries.map((entry) => entry.id),
      ['msg-a2'],
    );
  });

  it('removes the range only for the explicit all-activity mode', async () => {
    const body = (await get('/api/sessions/ses-root-1?range=all')).body as SessionDetailResponse;
    assert.equal(body.allActivity, true);
    assert.equal(body.range.from, null);
    assert.equal(body.steps.total, 3);
    assert.equal(body.usage.tokens.total, 2250);
    assert.equal(body.daily.length, 46);
    assert.equal(body.daily[0]?.date, '2026-05-01');
  });

  it('does not count a subagent user message as a prompt', async () => {
    const body = (await get('/api/sessions/ses-sub-1?range=7d')).body as SessionDetailResponse;
    assert.equal(body.prompts, 0);
    assert.equal(body.session.isSubagent, true);
    assert.deepEqual(body.parent, { id: 'ses-root-1', title: 'Root One' });
    assert.equal(body.usage.tokens.total, 45);
  });

  it('succeeds with empty results for a real inactive session', async () => {
    const body = (await get('/api/sessions/ses-new-idle?range=7d')).body as SessionDetailResponse;
    assert.equal(body.session.id, 'ses-new-idle');
    assert.equal(body.steps.total, 0);
    assert.deepEqual(body.steps.entries, []);
    assert.equal(body.usage.tokens.total, 0);
  });

  it('answers 404 for an unknown session', async () => {
    const response = await get('/api/sessions/ses-nope?range=7d');
    assert.equal(response.status, 404);
    const body = response.body as ErrorEnvelope;
    assert.equal(body.error.code, 'not_found');
    assert.equal(body.generatedAt, '2026-06-15T12:00:00.000Z');
    assert.match(body.error.message, /ses-nope/);
  });

  it('answers 404 for an empty session ID path', async () => {
    assert.equal((await get('/api/sessions/')).status, 404);
  });
});

describe('validation and error envelope', () => {
  const badRequests: Array<[string, string]> = [
    ['/api/stats/overview?range=1d', 'range'],
    ['/api/stats/overview?range=', 'range'],
    ['/api/stats/overview?projectId=', 'projectId'],
    [`/api/stats/overview?projectId=${'x'.repeat(201)}`, 'projectId'],
    ['/api/sessions?range=7d&limit=abc', 'limit'],
    ['/api/sessions?range=7d&limit=201', 'limit'],
    ['/api/sessions?range=7d&offset=-1', 'offset'],
    ['/api/sessions?range=7d&offset=1000001', 'offset'],
    ['/api/sessions?range=7d&sort=bogus', 'sort'],
    ['/api/sessions?range=7d&dir=sideways', 'dir'],
    ['/api/sessions?range=7d&search=', 'search'],
    ['/api/stats/models?range=7d&model=', 'model'],
    ['/api/stats/models?range=7d&model=/x', 'model'],
  ];

  it('rejects invalid input with 400 and a safe envelope', async () => {
    for (const [path] of badRequests) {
      const response = await get(path);
      assert.equal(response.status, 400, `expected 400 for ${path}`);
      const body = response.body as ErrorEnvelope;
      assert.equal(body.error.code, 'bad_request', `wrong code for ${path}`);
      assert.equal(body.generatedAt, '2026-06-15T12:00:00.000Z', `wrong clock for ${path}`);
      assert.ok(body.error.message.length > 0);
      assert.ok(!body.error.message.includes('SELECT'), `SQL must not leak for ${path}`);
    }
  });

  it('ignores unknown query parameters', async () => {
    const response = await get('/api/stats/overview?range=7d&unexpected=1&sort=bogus');
    assert.equal(response.status, 200);
  });

  it('rejects unsupported methods with 405 and an Allow header', async () => {
    const response = await fetchText(`${base}/api/stats/overview`, { method: 'POST' });
    assert.equal(response.status, 405);
    assert.equal(response.headers.get('allow'), 'GET, HEAD');
    assert.equal((JSON.parse(response.text) as ErrorEnvelope).error.code, 'method_not_allowed');
  });

  it('answers HEAD with headers and no body', async () => {
    const response = await fetch(`${base}/api/stats/overview?range=7d`, { method: 'HEAD' });
    assert.equal(response.status, 200);
    assert.equal(await response.text(), '');
    assert.equal(response.headers.get('cache-control'), 'no-store');
  });

  it('never leaks prompt text or message payloads', async () => {
    const paths = [
      '/api/stats/overview?range=7d',
      '/api/stats/models?range=7d',
      '/api/stats/projects?range=7d',
      '/api/stats/tools?range=7d',
      '/api/sessions?range=7d',
      '/api/sessions/ses-root-1?range=7d',
    ];
    for (const path of paths) {
      const response = await fetchText(`${base}${path}`);
      assert.equal(response.status, 200, path);
      assert.ok(!response.text.includes('ignored by metrics'), `prompt body leaked for ${path}`);
      assert.ok(!response.text.includes('"content"'), `raw content leaked for ${path}`);
      assert.ok(!response.text.includes('not json at all'), `raw payload leaked for ${path}`);
    }
  });
});

describe('unavailable database', () => {
  it('answers statistics requests with 503 and the typed envelope', async () => {
    const missingDir = createTempDir('opencode-stats-missing-');
    const adapter = createDatabaseAdapter({ path: join(missingDir, 'absent.db'), pathSource: 'flag' });
    const missingServer = await startHttpServer(
      createDashboardServer({
        database: adapter,
        staticRoot: join(missingDir, 'dist', 'client'),
        logger: { info: () => undefined, error: () => undefined },
      }),
    );
    try {
      for (const path of ['/api/stats/overview', '/api/stats/models', '/api/stats/projects', '/api/stats/tools', '/api/sessions']) {
        const response = await fetchText(`${missingServer.url}${path}`);
        assert.equal(response.status, 503, `expected 503 for ${path}`);
        assert.equal(response.headers.get('cache-control'), 'no-store');
        const body = JSON.parse(response.text) as ErrorEnvelope;
        assert.equal(body.error.code, 'database_unavailable');
      }
      const detail = await fetchText(`${missingServer.url}/api/sessions/ses-root-1`);
      assert.equal(detail.status, 503, 'a missing database is unavailable, not an unknown session');
    } finally {
      await missingServer.close();
      adapter.close();
      removeTempDir(missingDir);
    }
  });
});

describe('multi-query consistency under concurrent writes', () => {
  it('keeps one snapshot per response and observes new commits on the next request', () => {
    const concurrentDir = createTempDir('opencode-stats-concurrent-');
    const path = join(concurrentDir, 'wal.db');
    createStatsFixture(path, { journalMode: 'wal' });
    const writer = new DatabaseSync(path);
    const adapter = createDatabaseAdapter({ path, pathSource: 'flag', busyTimeoutMs: 500 });

    try {
      const now = TEST_NOW;
      const overviewRequest = (): { ok: true; build: (context: { runner: ReturnType<typeof createQueryRunner>; now: number }) => { payload: unknown } } => {
        const prepared = prepareStatsRequest('stats/overview', new URLSearchParams('range=7d'), now);
        assert.ok(prepared.ok);
        return prepared;
      };

      let injected = false;
      const payload = adapter.withRead((db) => {
        const base = createQueryRunner(db);
        const runner = {
          all<T>(sql: string, params?: readonly (null | number | bigint | string | Uint8Array)[]): T[] {
            const rows = base.all<T>(sql, params);
            // Commit a whole new session (one query in) through a separate
            // connection. Later queries must still see the transaction snapshot.
            if (!injected) {
              injected = true;
              appendConcurrentSession(writer, 'ses-concurrent');
            }
            return rows;
          },
          get<T>(sql: string, params?: readonly (null | number | bigint | string | Uint8Array)[]): T | undefined {
            return base.get<T>(sql, params);
          },
        };
        return overviewRequest().build({ runner, now }).payload as OverviewResponse;
      });

      assert.equal(injected, true, 'the concurrent commit must have been attempted');
      assert.equal(payload.steps, 11, 'later queries keep the snapshot taken at the first read');
      assert.equal(payload.prompts, 5, 'a leaked commit would raise this to 6');
      assert.deepEqual(payload.sessions, { total: 6, root: 5, subagent: 1 }, 'a leaked commit would raise the cohort');
      assert.equal(payload.usage.steps, 11);
      assert.equal(payload.agents.reduce((sum, agent) => sum + agent.steps, 0), 11);
      assert.equal(payload.daily.reduce((sum, point) => sum + point.steps, 0), 11);

      // A new request starts a new short transaction and sees the commit.
      const refreshed = adapter.withRead((db) => {
        const runner = createQueryRunner(db);
        return overviewRequest().build({ runner, now }).payload as OverviewResponse;
      });
      assert.equal(refreshed.steps, 12);
      assert.equal(refreshed.prompts, 6);
      assert.deepEqual(refreshed.sessions, { total: 7, root: 6, subagent: 1 });
    } finally {
      writer.close();
      adapter.close();
      removeTempDir(concurrentDir);
    }
  });
});
