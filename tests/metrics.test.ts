/**
 * Phase 2 gate: metric queries and aggregation rules.
 *
 * Plan references: §4 "Canonical dashboard metrics" and §8 required check 1 and
 * 3. Every expected value is hand-calculated from the synthetic scenario in
 * `helpers/stats-fixture.ts` (TZ=UTC, frozen clock 2026-06-15T12:00:00Z); none
 * is derived from the production aggregation.
 */

process.env.TZ = 'UTC';

import assert from 'node:assert/strict';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, before, describe, it } from 'node:test';

import {
  addStep,
  addStepToDaily,
  addPromptToDaily,
  addTool,
  buildDaily,
  classifyToolStatus,
  createDailyMap,
  createQueryRunner,
  createToolAccumulator,
  createUsageAccumulator,
  earliestDate,
  finishToolTotals,
  finishUsage,
  groupSteps,
  loadActiveSessions,
  loadChildSessions,
  loadProjectCatalog,
  loadPromptRows,
  loadSessionMetadata,
  loadStepRows,
  loadToolRows,
  median,
  nearestRank,
  projectLabel,
  sessionLabel,
  summarizeActivity,
  summarizeCohort,
  toolDurationMs,
  usageCoverage,
} from '../src/server/metrics.ts';

import type { MetricScope, QueryRunner, StepRow, ToolRow } from '../src/server/metrics.ts';
import type { SessionCohort, UsageTotals } from '../src/shared/api.ts';

import { createTempDir, removeTempDir } from './helpers/fixtures.ts';
import { MODEL_X, TEST_NOW, createStatsFixture, utc } from './helpers/stats-fixture.ts';

let dir: string;
let db: DatabaseSync;
let runner: QueryRunner;

before(() => {
  dir = createTempDir('opencode-stats-metrics-');
  const path = join(dir, 'fixture.db');
  createStatsFixture(path);
  db = new DatabaseSync(path, { readOnly: true });
  runner = createQueryRunner(db);
});

after(() => {
  db.close();
  removeTempDir(dir);
});

/** 7d @ 2026-06-15T12:00Z covers 2026-06-09T00:00Z through the clock. */
function scope(overrides: Partial<MetricScope> = {}): MetricScope {
  return { from: Date.UTC(2026, 5, 9, 0, 0, 0), to: TEST_NOW, projectId: null, sessionId: null, ...overrides };
}

function usageOfRows(rows: readonly StepRow[]): UsageTotals {
  const accumulator = createUsageAccumulator();
  for (const row of rows) addStep(accumulator, row);
  return finishUsage(accumulator);
}

const idsOf = (rows: readonly { id: string }[]): string[] => rows.map((row) => row.id);

