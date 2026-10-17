/**
 * Phase 2 performance sanity check.
 *
 * Plan references: §7 Phase 2 ("Inspect query plans and representative timings
 * before claiming performance; existing timestamp/session indexes are available
 * but JSON aggregation still scans the selected messages") and §8.
 *
 * ALL DATA HERE IS SYNTHETIC: `buildSyntheticDatabase` generates a deterministic
 * database with realistic row counts and payload shapes, then adds the indexes the
 * live OpenCode database actually ships (`OPENCODE_READ_INDEXES`). It never reads,
 * copies, or benchmarks the user's real database. Timings are therefore only a
 * sanity check that the queries are index-backed and not accidentally quadratic —
 * not a benchmark claim about any real installation.
 */

process.env.TZ = 'UTC';

import assert from 'node:assert/strict';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, before, describe, it } from 'node:test';

import {
  buildStepRowsQuery,
  buildToolRowsQuery,
  createQueryRunner,
  loadStepRows,
  loadToolRows,
} from '../src/server/metrics.ts';

import type { MetricScope } from '../src/server/metrics.ts';
import type { TestContext } from 'node:test';

import { applyReadIndexes, createTempDir, openFixtureDatabase, removeTempDir } from './helpers/fixtures.ts';
import { TEST_NOW } from './helpers/stats-fixture.ts';

// Roughly the shape of an active local installation, not a live row count.
const SESSION_COUNT = 3000;
const ASSISTANT_PER_SESSION = 10;
const USER_PER_SESSION = 3;
const TOTAL_MESSAGES = SESSION_COUNT * (ASSISTANT_PER_SESSION + USER_PER_SESSION);
const ASSISTANT_TOTAL = SESSION_COUNT * ASSISTANT_PER_SESSION;

const DAY = 86_400_000;
/** Local (UTC here) midnight of the clock's date, for a finite 7d lower bound. */
const SEVEN_DAY_FROM = TEST_NOW - 6 * DAY - (TEST_NOW % DAY);

let dir: string;
let db: DatabaseSync;
let runner: ReturnType<typeof createQueryRunner>;

const SCOPE_7D: MetricScope = { from: SEVEN_DAY_FROM, to: TEST_NOW, projectId: null, sessionId: null };
const SCOPE_ALL: MetricScope = { from: null, to: TEST_NOW, projectId: null, sessionId: null };

/** A small deterministic PRNG so generated data (and timings) are reproducible. */
function createRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

/**
 * Create the synthetic usage database: projects, sessions spread over ~200 days,
 * per-session assistant steps with a tool item, user prompts, a few unreadable
 * payloads, and occasional missing costs.
 */
