/**
 * Metric queries and aggregation.
 *
 * Plan references: §4 "Storage adapter and metric rules" and §5. All schema and
 * JSON-payload knowledge for statistics lives in this module: callers hand in a
 * scope and receive typed rows or finished metric values, never raw payloads.
 *
 * Implemented rules:
 *  - eligible-message rule: a message belongs to its owning session and, when
 *    that session has a fork source, was created at/after the session's own
 *    `time_created`. Copied pre-fork history is never billed again.
 *  - orphan messages (no owning session) stay in an explicitly unknown group
 *    instead of being dropped or invented into a root session.
 *  - tool timestamps come from the content item's top-level `time`, never from
 *    `state`.
 *  - p50 is the arithmetic median (averaging the two middle values for an even
 *    sample); p95 uses nearest rank `ceil(0.95 × n) − 1`.
 *  - coverage is tracked so missing cost/token data is unavailable rather than
 *    an invented zero.
 */

import { basename } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

import type {
  ActivitySummary,
  AgentUsageRow,
  DailyActivityPoint,
  MeasuredTotal,
  SessionCohort,
  TokenTotals,
  ToolOutcome,
  ToolOutcomeTotals,
  UsageCoverage,
  UsageTotals,
} from '../shared/api.ts';

// ---------------------------------------------------------------------------
// Query runner
// ---------------------------------------------------------------------------

export type SqlValue = null | number | bigint | string | Uint8Array;

/**
 * Narrow read-only query surface. Keeping metrics on this interface makes the
 * "one transaction per response" seam explicit: production passes a runner over
 * the request's read connection, and tests can interpose their own runner.
 */
export interface QueryRunner {
  all<T>(sql: string, params?: readonly SqlValue[]): T[];
  get<T>(sql: string, params?: readonly SqlValue[]): T | undefined;
}

export function createQueryRunner(db: DatabaseSync): QueryRunner {
  return {
    all<T>(sql: string, params: readonly SqlValue[] = []): T[] {
      // Every value is bound; no request data is ever interpolated into SQL.
      return db.prepare(sql).all(...params) as T[];
    },
    get<T>(sql: string, params: readonly SqlValue[] = []): T | undefined {
      return db.prepare(sql).get(...params) as T | undefined;
    },
  };
}

// ---------------------------------------------------------------------------
// Scope
// ---------------------------------------------------------------------------

/** Time and identity filters shared by every metric query. */
export interface MetricScope {
  /** Inclusive lower bound; null for `all`. */
  from: number | null;
  /** Exclusive upper bound. */
  to: number;
  /** Restrict to one project through the owning session. */
  projectId: string | null;
  /** Restrict to one owning session (session detail). */
  sessionId: string | null;
}

/**
 * Copied-fork exclusion (§4). `s` is the owning session; orphan messages have no
 * session row and stay eligible so their usage lands in an unknown group.
 */
const ELIGIBLE_MESSAGE = '(s.id IS NULL OR s.fork_session_id IS NULL OR m.time_created >= s.time_created)';

/** Range and identity predicates for a message-level query. */
function messageFilter(scope: MetricScope): { sql: string; params: SqlValue[] } {
  const parts: string[] = [];
  const params: SqlValue[] = [];
  if (scope.from !== null) {
    parts.push('m.time_created >= ?');
    params.push(scope.from);
  }
  parts.push('m.time_created < ?');
  params.push(scope.to);
  if (scope.projectId !== null) {
    parts.push('s.project_id = ?');
    params.push(scope.projectId);
  }
  if (scope.sessionId !== null) {
    parts.push('m.session_id = ?');
    params.push(scope.sessionId);
  }
  return { sql: parts.join(' AND '), params };
}

// ---------------------------------------------------------------------------
// Value coercion
// ---------------------------------------------------------------------------

function finiteNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'bigint') return Number(value);
  return null;
}

function nonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  return value === '' ? null : value;
}

// ---------------------------------------------------------------------------
// Assistant step rows
// ---------------------------------------------------------------------------