describe('loadStepRows', () => {
  it('selects only in-range assistant steps, in timestamp order', () => {
    const rows = loadStepRows(runner, scope());
    assert.deepEqual(idsOf(rows), [
      'msg-boundary-from',
      'msg-a1',
      'msg-a2',
      'msg-s1',
      'msg-s2',
      'msg-r1',
      'msg-r2',
      'msg-r3',
      'msg-o1',
      'msg-orphan',
      'msg-f-post',
    ]);

    // Compaction/synthetic/user rows and out-of-range or pre-fork steps never appear.
    for (const excluded of ['msg-compaction', 'msg-synthetic', 'msg-a0-past', 'msg-boundary-to', 'msg-f-pre', 'msg-p1']) {
      assert.ok(!idsOf(rows).includes(excluded), `${excluded} must not be an assistant step`);
    }
  });

  it('respects the session filter and the all-activity lower bound', () => {
    const rootOne = loadStepRows(runner, scope({ sessionId: 'ses-root-1' }));
    assert.deepEqual(idsOf(rootOne), ['msg-a1', 'msg-a2']);

    const all = loadStepRows(runner, scope({ from: null, sessionId: 'ses-root-1' }));
    assert.deepEqual(idsOf(all), ['msg-a0-past', 'msg-a1', 'msg-a2']);
  });

  it('excludes copied pre-fork history but keeps post-fork steps', () => {
    const fork = loadStepRows(runner, scope({ projectId: 'proj-b', from: null }));
    assert.ok(idsOf(fork).includes('msg-f-post'));
    assert.ok(!idsOf(fork).includes('msg-f-pre'), 'a pre-fork copy must not be billed again');
  });

  it('keeps an orphan message in an explicit unknown session group', () => {
    const orphan = loadStepRows(runner, scope()).find((row) => row.id === 'msg-orphan');
    assert.ok(orphan !== undefined);
    assert.equal(orphan.sessionId, null, 'a message without an owning session has no invented identity');
    assert.equal(orphan.projectId, null);
    assert.equal(orphan.input, 5);
  });

  it('distinguishes an unreadable payload from missing cost fields', () => {
    const rows = loadStepRows(runner, scope());
    const unreadable = rows.find((row) => row.id === 'msg-r2');
    assert.ok(unreadable !== undefined);
    assert.equal(unreadable.unreadable, true);
    assert.equal(unreadable.input, null);
    assert.equal(unreadable.cost, null);
    assert.equal(unreadable.model, null);

    const missingCost = rows.find((row) => row.id === 'msg-r3');
    assert.ok(missingCost !== undefined);
    assert.equal(missingCost.unreadable, false);
    assert.equal(missingCost.cost, null);
    assert.equal(missingCost.input, 100);
    assert.equal(missingCost.model, 'model-z');
  });
});

describe('loadPromptRows', () => {
  it('counts only user messages whose owning session is a root session', () => {
    const prompts = loadPromptRows(runner, scope());
    assert.equal(prompts.length, 6, 'every in-range user message is loaded');
    const rootPrompts = prompts.filter((prompt) => prompt.isRootPrompt);
    assert.deepEqual(idsOf(rootPrompts), ['msg-p1', 'msg-o-prompt', 'msg-user-only', 'msg-f-prompt', 'msg-p2']);

    const sub = prompts.find((prompt) => prompt.id === 'msg-sub-user');
    assert.ok(sub !== undefined);
    assert.equal(sub.isRootPrompt, false, 'a subagent user message is not a prompt');
  });
});

describe('loadActiveSessions', () => {
  it('uses activity in range, not session creation time', () => {
    const sessions = loadActiveSessions(runner, scope());
    assert.deepEqual(idsOf(sessions).sort(), ['ses-fork', 'ses-old-root', 'ses-root-1', 'ses-root-2', 'ses-sub-1', 'ses-user-only']);
    assert.ok(!idsOf(sessions).includes('ses-new-idle'), 'a session with no messages is not active');
    assert.ok(idsOf(sessions).includes('ses-old-root'), 'an older session with new activity is active');
    assert.ok(idsOf(sessions).includes('ses-user-only'), 'a session with only a prompt is active');
  });

  it('splits the cohort by parent_id', () => {
    const cohort = summarizeCohort(loadActiveSessions(runner, scope()));
    const expected: SessionCohort = { total: 6, root: 5, subagent: 1 };
    assert.deepEqual(cohort, expected);
  });

  it('applies the project filter through the owning session', () => {
    const projectA = loadActiveSessions(runner, scope({ projectId: 'proj-a' }));
    assert.deepEqual(idsOf(projectA).sort(), ['ses-root-1', 'ses-sub-1']);
  });
});

