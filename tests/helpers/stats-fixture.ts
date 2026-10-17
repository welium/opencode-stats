/**
 * Deterministic statistics scenario shared by the Phase 2 metric and API tests.
 *
 * Every timestamp is derived from a frozen clock (`TEST_NOW`) and UTC calendar
 * dates, and tests run with `TZ=UTC`, so expected values are hand-calculable.
 * The scenario is intentionally small but covers root/child/orphan sessions, an
 * old session active in range, a newly created idle session, unknown identities,
 * missing versus zero measurements, unreadable payloads, copied pre-fork
 * history, compaction rows, and unfinished/failed tools.
 *
 * Layout (range `7d` @ TEST_NOW = 2026-06-15T12:00:00Z covers 06-09T00:00:00Z
 * through 06-15T12:00:00Z):
 *
 *   proj-a  ("alpha")        ses-root-1 (root) A1, A2 + prompts
 *                            ses-sub-1  (child of ses-root-1) S1, S2
 *   proj-b  ("Beta Project") ses-root-2 (root) B1, R1, R2 (unreadable), R3
 *                            ses-fork   (fork of ses-root-2) F-pre (excluded), F-post
 *                            ses-new-idle (no messages)
 *   proj-c  ("gamma")        ses-user-only (one user message, no steps)
 *   (null)                   ses-old-root (created 2025, active in range) O1
 *   (missing session row)    ORPH message
 */

import { openFixtureDatabase, insertMessage, insertProject, insertSession } from './fixtures.ts';

import { assistantPayload, compactionPayload, toolItem, userPayload } from './fixtures.ts';

import type { DatabaseSync } from 'node:sqlite';

/** Frozen clock: 2026-06-15T12:00:00Z. */
export const TEST_NOW = Date.UTC(2026, 5, 15, 12, 0, 0);

/** A UTC instant in June 2026. */
export function utc(day: number, hour = 0): number {
  return Date.UTC(2026, 5, day, hour, 0, 0);
}

export const RANGE_FROM_ISO = new Date(Date.UTC(2026, 5, 9, 0, 0, 0)).toISOString();

export const MODEL_X = { id: 'model-x', providerID: 'prov-a', variant: 'high' };
export const MODEL_Y = { id: 'model-y', providerID: 'prov-b', variant: 'low' };
export const MODEL_Z = { id: 'model-z', providerID: 'prov-a', variant: 'medium' };
export const MODEL_W = { id: 'model-w', providerID: 'prov-c', variant: null };

export interface StatsFixtureOptions {
  journalMode?: 'wal' | 'delete';
}