function buildSyntheticDatabase(path: string): void {
  const handle = openFixtureDatabase(path, 'delete');
  applyReadIndexes(handle);
  const random = createRandom(0x5eed_1234);
  const models = [
    { id: 'model-x', providerID: 'prov-a', variant: 'high' },
    { id: 'model-y', providerID: 'prov-b', variant: null },
    { id: 'model-z', providerID: 'prov-a', variant: 'medium' },
  ];
  const agents: Array<string | null> = ['build', 'plan', 'general', null];
  const tools = ['read', 'write', 'bash', 'grep', 'glob', 'task', 'edit', 'webfetch'];

  const insertProject = handle.prepare('INSERT INTO project (id, worktree, name) VALUES (?, ?, ?)');
  const insertSession = handle.prepare(
    `INSERT INTO session_v2 (id, project_id, parent_id, directory, title, model, cost,
       tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write,
       time_created, time_updated)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, 0, 0, 0, ?, ?)`,
  );
  const insertMessage = handle.prepare(
    `INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );

  handle.exec('BEGIN');
  for (let project = 0; project < 20; project += 1) {
    insertProject.run(`project-${String(project)}`, `/srv/work/project-${String(project)}`, project % 3 === 0 ? null : `Project ${String(project)}`);
  }

  let messageCount = 0;
  for (let session = 0; session < SESSION_COUNT; session += 1) {
    const dayOffset = Math.floor(random() * 200);
    // Keep every generated timestamp strictly before the clock so `all` has a
    // stable expected row count.
    const created = TEST_NOW - 3_600_000 - dayOffset * DAY - Math.floor(random() * DAY);
    const parentId = session % 11 === 0 && session > 0 ? `session-${String(session - 1)}` : null;
    insertSession.run(
      `session-${String(session)}`,
      `project-${String(session % 20)}`,
      parentId,
      '/srv/work/project-0',
      `Session ${String(session)}`,
      JSON.stringify(models[session % models.length]),
      0,
      created,
      created + 3_600_000,
    );

    for (let step = 0; step < ASSISTANT_PER_SESSION; step += 1) {
      const time = created + step * 60_000;
      const payload =
        random() < 0.03
          ? 'not json at all'
          : JSON.stringify({
              time: { created: time, streamed: time + 500, completed: time + 900 },
              agent: agents[Math.floor(random() * agents.length)],
              model: models[Math.floor(random() * models.length)],
              cost: random() < 0.03 ? null : Math.round(random() * 100_000) / 1000,
              tokens: {
                input: Math.floor(random() * 4000),
                output: Math.floor(random() * 2000),
                reasoning: Math.floor(random() * 500),
                cache: { read: Math.floor(random() * 4000), write: Math.floor(random() * 1000) },
              },
              content: [
                { type: 'text', text: 'synthetic assistant text that is never returned to a client' },
                {
                  type: 'tool',
                  name: tools[Math.floor(random() * tools.length)],
                  state: { status: random() < 0.05 ? 'error' : 'completed', input: { path: '/synthetic/file' } },
                  time: { created: time + 10, ran: time + 20, completed: time + 20 + Math.floor(random() * 2000) },
                },
              ],
            });
      insertMessage.run(`msg-${String(messageCount)}`, `session-${String(session)}`, 'assistant', step * 2, time, time, payload);
      messageCount += 1;
    }

    for (let prompt = 0; prompt < USER_PER_SESSION; prompt += 1) {
      const time = created + prompt * 300_000;
      insertMessage.run(
        `msg-${String(messageCount)}`,
        `session-${String(session)}`,
        'user',
        prompt,
        time,
        time,
        JSON.stringify({ time: { created: time }, text: 'synthetic prompt body' }),
      );
      messageCount += 1;
    }
  }
  handle.exec('COMMIT');
  handle.close();
}

/** Median of `runs` timings, to reduce one-off scheduling noise. */
function medianDurationMs(runs: number, fn: () => number): { ms: number; rows: number } {
  const timings: number[] = [];
  let rows = 0;
  for (let index = 0; index < runs; index += 1) {
    const start = performance.now();
    rows = fn();
    timings.push(performance.now() - start);
  }
  timings.sort((left, right) => left - right);
  return { ms: timings[Math.floor(timings.length / 2)] ?? 0, rows };
}

function queryPlan(scope: MetricScope, builder: (scope: MetricScope) => { sql: string; params: readonly unknown[] }): string {
  const { sql, params } = builder(scope);
  const rows = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...(params as never[]));
  return rows.map((row) => String((row as { detail?: unknown }).detail ?? '')).join(' | ');
}

before(() => {
  dir = createTempDir('opencode-stats-perf-');
  const path = join(dir, 'synthetic.db');
  buildSyntheticDatabase(path);
  db = new DatabaseSync(path, { readOnly: true });
  runner = createQueryRunner(db);
});

after(() => {
  db.close();
  removeTempDir(dir);
});

describe('synthetic query plans and timings', () => {
  it('uses the message timestamp index for a finite range', (t: TestContext) => {
    const stepPlan = queryPlan(SCOPE_7D, buildStepRowsQuery);
    const toolPlan = queryPlan(SCOPE_7D, buildToolRowsQuery);

    t.diagnostic(`7d step plan:  ${stepPlan}`);
    t.diagnostic(`7d tool plan:  ${toolPlan}`);

    assert.match(stepPlan, /session_message_time_created_idx/, 'a finite range must search the timestamp index');
    assert.match(toolPlan, /session_message_time_created_idx/);
    assert.doesNotMatch(stepPlan, /SCAN m\b/, 'the message table must not be fully scanned for a finite range');
  });

  it('bounds the all-range scan by the upper bound instead of scanning unbounded', (t: TestContext) => {
    const plan = queryPlan(SCOPE_ALL, buildStepRowsQuery);
    t.diagnostic(`all step plan: ${plan}`);
    assert.match(plan, /session_message_time_created_idx \(time_created<\?\)/);
  });

  it('loads the selected messages with representative timings', (t: TestContext) => {
    const sevenDaySteps = medianDurationMs(3, () => loadStepRows(runner, SCOPE_7D).length);
    const allSteps = medianDurationMs(3, () => loadStepRows(runner, SCOPE_ALL).length);
    const sevenDayTools = medianDurationMs(3, () => loadToolRows(runner, SCOPE_7D).length);
    const allTools = medianDurationMs(3, () => loadToolRows(runner, SCOPE_ALL).length);

    t.diagnostic(`synthetic database: ${String(SESSION_COUNT)} sessions, ${String(TOTAL_MESSAGES)} messages`);
    t.diagnostic(`loadStepRows 7d:   ${sevenDaySteps.ms.toFixed(1)} ms (${String(sevenDaySteps.rows)} steps)`);
    t.diagnostic(`loadStepRows all:  ${allSteps.ms.toFixed(1)} ms (${String(allSteps.rows)} steps)`);
    t.diagnostic(`loadToolRows 7d:   ${sevenDayTools.ms.toFixed(1)} ms (${String(sevenDayTools.rows)} tool calls)`);
    t.diagnostic(`loadToolRows all:  ${allTools.ms.toFixed(1)} ms (${String(allTools.rows)} tool calls)`);

    assert.equal(allSteps.rows, ASSISTANT_TOTAL, 'the all range loads every assistant step');
    assert.ok(allTools.rows > ASSISTANT_TOTAL * 0.9, 'nearly every step carries a tool call');
    assert.ok(allTools.rows < ASSISTANT_TOTAL, 'unreadable payloads contribute no tool calls');
    assert.ok(sevenDaySteps.rows > 0 && sevenDaySteps.rows < ASSISTANT_TOTAL, 'a finite range is a strict subset');

    // Generous sanity bounds: these catch accidental O(n²) or unbounded work,
    // not machine-to-machine differences. Observed on a laptop: ~6 ms (7d) and
    // ~180-200 ms (all) for this dataset.
    assert.ok(sevenDaySteps.ms < 1000, `7d step load too slow: ${sevenDaySteps.ms.toFixed(1)} ms`);
    assert.ok(sevenDayTools.ms < 1000, `7d tool load too slow: ${sevenDayTools.ms.toFixed(1)} ms`);
    assert.ok(allSteps.ms < 5000, `all step load too slow: ${allSteps.ms.toFixed(1)} ms`);
    assert.ok(allTools.ms < 5000, `all tool load too slow: ${allTools.ms.toFixed(1)} ms`);
  });
});