describe('loadToolRows', () => {
  it('reads top-level content item time and classifies outcomes', () => {
    const tools = loadToolRows(runner, scope());
    assert.equal(tools.length, 8);

    const byName = new Map<string, ToolRow>();
    for (const tool of tools) byName.set(tool.name as string, tool);
    assert.deepEqual([...byName.keys()].sort(), ['bash', 'edit', 'glob', 'grep', 'read', 'task', 'webfetch', 'write']);

    assert.equal(classifyToolStatus(byName.get('read')?.status ?? null), 'succeeded');
    assert.equal(classifyToolStatus(byName.get('bash')?.status ?? null), 'failed');
    assert.equal(classifyToolStatus(byName.get('edit')?.status ?? null), 'unfinished');
    assert.equal(classifyToolStatus(null), 'unfinished', 'a missing status is unfinished, not a failure');

    // `state.time` was set to divergent values; only the top-level time is read.
    const read = byName.get('read');
    assert.ok(read !== undefined);
    assert.equal(read.created, 1000);
    assert.equal(read.ran, 1100);
    assert.equal(read.completed, 1600);
    assert.equal(toolDurationMs(read), 500);
  });

  it('falls back from a missing ran to created and rejects invalid durations', () => {
    const tools = loadToolRows(runner, scope());
    const byName = new Map(tools.map((tool) => [tool.name as string, tool]));

    const write = byName.get('write');
    assert.ok(write !== undefined);
    assert.equal(write.ran, null);
    assert.equal(toolDurationMs(write), 500, 'duration falls back to created when ran is absent');

    const glob = byName.get('glob');
    assert.ok(glob !== undefined);
    assert.equal(classifyToolStatus(glob.status), 'succeeded');
    assert.equal(toolDurationMs(glob), null, 'a negative duration is unmeasurable, not zero');

    const edit = byName.get('edit');
    assert.ok(edit !== undefined);
    assert.equal(toolDurationMs(edit), null, 'an unfinished call has no duration');
  });

  it('aggregates calls, failure rate, and duration percentiles', () => {
    const totals = createToolAccumulator();
    for (const tool of loadToolRows(runner, scope())) addTool(totals, tool);
    const finished = finishToolTotals(totals);

    assert.equal(finished.calls, 8);
    assert.equal(finished.succeeded, 6);
    assert.equal(finished.failed, 1);
    assert.equal(finished.unfinished, 1);
    assert.equal(finished.failureRate, 1 / 7);
    // Valid durations: read 500, write 500, bash 100, grep 300, task 0, webfetch 200.
    assert.deepEqual(finished.duration, { count: 6, p50: 250, p95: 500 });
  });

  it('reports unavailable outcomes for an empty selection', () => {
    const finished = finishToolTotals(createToolAccumulator());
    assert.deepEqual(finished, { calls: 0, succeeded: 0, failed: 0, unfinished: 0, failureRate: null, duration: null });
  });
});