/** One assistant message row with only the fields metric rules need. */
export interface StepRow {
  id: string;
  /** Owning session ID; null when the message has no session row (unknown group). */
  sessionId: string | null;
  seq: number | null;
  timeCreated: number;
  projectId: string | null;
  /** True when the payload column was NULL or not well-formed JSON. */
  unreadable: boolean;
  cost: number | null;
  input: number | null;
  output: number | null;
  reasoning: number | null;
  cacheRead: number | null;
  cacheWrite: number | null;
  provider: string | null;
  model: string | null;
  agent: string | null;
  hasError: boolean;
  errorType?: string;
}

interface RawStepRow {
  id: unknown;
  session_id: unknown;
  seq: unknown;
  time_created: unknown;
  project_id: unknown;
  has_session: unknown;
  unreadable: unknown;
  cost: unknown;
  input: unknown;
  output: unknown;
  reasoning: unknown;
  cache_read: unknown;
  cache_write: unknown;
  provider: unknown;
  model: unknown;
  agent: unknown;
  has_error: unknown;
  error_type: unknown;
}

export function buildStepRowsQuery(scope: MetricScope): { sql: string; params: SqlValue[] } {
  const filter = messageFilter(scope);
  return {
    sql: `
WITH steps AS (
  SELECT m.id AS id,
         m.session_id AS session_id,
         m.seq AS seq,
         m.time_created AS time_created,
         CASE WHEN json_valid(m.data) THEN m.data END AS payload,
         s.id AS owning_session_id,
         s.project_id AS project_id
    FROM session_message m
    LEFT JOIN session_v2 s ON s.id = m.session_id
   WHERE m.type = 'assistant'
     AND ${ELIGIBLE_MESSAGE}
     AND ${filter.sql}
)
SELECT id,
       session_id,
       seq,
       time_created,
       project_id,
       (owning_session_id IS NOT NULL) AS has_session,
       (payload IS NULL) AS unreadable,
       CASE WHEN json_type(payload, '$.cost') IN ('integer', 'real') THEN json_extract(payload, '$.cost') END AS cost,
       CASE WHEN json_type(payload, '$.tokens.input') IN ('integer', 'real') THEN json_extract(payload, '$.tokens.input') END AS input,
       CASE WHEN json_type(payload, '$.tokens.output') IN ('integer', 'real') THEN json_extract(payload, '$.tokens.output') END AS output,
       CASE WHEN json_type(payload, '$.tokens.reasoning') IN ('integer', 'real') THEN json_extract(payload, '$.tokens.reasoning') END AS reasoning,
       CASE WHEN json_type(payload, '$.tokens.cache.read') IN ('integer', 'real') THEN json_extract(payload, '$.tokens.cache.read') END AS cache_read,
       CASE WHEN json_type(payload, '$.tokens.cache.write') IN ('integer', 'real') THEN json_extract(payload, '$.tokens.cache.write') END AS cache_write,
       json_extract(payload, '$.model.providerID') AS provider,
       json_extract(payload, '$.model.id') AS model,
       json_extract(payload, '$.agent') AS agent,
       (json_extract(payload, '$.error') IS NOT NULL) AS has_error,
       json_extract(payload, '$.error.name') AS error_type
  FROM steps
 ORDER BY time_created, id`,
    params: filter.params,
  };
}

export function loadStepRows(runner: QueryRunner, scope: MetricScope): StepRow[] {
  const { sql, params } = buildStepRowsQuery(scope);
  const rows = runner.all<RawStepRow>(sql, params);
  return rows.map((row) => {
    // The owning session is only known when the join found a session row; an
    // orphan message keeps its usage in an explicit unknown-session group.
    const hasSession = row.has_session === 1 || row.has_session === true;
    return {
      id: String(row.id),
      sessionId: !hasSession || row.session_id === null ? null : String(row.session_id),
      seq: finiteNumber(row.seq),
      timeCreated: finiteNumber(row.time_created) ?? 0,
      projectId: row.project_id === null ? null : String(row.project_id),
      unreadable: row.unreadable === 1 || row.unreadable === true,
      cost: measurement(row.cost),
      input: measurement(row.input),
      output: measurement(row.output),
      reasoning: measurement(row.reasoning),
      cacheRead: measurement(row.cache_read),
      cacheWrite: measurement(row.cache_write),
      provider: nonEmptyString(row.provider),
      model: nonEmptyString(row.model),
      agent: nonEmptyString(row.agent),
      hasError: row.has_error === 1 || row.has_error === true,
      errorType: safeErrorType(row.error_type),
    };
  });
}