export function createStatsFixture(path: string, options: StatsFixtureOptions = {}): void {
  const db = openFixtureDatabase(path, options.journalMode ?? 'delete');

  insertProject(db, 'proj-a', null, '/srv/work/alpha');
  insertProject(db, 'proj-b', 'Beta Project', '/srv/work/beta');
  insertProject(db, 'proj-c', null, '/srv/work/gamma');

  // --- proj-a: a complete-coverage project -------------------------------
  insertSession(db, {
    id: 'ses-root-1',
    projectId: 'proj-a',
    title: 'Root One',
    model: JSON.stringify(MODEL_X),
    timeCreated: utc(13, 10),
    timeUpdated: utc(14, 10),
  });
  insertSession(db, {
    id: 'ses-sub-1',
    projectId: 'proj-a',
    parentId: 'ses-root-1',
    title: 'Sub One',
    model: JSON.stringify(MODEL_Y),
    timeCreated: utc(10, 7),
    timeUpdated: utc(10, 11),
  });

  // A1 is the §4 example: input 600, output 200, reasoning 50, cache read 300,
  // cache write 100 -> 1,250 total tokens and a 30% cache rate.
  insertMessage(db, {
    id: 'msg-a1',
    sessionId: 'ses-root-1',
    type: 'assistant',
    seq: 1,
    timeCreated: utc(9, 9),
    data: assistantPayload({
      model: MODEL_X,
      agent: 'build',
      cost: 1.25,
      tokens: { input: 600, output: 200, reasoning: 50, cache: { read: 300, write: 100 } },
      content: [
        // state.time is deliberately divergent: only top-level `time` is read.
        toolItem({ name: 'read', time: { created: 1000, ran: 1100, completed: 1600 }, stateTime: { created: 0, ran: 0, completed: 999_999 } }),
        // No `ran`: duration falls back to `created`.
        toolItem({ name: 'write', time: { created: 2000, ran: null, completed: 2500 } }),
        toolItem({ name: 'bash', status: 'error', time: { created: 3000, ran: 3100, completed: 3200 } }),
      ],
    }),
  });
  // A2 is a measured all-zero step (explicit zeros, not missing data).
  insertMessage(db, {
    id: 'msg-a2',
    sessionId: 'ses-root-1',
    type: 'assistant',
    seq: 2,
    timeCreated: utc(9, 10),
    data: assistantPayload({
      model: MODEL_X,
      agent: 'build',
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      error: { type: 'provider.invalid-output' },
    }),
  });
  // Assistant-only scope: a separate compaction row must never be added (§4).
  insertMessage(db, {
    id: 'msg-compaction',
    sessionId: 'ses-root-1',
    type: 'compaction',
    seq: 3,
    timeCreated: utc(13, 13),
    data: compactionPayload({ time: utc(13, 13) }),
  });
  // Non-usage message types must be ignored too.
  insertMessage(db, {
    id: 'msg-synthetic',
    sessionId: 'ses-root-1',
    type: 'synthetic',
    seq: 4,
    timeCreated: utc(13, 14),
    data: { time: { created: utc(13, 14) }, text: 'synthetic', description: 'ignored' },
  });
  // Out-of-range step: excluded from `7d`, included by the all-activity mode.
  insertMessage(db, {
    id: 'msg-a0-past',
    sessionId: 'ses-root-1',
    type: 'assistant',
    seq: 0,
    timeCreated: Date.UTC(2026, 4, 1, 0, 0, 0),
    data: assistantPayload({
      model: MODEL_X,
      agent: 'build',
      cost: 0.1,
      tokens: { input: 1000, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    }),
  });

  insertMessage(db, { id: 'msg-p1', sessionId: 'ses-root-1', type: 'user', seq: 0, timeCreated: utc(9, 8), data: userPayload(utc(9, 8)) });
  insertMessage(db, { id: 'msg-p2', sessionId: 'ses-root-1', type: 'user', seq: 5, timeCreated: utc(14, 10), data: userPayload(utc(14, 10)) });

  // A subagent user message is not a prompt: the owning session is not a root session.
  insertMessage(db, { id: 'msg-sub-user', sessionId: 'ses-sub-1', type: 'user', seq: 0, timeCreated: utc(10, 8), data: userPayload(utc(10, 8)) });
  insertMessage(db, {
    id: 'msg-s1',
    sessionId: 'ses-sub-1',
    type: 'assistant',
    seq: 1,
    timeCreated: utc(10, 9),
    data: assistantPayload({
      model: MODEL_Y,
      agent: 'general',
      cost: 0.05,
      tokens: { input: 10, output: 5, reasoning: 0, cache: { read: 0, write: 0 } },
    }),
  });
  insertMessage(db, {
    id: 'msg-s2',
    sessionId: 'ses-sub-1',
    type: 'assistant',
    seq: 2,
    timeCreated: utc(10, 11),
    data: assistantPayload({
      model: MODEL_Y,
      agent: 'general',
      cost: 0.5,
      tokens: { input: 20, output: 10, reasoning: 0, cache: { read: 0, write: 0 } },
      content: [
        toolItem({ name: 'grep', time: { created: 100, ran: 100, completed: 400 } }),
        // Negative duration: counted as succeeded, excluded from duration stats.
        toolItem({ name: 'glob', time: { created: 500, ran: null, completed: 400 } }),
      ],
    }),
  });

  // --- proj-b: incomplete coverage, a fork, and an idle new session -------
  insertSession(db, {
    id: 'ses-root-2',
    projectId: 'proj-b',
    title: 'Root Two',
    model: JSON.stringify(MODEL_Z),
    timeCreated: utc(11, 8),
    timeUpdated: utc(11, 12),
  });
  insertSession(db, {
    id: 'ses-fork',
    projectId: 'proj-b',
    forkSessionId: 'ses-root-2',
    title: 'Fork',
    model: JSON.stringify(MODEL_X),
    timeCreated: utc(14, 0),
    timeUpdated: utc(14, 2),
  });
  insertSession(db, {
    id: 'ses-new-idle',
    projectId: 'proj-b',
    title: 'New Idle',
    model: JSON.stringify(MODEL_Z),
    timeCreated: utc(13, 0),
    timeUpdated: utc(13, 0),
  });

  // Exactly at the inclusive lower bound: included.
  insertMessage(db, {
    id: 'msg-boundary-from',
    sessionId: 'ses-root-2',
    type: 'assistant',
    seq: 0,
    timeCreated: utc(9, 0),
    data: assistantPayload({ model: MODEL_Z, agent: 'plan', cost: 0.001, tokens: { input: 1, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } }),
  });
  insertMessage(db, {
    id: 'msg-r1',
    sessionId: 'ses-root-2',
    type: 'assistant',
    seq: 1,
    timeCreated: utc(11, 9),
    data: assistantPayload({
      model: MODEL_Z,
      agent: 'plan',
      cost: 0.01,
      tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
      content: [
        toolItem({ name: 'task', time: { created: 5000, ran: 5000, completed: 5000 } }),
        toolItem({ name: 'edit', status: 'pending' }),
      ],
    }),
  });
  // Unreadable payload: counted, reported through coverage, never silently dropped.
  insertMessage(db, {
    id: 'msg-r2',
    sessionId: 'ses-root-2',
    type: 'assistant',
    seq: 2,
    timeCreated: utc(11, 10),
    data: 'not json at all',
  });
  // Tokens present, cost missing.
  insertMessage(db, {
    id: 'msg-r3',
    sessionId: 'ses-root-2',
    type: 'assistant',
    seq: 3,
    timeCreated: utc(11, 11),
    data: assistantPayload({ model: MODEL_Z, agent: 'plan', cost: null, tokens: { input: 100, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } }),
  });
  // Exactly at the exclusive upper bound: excluded.
  insertMessage(db, {
    id: 'msg-boundary-to',
    sessionId: 'ses-root-2',
    type: 'assistant',
    seq: 4,
    timeCreated: TEST_NOW,
    data: assistantPayload({ model: MODEL_Z, agent: 'plan', cost: 999, tokens: { input: 1_000_000, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } }),
  });
  insertMessage(db, { id: 'msg-f-pre', sessionId: 'ses-fork', type: 'assistant', seq: 1, timeCreated: utc(13, 23), data: assistantPayload({ model: MODEL_X, cost: 50, tokens: { input: 9999, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } }) });
  insertMessage(db, {
    id: 'msg-f-post',
    sessionId: 'ses-fork',
    type: 'assistant',
    seq: 2,
    timeCreated: utc(14, 1),
    data: assistantPayload({
      model: MODEL_X,
      agent: 'build',
      cost: 0.11,
      tokens: { input: 11, output: 22, reasoning: 0, cache: { read: 0, write: 0 } },
      content: [toolItem({ name: 'webfetch', time: { created: 0, ran: 0, completed: 200 } })],
    }),
  });
  insertMessage(db, { id: 'msg-f-prompt', sessionId: 'ses-fork', type: 'user', seq: 3, timeCreated: utc(14, 2), data: userPayload(utc(14, 2)) });

  // --- proj-c: a session with prompts but no steps ------------------------
  insertSession(db, { id: 'ses-user-only', projectId: 'proj-c', title: 'User Only', model: null, timeCreated: utc(13, 5), timeUpdated: utc(13, 6) });
  insertMessage(db, { id: 'msg-user-only', sessionId: 'ses-user-only', type: 'user', seq: 0, timeCreated: utc(13, 6), data: userPayload(utc(13, 6)) });

  // --- no project: an old session that is active in range -----------------
  insertSession(db, { id: 'ses-old-root', projectId: null, title: 'Old Root', model: JSON.stringify(MODEL_W), timeCreated: Date.UTC(2025, 0, 1), timeUpdated: utc(12, 9) });
  insertMessage(db, { id: 'msg-o-prompt', sessionId: 'ses-old-root', type: 'user', seq: 0, timeCreated: utc(12, 8), data: userPayload(utc(12, 8)) });
  insertMessage(db, {
    id: 'msg-o1',
    sessionId: 'ses-old-root',
    type: 'assistant',
    seq: 1,
    timeCreated: utc(12, 9),
    // No `agent`: an unknown agent group, kept rather than dropped.
    data: assistantPayload({ model: MODEL_W, agent: null, cost: 0.07, tokens: { input: 7, output: 3, reasoning: 0, cache: { read: 0, write: 0 } } }),
  });

  // --- orphan message: usage retained, session identity unknown -----------
  insertMessage(db, {
    id: 'msg-orphan',
    sessionId: 'ses-missing',
    type: 'assistant',
    seq: 0,
    timeCreated: utc(13, 12),
    data: assistantPayload({ model: MODEL_X, agent: 'build', cost: 0.02, tokens: { input: 5, output: 5, reasoning: 0, cache: { read: 0, write: 0 } } }),
  });

  db.close();
}

/**
 * Append a complete new root session — a prompt plus an assistant step — that is
 * only visible to transactions started after this commit. The concurrency test
 * uses it to prove a multi-query read transaction keeps one snapshot: a leaked
 * commit would make prompts/sessions disagree with the step and daily totals.
 */
export function appendConcurrentSession(db: DatabaseSync, id: string): void {
  insertSession(db, {
    id,
    projectId: 'proj-a',
    title: 'Concurrent',
    model: JSON.stringify(MODEL_Y),
    timeCreated: utc(13, 40),
    timeUpdated: utc(13, 41),
  });
  insertMessage(db, {
    id: `${id}-prompt`,
    sessionId: id,
    type: 'user',
    seq: 0,
    timeCreated: utc(13, 40),
    data: userPayload(utc(13, 40)),
  });
  insertMessage(db, {
    id: `${id}-step`,
    sessionId: id,
    type: 'assistant',
    seq: 1,
    timeCreated: utc(13, 41),
    data: assistantPayload({
      model: MODEL_Y,
      agent: 'general',
      cost: 0.2,
      tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
    }),
  });
}