describe('assistant usage accumulation', () => {
  it('sums the 1,250-token / 30% example, including cache writes', () => {
    const rows = loadStepRows(runner, scope({ sessionId: 'ses-root-1' }));
    const usage = usageOfRows(rows.filter((row) => row.id === 'msg-a1'));

    assert.deepEqual(usage.tokens.input, { value: 600, complete: true, measured: 1, counted: 1 });
    assert.equal(usage.tokens.output.value, 200);
    assert.equal(usage.tokens.reasoning.value, 50);
    assert.equal(usage.tokens.cacheRead.value, 300);
    assert.equal(usage.tokens.cacheWrite.value, 100);
    assert.equal(usage.tokens.total, 1250, 'total is the five non-overlapping categories');
    assert.equal(usage.cacheRate, 0.3, 'cache writes belong in the denominator');

    // A denominator without cache writes would be 33.33%, which the plan rejects.
    assert.notEqual(usage.cacheRate, 300 / 900);
  });

  it('aggregates the whole range as a partial measurement, never an invented total', () => {
    const rows = loadStepRows(runner, scope());
    const accumulator = createUsageAccumulator();
    for (const row of rows) addStep(accumulator, row);
    const usage = finishUsage(accumulator);

    assert.equal(usage.steps, 11);
    assert.deepEqual(usage.tokens.input, { value: 755, complete: false, measured: 10, counted: 11 });
    assert.equal(usage.tokens.output.value, 246);
    assert.equal(usage.tokens.reasoning.value, 50);
    assert.equal(usage.tokens.cacheRead.value, 300);
    assert.equal(usage.tokens.cacheWrite.value, 100);
    assert.equal(usage.tokens.total, null, 'one unreadable step makes the combined total unavailable');
    assert.equal(usage.cacheRate, null, 'an incomplete denominator cannot produce a rate');
    assert.deepEqual(usage.cost, { value: 2.011, complete: false, measured: 9, counted: 11 });
    assert.ok(Math.abs((usage.cost.value ?? 0) - 2.011) < 1e-12);

    assert.deepEqual(usageCoverage(accumulator, usage), {
      steps: 11,
      unreadableSteps: 1,
      costComplete: false,
      tokensComplete: false,
    });
  });

  it('never double-counts child usage into its parent session', () => {
    const groups = groupSteps(loadStepRows(runner, scope()), (row) => row.sessionId);
    const root = usageOfRows(groups.get('ses-root-1') ?? []);
    const child = usageOfRows(groups.get('ses-sub-1') ?? []);

    assert.equal(root.tokens.total, 1250, 'the parent totals only its own steps');
    assert.equal(child.tokens.total, 45);
    assert.equal(root.steps, 2);
    assert.equal(child.steps, 2);
  });

  it('keeps a measured zero distinct from a missing measurement', () => {
    const rows = loadStepRows(runner, scope());
    const zero = usageOfRows(rows.filter((row) => row.id === 'msg-a2'));
    assert.deepEqual(zero.tokens.input, { value: 0, complete: true, measured: 1, counted: 1 });
    assert.equal(zero.tokens.total, 0);
    assert.equal(zero.cacheRate, null, 'a zero denominator is unavailable, not zero percent');

    const missing = usageOfRows(rows.filter((row) => row.id === 'msg-r2'));
    assert.deepEqual(missing.tokens.input, { value: null, complete: false, measured: 0, counted: 1 });
    assert.equal(missing.tokens.total, null);
    assert.deepEqual(missing.cost, { value: null, complete: false, measured: 0, counted: 1 });

    const empty = usageOfRows([]);
    assert.deepEqual(empty.tokens.input, { value: 0, complete: true, measured: 0, counted: 0 });
    assert.equal(empty.tokens.total, 0);
    assert.equal(empty.steps, 0);
  });
});

describe('duration statistics', () => {
  it('averages the two middle values for an even sample', () => {
    assert.equal(median([3, 1, 2]), 2);
    assert.equal(median([1, 2, 3, 4]), 2.5);
    assert.equal(median([0, 100, 200, 300, 500, 500]), 250);
    assert.throws(() => median([]));
  });

  it('uses the nearest rank boundary for p95', () => {
    assert.equal(nearestRank([0, 100, 200, 300, 500, 500], 0.95), 500);
    assert.equal(nearestRank([7], 0.95), 7);
    assert.equal(nearestRank([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20], 0.95), 19);
    assert.throws(() => nearestRank([], 0.95));
  });
});