function measurement(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

// Recognized schema tags only; arbitrary strings may contain secrets or prose.
function safeErrorType(value: unknown): string {
  const types = ['ProviderAuthError', 'UnknownError', 'MessageOutputLengthError', 'MessageAbortedError', 'APIError', 'ContextOverflowError', 'StructuredOutputError'];
  return typeof value === 'string' && types.includes(value) ? value : 'UnknownError';
}

// ---------------------------------------------------------------------------
// User (prompt) rows
// ---------------------------------------------------------------------------

export interface PromptRow {
  id: string;
  sessionId: string | null;
  timeCreated: number;
  projectId: string | null;
  /** True only for a prompt whose owning session is a root session. */
  isRootPrompt: boolean;
}

export function loadPromptRows(runner: QueryRunner, scope: MetricScope): PromptRow[] {
  const filter = messageFilter(scope);
  const rows = runner.all<{
    id: unknown;
    session_id: unknown;
    time_created: unknown;
    project_id: unknown;
    is_root_prompt: unknown;
  }>(
    `
WITH prompts AS (
  SELECT m.id AS id,
         m.session_id AS session_id,
         m.time_created AS time_created,
         s.id AS owning_session_id,
         s.parent_id AS parent_id,
         s.project_id AS project_id
    FROM session_message m
    LEFT JOIN session_v2 s ON s.id = m.session_id
   WHERE m.type = 'user'
     AND ${ELIGIBLE_MESSAGE}
     AND ${filter.sql}
)
SELECT id, session_id, time_created, project_id,
       (owning_session_id IS NOT NULL AND parent_id IS NULL) AS is_root_prompt
  FROM prompts
 ORDER BY time_created, id`,
    filter.params,
  );

  return rows.map((row) => ({
    id: String(row.id),
    sessionId: row.session_id === null ? null : String(row.session_id),
    timeCreated: finiteNumber(row.time_created) ?? 0,
    projectId: row.project_id === null ? null : String(row.project_id),
    isRootPrompt: row.is_root_prompt === 1 || row.is_root_prompt === true,
  }));
}

// ---------------------------------------------------------------------------
// Active session cohort
// ---------------------------------------------------------------------------

export interface ActiveSessionRow {
  id: string;
  title: string | null;
  projectId: string | null;
  parentId: string | null;
  timeCreated: number;
  timeUpdated: number;
}

/**
 * Sessions with at least one eligible user or assistant message in range.
 *
 * Activity — not `session.time_created` — defines the cohort, so an older
 * session with new activity counts and a newly created session without messages
 * does not (§4).
 */
export function loadActiveSessions(runner: QueryRunner, scope: MetricScope): ActiveSessionRow[] {
  const existenceParts: string[] = [];
  const params: SqlValue[] = [];
  if (scope.from !== null) {
    existenceParts.push('m.time_created >= ?');
    params.push(scope.from);
  }
  existenceParts.push('m.time_created < ?');
  params.push(scope.to);
  existenceParts.push("m.type IN ('user', 'assistant')");
  existenceParts.push('(s.fork_session_id IS NULL OR m.time_created >= s.time_created)');
  if (scope.sessionId !== null) {
    existenceParts.push('s.id = ?');
    params.push(scope.sessionId);
  }
  const existence = existenceParts.join(' AND ');

  const projectParts: string[] = [];
  if (scope.projectId !== null) {
    projectParts.push('s.project_id = ?');
    params.push(scope.projectId);
  }

  const rows = runner.all<{
    id: unknown;
    title: unknown;
    project_id: unknown;
    parent_id: unknown;
    time_created: unknown;
    time_updated: unknown;
  }>(
    `
SELECT s.id AS id,
       s.title AS title,
       s.project_id AS project_id,
       s.parent_id AS parent_id,
       s.time_created AS time_created,
       s.time_updated AS time_updated
  FROM session_v2 s
 WHERE EXISTS (
   SELECT 1 FROM session_message m
    WHERE m.session_id = s.id
      AND ${existence}
 )
 ${projectParts.length > 0 ? `AND ${projectParts.join(' AND ')}` : ''}
 ORDER BY s.time_updated, s.id`,
    params,
  );

  return rows.map((row) => ({
    id: String(row.id),
    title: nonEmptyString(row.title),
    projectId: row.project_id === null ? null : String(row.project_id),
    parentId: row.parent_id === null ? null : String(row.parent_id),
    timeCreated: finiteNumber(row.time_created) ?? 0,
    timeUpdated: finiteNumber(row.time_updated) ?? 0,
  }));
}

/** Distinct owning sessions split by `parent_id` (§4). */
export function summarizeCohort(sessions: readonly ActiveSessionRow[]): SessionCohort {
  let root = 0;
  for (const session of sessions) {
    if (session.parentId === null) root += 1;
  }
  return { total: sessions.length, root, subagent: sessions.length - root };
}

// ---------------------------------------------------------------------------
// Tool rows
// ---------------------------------------------------------------------------

export interface ToolRow {
  messageId: string;
  sessionId: string | null;
  projectId: string | null;
  name: string | null;
  status: string | null;
  created: number | null;
  ran: number | null;
  completed: number | null;
}

export function buildToolRowsQuery(scope: MetricScope): { sql: string; params: SqlValue[] } {
  const filter = messageFilter(scope);
  return {
    sql: `
WITH steps AS (
  SELECT m.id AS id,
         m.session_id AS session_id,
         m.time_created AS time_created,
         CASE WHEN json_valid(m.data) THEN m.data END AS payload,
         s.project_id AS project_id
    FROM session_message m
    LEFT JOIN session_v2 s ON s.id = m.session_id
   WHERE m.type = 'assistant'
     AND ${ELIGIBLE_MESSAGE}
     AND ${filter.sql}
),
items AS (
  SELECT steps.id AS message_id,
         steps.session_id AS session_id,
         steps.project_id AS project_id,
         steps.time_created AS step_time,
         item.value AS value
    FROM steps, json_each(steps.payload, '$.content') AS item
   WHERE json_type(item.value) = 'object'
)
SELECT message_id,
       session_id,
       project_id,
       step_time,
       json_extract(value, '$.name') AS name,
       json_extract(value, '$.state.status') AS status,
       json_extract(value, '$.time.created') AS created,
       json_extract(value, '$.time.ran') AS ran,
       json_extract(value, '$.time.completed') AS completed
  FROM items
 WHERE json_extract(value, '$.type') = 'tool'
 ORDER BY step_time, message_id, name`,
    params: filter.params,
  };
}

export function loadToolRows(runner: QueryRunner, scope: MetricScope): ToolRow[] {
  const { sql, params } = buildToolRowsQuery(scope);
  const rows = runner.all<{
    message_id: unknown;
    session_id: unknown;
    project_id: unknown;
    name: unknown;
    status: unknown;
    created: unknown;
    ran: unknown;
    completed: unknown;
  }>(sql, params);

  return rows.map((row) => ({
    messageId: String(row.message_id),
    sessionId: row.session_id === null ? null : String(row.session_id),
    projectId: row.project_id === null ? null : String(row.project_id),
    name: nonEmptyString(row.name),
    status: nonEmptyString(row.status),
    created: finiteNumber(row.created),
    ran: finiteNumber(row.ran),
    completed: finiteNumber(row.completed),
  }));
}

/** `completed` = succeeded, `error` = failed, everything else unfinished (§4). */
export function classifyToolStatus(status: string | null): ToolOutcome {
  if (status === 'completed') return 'succeeded';
  if (status === 'error') return 'failed';
  return 'unfinished';
}

/**
 * `completed - (ran ?? created)` from the content item's top-level `time`.
 * Only terminal calls with a finite, nonnegative duration are measurable.
 */
export function toolDurationMs(row: ToolRow): number | null {
  const outcome = classifyToolStatus(row.status);
  if (outcome === 'unfinished') return null;
  if (row.completed === null) return null;
  const start = row.ran !== null ? row.ran : row.created;
  if (start === null) return null;
  const duration = row.completed - start;
  if (!Number.isFinite(duration) || duration < 0) return null;
  return duration;
}

export interface ToolAccumulator {
  calls: number;
  succeeded: number;
  failed: number;
  unfinished: number;
  durations: number[];
}

export function createToolAccumulator(): ToolAccumulator {
  return { calls: 0, succeeded: 0, failed: 0, unfinished: 0, durations: [] };
}

export function addTool(accumulator: ToolAccumulator, row: ToolRow): void {
  accumulator.calls += 1;
  accumulator[classifyToolStatus(row.status)] += 1;
  const duration = toolDurationMs(row);
  if (duration !== null) accumulator.durations.push(duration);
}

export function finishToolTotals(accumulator: ToolAccumulator): ToolOutcomeTotals {
  const terminal = accumulator.succeeded + accumulator.failed;
  return {
    calls: accumulator.calls,
    succeeded: accumulator.succeeded,
    failed: accumulator.failed,
    unfinished: accumulator.unfinished,
    failureRate: terminal === 0 ? null : accumulator.failed / terminal,
    duration: durationStats(accumulator.durations),
  };
}

function durationStats(durations: readonly number[]): { count: number; p50: number; p95: number } | null {
  if (durations.length === 0) return null;
  return {
    count: durations.length,
    p50: median(durations),
    p95: nearestRank(durations, 0.95),
  };
}

/** Arithmetic median: the middle value, or the mean of the two middle values. */
export function median(values: readonly number[]): number {
  if (values.length === 0) throw new Error('median requires at least one value');
  const sorted = [...values].sort((left, right) => left - right);
  const middle = sorted.length >> 1;
  if (sorted.length % 2 === 1) return sorted[middle] as number;
  return ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2;
}

/** Nearest rank: `ceil(p × n) − 1`, clamped into the sample. */
export function nearestRank(values: readonly number[], probability: number): number {
  if (values.length === 0) throw new Error('nearestRank requires at least one value');
  const sorted = [...values].sort((left, right) => left - right);
  const rank = Math.ceil(probability * sorted.length) - 1;
  const index = Math.min(Math.max(rank, 0), sorted.length - 1);
  return sorted[index] as number;
}

// ---------------------------------------------------------------------------
// Assistant usage accumulation
// ---------------------------------------------------------------------------

export type TokenCategory = 'input' | 'output' | 'reasoning' | 'cacheRead' | 'cacheWrite';

export const TOKEN_CATEGORIES: readonly TokenCategory[] = ['input', 'output', 'reasoning', 'cacheRead', 'cacheWrite'];

interface CategoryAccumulator {
  sum: number;
  measured: number;
}

export interface UsageAccumulator {
  steps: number;
  unreadable: number;
  hasError: number;
  categories: Record<TokenCategory, CategoryAccumulator>;
  cost: CategoryAccumulator;
}

export function createUsageAccumulator(): UsageAccumulator {
  return {
    steps: 0,
    unreadable: 0,
    hasError: 0,
    categories: {
      input: { sum: 0, measured: 0 },
      output: { sum: 0, measured: 0 },
      reasoning: { sum: 0, measured: 0 },
      cacheRead: { sum: 0, measured: 0 },
      cacheWrite: { sum: 0, measured: 0 },
    },
    cost: { sum: 0, measured: 0 },
  };
}

function addCategory(accumulator: CategoryAccumulator, value: number | null): void {
  if (value === null) return;
  accumulator.sum += value;
  accumulator.measured += 1;
}

export function addStep(accumulator: UsageAccumulator, row: StepRow): void {
  accumulator.steps += 1;
  if (row.unreadable) accumulator.unreadable += 1;
  if (row.hasError) accumulator.hasError += 1;
  addCategory(accumulator.categories.input, row.input);
  addCategory(accumulator.categories.output, row.output);
  addCategory(accumulator.categories.reasoning, row.reasoning);
  addCategory(accumulator.categories.cacheRead, row.cacheRead);
  addCategory(accumulator.categories.cacheWrite, row.cacheWrite);
  addCategory(accumulator.cost, row.cost);
}

function measuredTotal(accumulator: CategoryAccumulator, counted: number): MeasuredTotal {
  if (accumulator.measured === 0) {
    if (counted === 0) return { value: 0, complete: true, measured: 0, counted: 0 };
    return { value: null, complete: false, measured: 0, counted };
  }
  return {
    value: accumulator.sum,
    complete: accumulator.measured === counted,
    measured: accumulator.measured,
    counted,
  };
}

export function finishUsage(accumulator: UsageAccumulator): UsageTotals {
  const counted = accumulator.steps;
  const tokens: TokenTotals = {
    input: measuredTotal(accumulator.categories.input, counted),
    output: measuredTotal(accumulator.categories.output, counted),
    reasoning: measuredTotal(accumulator.categories.reasoning, counted),
    cacheRead: measuredTotal(accumulator.categories.cacheRead, counted),
    cacheWrite: measuredTotal(accumulator.categories.cacheWrite, counted),
    total: null,
  };

  const complete =
    tokens.input.complete &&
    tokens.output.complete &&
    tokens.reasoning.complete &&
    tokens.cacheRead.complete &&
    tokens.cacheWrite.complete;
  if (complete) {
    tokens.total =
      (tokens.input.value ?? 0) +
      (tokens.output.value ?? 0) +
      (tokens.reasoning.value ?? 0) +
      (tokens.cacheRead.value ?? 0) +
      (tokens.cacheWrite.value ?? 0);
  }

  const cacheDenominatorComplete = tokens.input.complete && tokens.cacheRead.complete && tokens.cacheWrite.complete;
  const cacheDenominator = (tokens.input.value ?? 0) + (tokens.cacheRead.value ?? 0) + (tokens.cacheWrite.value ?? 0);
  const cacheRate =
    cacheDenominatorComplete && cacheDenominator > 0 ? (tokens.cacheRead.value ?? 0) / cacheDenominator : null;

  return {
    steps: counted,
    tokens,
    cost: measuredTotal(accumulator.cost, counted),
    cacheRate,
  };
}

export function usageCoverage(accumulator: UsageAccumulator, usage: UsageTotals): UsageCoverage {
  const tokensComplete =
    usage.tokens.input.complete &&
    usage.tokens.output.complete &&
    usage.tokens.reasoning.complete &&
    usage.tokens.cacheRead.complete &&
    usage.tokens.cacheWrite.complete;
  return {
    steps: accumulator.steps,
    unreadableSteps: accumulator.unreadable,
    costComplete: usage.cost.complete,
    tokensComplete,
  };
}

/** Group step rows by an arbitrary key, preserving first-seen order. */
export function groupSteps<K>(rows: readonly StepRow[], key: (row: StepRow) => K): Map<K, StepRow[]> {
  const groups = new Map<K, StepRow[]>();
  for (const row of rows) {
    const groupKey = key(row);
    const existing = groups.get(groupKey);
    if (existing === undefined) groups.set(groupKey, [row]);
    else existing.push(row);
  }
  return groups;
}

// ---------------------------------------------------------------------------
// Daily series and activity
// ---------------------------------------------------------------------------

export interface DailyAccumulator {
  steps: number;
  prompts: number;
  tokenSum: number;
  tokenMeasured: number;
  costSum: number;
  costMeasured: number;
}

function emptyDaily(): DailyAccumulator {
  return { steps: 0, prompts: 0, tokenSum: 0, tokenMeasured: 0, costSum: 0, costMeasured: 0 };
}

export function createDailyMap(): Map<string, DailyAccumulator> {
  return new Map<string, DailyAccumulator>();
}

function dailyEntry(map: Map<string, DailyAccumulator>, date: string): DailyAccumulator {
  const existing = map.get(date);
  if (existing !== undefined) return existing;
  const created = emptyDaily();
  map.set(date, created);
  return created;
}

export function addStepToDaily(
  map: Map<string, DailyAccumulator>,
  date: string,
  row: StepRow,
  categories: readonly number[],
): void {
  const entry = dailyEntry(map, date);
  entry.steps += 1;
  for (const value of categories) {
    if (value === null) continue;
    entry.tokenSum += value;
    entry.tokenMeasured += 1;
  }
  if (row.cost !== null) {
    entry.costSum += row.cost;
    entry.costMeasured += 1;
  }
}

export function addPromptToDaily(map: Map<string, DailyAccumulator>, date: string): void {
  dailyEntry(map, date).prompts += 1;
}

/**
 * Zero-fill the resolved local dates.
 *
 * A date with no steps is a fully measured zero. A date with steps but no
 * complete token/cost coverage reports null instead of a partial total.
 */
export function buildDaily(
  map: ReadonlyMap<string, DailyAccumulator>,
  dateKeys: readonly string[],
): DailyActivityPoint[] {
  return dateKeys.map((date) => {
    const entry = map.get(date);
    if (entry === undefined) return { date, steps: 0, prompts: 0, tokens: 0, cost: 0 };
    return {
      date,
      steps: entry.steps,
      prompts: entry.prompts,
      tokens: entry.tokenMeasured === entry.steps * 5 ? entry.tokenSum : null,
      cost: entry.costMeasured === entry.steps ? entry.costSum : null,
    };
  });
}

/** Snapshot values of one step's token categories, in canonical order. */
export function stepTokenValues(row: StepRow): number[] {
  return [row.input, row.output, row.reasoning, row.cacheRead, row.cacheWrite].filter(
    (value): value is number => value !== null,
  );
}

export function summarizeActivity(
  dateKeys: readonly string[],
  activeDates: ReadonlySet<string>,
): ActivitySummary {
  let activeDays = 0;
  let longestStreak = 0;
  let current = 0;
  for (const date of dateKeys) {
    if (activeDates.has(date)) {
      activeDays += 1;
      current += 1;
      if (current > longestStreak) longestStreak = current;
    } else {
      current = 0;
    }
  }
  return { activeDays, longestStreak };
}

/** Earliest date of the observed activity, used as the `all` lower bucket bound. */
export function earliestDate(dates: Iterable<string>): string | null {
  let earliest: string | null = null;
  for (const date of dates) {
    if (earliest === null || date < earliest) earliest = date;
  }
  return earliest;
}

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

export interface ProjectRow {
  id: string;
  name: string | null;
  worktree: string | null;
}

export function loadProjectCatalog(runner: QueryRunner): Map<string, ProjectRow> {
  const rows = runner.all<{ id: unknown; name: unknown; worktree: unknown }>(
    'SELECT id, name, worktree FROM project',
  );
  const catalog = new Map<string, ProjectRow>();
  for (const row of rows) {
    catalog.set(String(row.id), {
      id: String(row.id),
      name: nonEmptyString(row.name),
      worktree: nonEmptyString(row.worktree),
    });
  }
  return catalog;
}

/**
 * Project display label (§4): nonempty name, then the worktree basename, then
 * the project ID. An unknown/orphan project group keeps an explicit label.
 */
export function projectLabel(projectId: string | null, project: ProjectRow | undefined): string {
  if (projectId === null) return 'Unknown project';
  const name = project?.name?.trim();
  if (name !== undefined && name !== '') return name;
  const worktree = project?.worktree?.trim();
  if (worktree !== undefined && worktree !== '') {
    const base = basename(worktree);
    if (base !== '' && base !== '/') return base;
  }
  return projectId;
}

/** Session label: its title, or a short ID when the title is missing (§4). */
export function sessionLabel(id: string, title: string | null): string {
  const trimmed = title?.trim();
  if (trimmed !== undefined && trimmed !== '') return trimmed;
  return id.length > 12 ? id.slice(0, 12) : id;
}

// ---------------------------------------------------------------------------
// Session detail navigation
// ---------------------------------------------------------------------------

export interface SessionMetadataRow {
  id: string;
  title: string | null;
  projectId: string | null;
  parentId: string | null;
  model: string | null;
  timeCreated: number;
  timeUpdated: number;
}

export function loadSessionMetadata(runner: QueryRunner, id: string): SessionMetadataRow | null {
  const row = runner.get<{
    id: unknown;
    title: unknown;
    project_id: unknown;
    parent_id: unknown;
    model: unknown;
    time_created: unknown;
    time_updated: unknown;
  }>(
    'SELECT id, title, project_id, parent_id, model, time_created, time_updated FROM session_v2 WHERE id = ?',
    [id],
  );
  if (row === undefined) return null;
  return {
    id: String(row.id),
    title: nonEmptyString(row.title),
    projectId: row.project_id === null ? null : String(row.project_id),
    parentId: row.parent_id === null ? null : String(row.parent_id),
    model: nonEmptyString(row.model),
    timeCreated: finiteNumber(row.time_created) ?? 0,
    timeUpdated: finiteNumber(row.time_updated) ?? 0,
  };
}

/**
 * Child sessions with their total assistant-step counts. Navigation is
 * independent of the selected range (§4); the copied-fork rule still applies.
 */
export function loadChildSessions(
  runner: QueryRunner,
  sessionId: string,
): Array<{ id: string; title: string; timeCreated: number; steps: number }> {
  const rows = runner.all<{ id: unknown; title: unknown; time_created: unknown; steps: unknown }>(
    `
SELECT s.id AS id,
       s.title AS title,
       s.time_created AS time_created,
       (SELECT count(*) FROM session_message m
          WHERE m.session_id = s.id
            AND m.type = 'assistant'
            AND (s.fork_session_id IS NULL OR m.time_created >= s.time_created)) AS steps
  FROM session_v2 s
 WHERE s.parent_id = ?
 ORDER BY s.time_created, s.id`,
    [sessionId],
  );
  return rows.map((row) => ({
    id: String(row.id),
    title: sessionLabel(String(row.id), nonEmptyString(row.title)),
    timeCreated: finiteNumber(row.time_created) ?? 0,
    steps: finiteNumber(row.steps) ?? 0,
  }));
}

/** Agent usage rows from assistant steps (§4 agent names are open-ended). */
export function buildAgentRows(groups: ReadonlyMap<string | null, readonly StepRow[]>): Omit<AgentUsageRow, 'estimate'>[] {
  const rows: Omit<AgentUsageRow, 'estimate'>[] = [];
  for (const [agent, steps] of groups) {
    const accumulator = createUsageAccumulator();
    for (const step of steps) addStep(accumulator, step);
    rows.push({ agent, steps: steps.length, usage: finishUsage(accumulator) });
  }
  return rows.sort((left, right) => {
    const ranked = compareUsage(left, right);
    if (ranked !== 0) return ranked;
    return String(left.agent ?? '').localeCompare(String(right.agent ?? ''));
  });
}

/** Deterministic ranking by token total, then cost, then step count. */
export function compareUsage(
  left: { usage: UsageTotals; steps: number },
  right: { usage: UsageTotals; steps: number },
): number {
  const leftTokens = left.usage.tokens.total ?? -1;
  const rightTokens = right.usage.tokens.total ?? -1;
  if (leftTokens !== rightTokens) return rightTokens - leftTokens;
  const leftCost = left.usage.cost.value ?? -1;
  const rightCost = right.usage.cost.value ?? -1;
  if (leftCost !== rightCost) return rightCost - leftCost;
  return right.steps - left.steps;
}