describe('daily series and activity', () => {
  it('zero-fills empty dates and reports unmeasured days as unavailable', () => {
    const rows = loadStepRows(runner, scope());
    const daily = createDailyMap();
    for (const row of rows) {
      const date = new Date(row.timeCreated).toISOString().slice(0, 10);
      addStepToDaily(daily, date, row, [
        row.input,
        row.output,
        row.reasoning,
        row.cacheRead,
        row.cacheWrite,
      ].filter((value): value is number => value !== null));
    }
    addPromptToDaily(daily, '2026-06-09');
    addPromptToDaily(daily, '2026-06-12');

    const series = buildDaily(daily, ['2026-06-08', '2026-06-09', '2026-06-11', '2026-06-15']);

    assert.deepEqual(series[0], { date: '2026-06-08', steps: 0, prompts: 0, tokens: 0, cost: 0 }, 'a missing date is a measured zero');
    assert.deepEqual(series[1], { date: '2026-06-09', steps: 3, prompts: 1, tokens: 1251, cost: 1.251 }, 'inclusive lower bound');
    // The unreadable step leaves required coverage incomplete for this date.
    assert.deepEqual(series[2], { date: '2026-06-11', steps: 3, prompts: 0, tokens: null, cost: null });
    assert.deepEqual(series[3], { date: '2026-06-15', steps: 0, prompts: 0, tokens: 0, cost: 0 });
  });

  it('reports a date with steps but no measured value as null', () => {
    const daily = createDailyMap();
    const unreadable: StepRow = {
      id: 'x',
      sessionId: null,
      seq: 0,
      timeCreated: utc(11, 10),
      projectId: null,
      unreadable: true,
      cost: null,
      input: null,
      output: null,
      reasoning: null,
      cacheRead: null,
      cacheWrite: null,
      provider: null,
      model: null,
      agent: null,
      hasError: false,
    };
    addStepToDaily(daily, '2026-06-11', unreadable, []);

    assert.deepEqual(buildDaily(daily, ['2026-06-11']), [
      { date: '2026-06-11', steps: 1, prompts: 0, tokens: null, cost: null },
    ]);
  });

  it('measures the longest consecutive run inside the range', () => {
    const dates = ['2026-06-09', '2026-06-10', '2026-06-11', '2026-06-12', '2026-06-13', '2026-06-14', '2026-06-15'];
    const active = new Set(['2026-06-09', '2026-06-10', '2026-06-11', '2026-06-12', '2026-06-13', '2026-06-14']);
    assert.deepEqual(summarizeActivity(dates, active), { activeDays: 6, longestStreak: 6 });

    assert.deepEqual(summarizeActivity(dates, new Set(['2026-06-09', '2026-06-11', '2026-06-15'])), {
      activeDays: 3,
      longestStreak: 1,
    });
    assert.deepEqual(summarizeActivity([], new Set(['2026-06-09'])), { activeDays: 0, longestStreak: 0 });
  });

  it('finds the earliest observed date, ignoring the clock order', () => {
    assert.equal(earliestDate(['2026-06-13', '2026-06-09', '2026-06-15']), '2026-06-09');
    assert.equal(earliestDate([]), null);
  });
});

describe('labels and catalog', () => {
  it('prefers a project name, then the worktree basename, then the ID', () => {
    assert.equal(projectLabel(null, undefined), 'Unknown project');
    assert.equal(projectLabel('proj-x', undefined), 'proj-x');
    assert.equal(projectLabel('proj-x', { id: 'proj-x', name: '  ', worktree: '/srv/work/gamma/' }), 'gamma');
    assert.equal(projectLabel('proj-x', { id: 'proj-x', name: 'Beta Project', worktree: '/srv/work/beta' }), 'Beta Project');
    assert.equal(projectLabel('proj-x', { id: 'proj-x', name: null, worktree: null }), 'proj-x');
  });

  it('uses a session title or a short identifier', () => {
    assert.equal(sessionLabel('ses-root-1', 'Root One'), 'Root One');
    assert.equal(sessionLabel('abcdefghijklmnop', null), 'abcdefghijkl');
    assert.equal(sessionLabel('short', '   '), 'short');
  });

  it('loads the project catalog', () => {
    const catalog = loadProjectCatalog(runner);
    assert.equal(catalog.get('proj-a')?.name, null);
    assert.equal(catalog.get('proj-a')?.worktree, '/srv/work/alpha');
    assert.equal(catalog.get('proj-b')?.name, 'Beta Project');
  });

  it('loads session metadata and children independently of the range', () => {
    const session = loadSessionMetadata(runner, 'ses-root-1');
    assert.ok(session !== null);
    assert.equal(session.title, 'Root One');
    assert.equal(session.projectId, 'proj-a');
    assert.equal(session.parentId, null);
    assert.equal(session.model, JSON.stringify(MODEL_X), 'the stored model string is metadata only');
    assert.equal(session.timeCreated, utc(13, 10));
    assert.equal(loadSessionMetadata(runner, 'ses-nope'), null);

    assert.deepEqual(loadChildSessions(runner, 'ses-root-1'), [
      { id: 'ses-sub-1', title: 'Sub One', timeCreated: utc(10, 7), steps: 2 },
    ]);
    assert.deepEqual(loadChildSessions(runner, 'ses-root-2'), [], 'a fork is not a child session');
  });
});
