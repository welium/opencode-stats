/**
 * Statistics endpoints: query validation and response assembly.
 *
 * Plan references: §4 (metric rules), §5 (HTTP interface, validation, bounded
 * pagination). Every builder runs entirely inside one short read transaction and
 * uses a single captured clock value supplied by the caller, so a multi-query
 * response is internally consistent and the transaction finishes before the
 * response is written.
 *
 * Bounded validation (all values are bound parameters; no request data is ever
 * interpolated into SQL):
 *  - `range` must be `7d`, `30d`, `90d`, or `all`
 *  - `projectId`, a session ID, `model`, and `search` are length-bounded
 *  - `limit`/`offset` are integers with fixed defaults and maxima
 *  - `sort` is an allowlisted key and `dir` is `asc` or `desc`
 */

import type {
  ErrorEventRow,
  ErrorsResponse,
  ActivitySummary,
  DailyActivityPoint,
  DailyEstimatePoint,
  ModelUsageRow,
  ModelsResponse,
  OverviewResponse,
  ProjectUsageRow,
  ProjectsResponse,
  SessionDetailResponse,
  SessionListRow,
  SessionSortKey,
  SessionStepRow,
  SessionsResponse,
  StatsRangeKey,
  ToolUsageRow,
  ToolsResponse,
  UsageCoverage,
  UsageTotals,
} from '../shared/api.ts';

import { errorEnvelope } from './errors.ts';
import { tokenSortValue } from '../shared/usage.ts';
import { estimateCost, loadPricingCatalog } from './pricing.ts';
import type { PricingCatalog } from './pricing.ts';
import {
  addPromptToDaily,
  addStep,
  addStepToDaily,
  addTool,
  buildAgentRows,
  buildDaily,
  classifyToolStatus,
  compareUsage,
  createDailyMap,
  createToolAccumulator,
  createUsageAccumulator,
  earliestDate,
  finishToolTotals,
  finishUsage,
  groupSteps,
  loadActiveSessions,
  loadChildSessions,
  loadPromptRows,
  loadProjectCatalog,
  loadSessionMetadata,
  loadStepRows,
  loadToolRows,
  projectLabel,
  sessionLabel,
  stepTokenValues,
  summarizeActivity,
  summarizeCohort,
  toolDurationMs,
  usageCoverage,
} from './metrics.ts';

import type { MetricScope, PromptRow, QueryRunner, StepRow } from './metrics.ts';
import type { ResolvedRange } from './range.ts';

import { localDateKey, parseStatsRange, rangeDateKeys, rangeMeta, resolveRange } from './range.ts';

// ---------------------------------------------------------------------------
// Request preparation
// ---------------------------------------------------------------------------

export type StatsRoute = 'stats/overview' | 'stats/models' | 'stats/projects' | 'stats/tools' | 'stats/errors' | 'sessions' | 'session';

/** Captured clock plus the request's read connection. */
export interface StatsContext {
  runner: QueryRunner;
  /** Single clock value captured before the read transaction starts. */
  now: number;
}

/** A built response: the HTTP status plus the JSON payload. */
export interface StatsBuild {
  status: number;
  payload: unknown;
}

export type PreparedStatsRequest =
  | { ok: true; build: (context: StatsContext) => StatsBuild }
  | { ok: false; message: string };

/** Bounded query-string limits (§5). */
export const MAX_SESSION_ID_LENGTH = 200;
export const MAX_PROJECT_ID_LENGTH = 200;
export const MAX_SEARCH_LENGTH = 200;
export const MAX_MODEL_FILTER_LENGTH = 200;
export const SESSION_LIST_DEFAULT_LIMIT = 50;
export const SESSION_LIST_MAX_LIMIT = 200;
export const STEP_PAGE_DEFAULT_LIMIT = 50;
export const STEP_PAGE_MAX_LIMIT = 200;
export const MAX_OFFSET = 1_000_000;

const SESSION_SORT_KEYS: readonly SessionSortKey[] = ['updated', 'created', 'title', 'prompts', 'steps', 'tokens', 'cost'];
const DEFAULT_SESSION_SORT: SessionSortKey = 'updated';

type Parsed<T> = { ok: true; value: T } | { ok: false; message: string };

function parseBoundedInteger(raw: string | null, label: string, fallback: number, max: number): Parsed<number> {
  if (raw === null) return { ok: true, value: fallback };
  if (!/^\d+$/.test(raw)) return { ok: false, message: `${label} must be a non-negative integer` };
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value > max) {
    return { ok: false, message: `${label} must be between 0 and ${String(max)}` };
  }
  return { ok: true, value };
}

function parseText(raw: string | null, label: string, maxLength: number): Parsed<string | null> {
  if (raw === null) return { ok: true, value: null };
  const trimmed = raw.trim();
  if (trimmed === '') return { ok: false, message: `${label} must not be empty` };
  if (trimmed.length > maxLength) {
    return { ok: false, message: `${label} must be at most ${String(maxLength)} characters` };
  }
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) {
    return { ok: false, message: `${label} must not contain control characters` };
  }
  return { ok: true, value: trimmed };
}

function parseRangeAndProject(
  params: URLSearchParams,
): Parsed<{ rangeKey: StatsRangeKey; projectId: string | null }> {
  const rangeKey = parseStatsRange(params.get('range'));
  if (rangeKey === null) {
    return { ok: false, message: 'range must be one of 7d, 30d, 90d, all' };
  }
  const project = parseText(params.get('projectId'), 'projectId', MAX_PROJECT_ID_LENGTH);
  if (!project.ok) return project;
  return { ok: true, value: { rangeKey, projectId: project.value } };
}

function parseModelFilter(params: URLSearchParams): Parsed<{ provider: string | null; model: string } | null> {
  const raw = parseText(params.get('model'), 'model', MAX_MODEL_FILTER_LENGTH);
  if (!raw.ok) return raw;
  if (raw.value === null) return { ok: true, value: null };
  const slash = raw.value.indexOf('/');
  if (slash === -1) return { ok: true, value: { provider: null, model: raw.value } };
  const provider = raw.value.slice(0, slash);
  const model = raw.value.slice(slash + 1);
  if (provider === '' || model === '') return { ok: false, message: 'model must be "model" or "provider/model"' };
  return { ok: true, value: { provider, model } };
}

function parseSessionSort(params: URLSearchParams): Parsed<{ sort: SessionSortKey; dir: 'asc' | 'desc' }> {
  const rawSort = params.get('sort');
  const sort =
    rawSort === null
      ? DEFAULT_SESSION_SORT
      : (SESSION_SORT_KEYS as readonly string[]).includes(rawSort)
        ? (rawSort as SessionSortKey)
        : null;
  if (sort === null) return { ok: false, message: `sort must be one of ${SESSION_SORT_KEYS.join(', ')}` };
  const rawDir = params.get('dir');
  if (rawDir !== null && rawDir !== 'asc' && rawDir !== 'desc') {
    return { ok: false, message: 'dir must be asc or desc' };
  }
  return { ok: true, value: { sort, dir: rawDir ?? 'desc' } };
}

function scopeFor(range: ResolvedRange, projectId: string | null, sessionId: string | null = null): MetricScope {
  return { from: range.from, to: range.to, projectId, sessionId };
}

function nowIso(context: StatsContext): string {
  return new Date(context.now).toISOString();
}

// ---------------------------------------------------------------------------
// Shared aggregation
// ---------------------------------------------------------------------------

interface RangeAggregate {
  usage: UsageTotals;
  coverage: UsageCoverage;
  daily: DailyActivityPoint[];
  dailyEstimates: DailyEstimatePoint[];
  activity: ActivitySummary;
  assistantErrors: number;
}

/**
 * Assistant usage, zero-filled daily buckets, and activity for one range.
 * `promptDates` only contributes to buckets and the `all` lower bound; the
 * prompt total is a cohort rule the caller applies.
 */
function aggregateRange(
  range: ResolvedRange,
  steps: readonly StepRow[],
  promptDates: readonly string[],
  pricing: PricingCatalog,
): RangeAggregate {
  const accumulator = createUsageAccumulator();
  const daily = createDailyMap();
  const activeDates = new Set<string>();

  for (const step of steps) {
    addStep(accumulator, step);
    const date = localDateKey(step.timeCreated);
    addStepToDaily(daily, date, step, stepTokenValues(step));
    activeDates.add(date);
  }
  for (const date of promptDates) addPromptToDaily(daily, date);

  const usage = finishUsage(accumulator);
  const dateKeys = rangeDateKeys(range, earliestDate([...activeDates, ...promptDates]));
  const byDate = groupSteps(steps, (step) => localDateKey(step.timeCreated));

  return {
    usage,
    coverage: usageCoverage(accumulator, usage),
    daily: buildDaily(daily, dateKeys),
    dailyEstimates: dateKeys.map((date) => ({ date, estimate: estimateCost(byDate.get(date) ?? [], pricing) })),
    activity: summarizeActivity(dateKeys, activeDates),
    assistantErrors: accumulator.hasError,
  };
}

/** Usage totals plus coverage for one group of steps. */
function usageOf(steps: readonly StepRow[]): { usage: UsageTotals; coverage: UsageCoverage } {
  const accumulator = createUsageAccumulator();
  for (const step of steps) addStep(accumulator, step);
  const usage = finishUsage(accumulator);
  return { usage, coverage: usageCoverage(accumulator, usage) };
}

/** Root-session user messages define prompts (§4). */
function rootPromptDates(prompts: readonly PromptRow[]): { count: number; dates: string[] } {
  const dates: string[] = [];
  for (const prompt of prompts) {
    if (!prompt.isRootPrompt) continue;
    dates.push(localDateKey(prompt.timeCreated));
  }
  return { count: dates.length, dates };
}

// ---------------------------------------------------------------------------
// /api/stats/overview
// ---------------------------------------------------------------------------

function buildOverview(context: StatsContext, query: { range: ResolvedRange; projectId: string | null }): StatsBuild {
  const scope = scopeFor(query.range, query.projectId);
  const steps = loadStepRows(context.runner, scope);
  const prompts = rootPromptDates(loadPromptRows(context.runner, scope));
  const sessions = loadActiveSessions(context.runner, scope);
  const pricing = loadPricingCatalog(context.runner);
  const aggregate = aggregateRange(query.range, steps, prompts.dates, pricing);
  const agentGroups = groupSteps(steps, (row) => row.agent);

  const payload: OverviewResponse = {
    generatedAt: nowIso(context),
    range: rangeMeta(query.range),
    coverage: aggregate.coverage,
    sessions: summarizeCohort(sessions),
    prompts: prompts.count,
    steps: steps.length,
    assistantErrors: aggregate.assistantErrors,
    usage: aggregate.usage,
    estimate: estimateCost(steps, pricing),
    activity: aggregate.activity,
    daily: aggregate.daily,
    dailyEstimates: aggregate.dailyEstimates,
    agents: buildAgentRows(agentGroups).map((row) => ({ ...row, estimate: estimateCost(agentGroups.get(row.agent) ?? [], pricing) })),
  };
  return { status: 200, payload };
}

// ---------------------------------------------------------------------------
// /api/stats/models
// ---------------------------------------------------------------------------

interface ModelGroup {
  provider: string | null;
  model: string | null;
  rows: StepRow[];
}

function groupByModel(steps: readonly StepRow[]): ModelGroup[] {
  const groups = new Map<string, ModelGroup>();
  for (const row of steps) {
    // `variant` is deliberately excluded so model variants share one top-level row.
    const key = `${row.provider ?? ''}\u0000${row.model ?? ''}`;
    const existing = groups.get(key);
    if (existing === undefined) groups.set(key, { provider: row.provider, model: row.model, rows: [row] });
    else existing.rows.push(row);
  }
  return [...groups.values()];
}

function buildModels(
  context: StatsContext,
  query: {
    range: ResolvedRange;
    projectId: string | null;
    modelFilter: { provider: string | null; model: string } | null;
  },
): StatsBuild {
  const scope = scopeFor(query.range, query.projectId);
  const allSteps = loadStepRows(context.runner, scope);
  const filter = query.modelFilter;
  const steps =
    filter === null
      ? allSteps
      : allSteps.filter((row) => row.model === filter.model && (filter.provider === null || row.provider === filter.provider));

  const models: ModelUsageRow[] = [];
  const pricing = loadPricingCatalog(context.runner);
  for (const group of groupByModel(steps)) {
    const { usage } = usageOf(group.rows);
    const sessionIds = new Set<string>();
    for (const row of group.rows) if (row.sessionId !== null) sessionIds.add(row.sessionId);
    models.push({ provider: group.provider, model: group.model, steps: group.rows.length, sessions: sessionIds.size, usage, estimate: estimateCost(group.rows, pricing) });
  }
  models.sort((left, right) => {
    const ranked = compareUsage(left, right);
    if (ranked !== 0) return ranked;
    return `${left.provider ?? ''}/${left.model ?? ''}`.localeCompare(`${right.provider ?? ''}/${right.model ?? ''}`);
  });

  const aggregate = aggregateRange(query.range, steps, [], pricing);
  const payload: ModelsResponse = {
    generatedAt: nowIso(context),
    range: rangeMeta(query.range),
    coverage: aggregate.coverage,
    models,
    daily: aggregate.daily,
    dailyEstimates: aggregate.dailyEstimates,
  };
  return { status: 200, payload };
}

// ---------------------------------------------------------------------------
// /api/stats/projects
// ---------------------------------------------------------------------------

function buildProjects(
  context: StatsContext,
  query: { range: ResolvedRange; projectId: string | null },
): StatsBuild {
  const scope = scopeFor(query.range, query.projectId);
  const steps = loadStepRows(context.runner, scope);
  const sessions = loadActiveSessions(context.runner, scope);
  const catalog = loadProjectCatalog(context.runner);

  const stepGroups = groupSteps(steps, (row) => row.projectId);
  const pricing = loadPricingCatalog(context.runner);
  const sessionCounts = new Map<string | null, number>();
  for (const session of sessions) {
    sessionCounts.set(session.projectId, (sessionCounts.get(session.projectId) ?? 0) + 1);
  }

  const projectIds = new Set<string | null>([...stepGroups.keys(), ...sessionCounts.keys()]);
  const projects: ProjectUsageRow[] = [];
  for (const projectId of projectIds) {
    const rows = stepGroups.get(projectId) ?? [];
    const { usage } = usageOf(rows);
    const project = projectId === null ? undefined : catalog.get(projectId);
    projects.push({
      projectId,
      label: projectLabel(projectId, project),
      name: project?.name ?? null,
      worktree: project?.worktree ?? null,
      sessions: sessionCounts.get(projectId) ?? 0,
      steps: rows.length,
      usage,
      estimate: estimateCost(rows, pricing),
    });
  }
  projects.sort((left, right) => {
    const ranked = compareUsage(left, right);
    if (ranked !== 0) return ranked;
    return left.label.localeCompare(right.label);
  });

  const aggregate = aggregateRange(query.range, steps, [], pricing);
  const payload: ProjectsResponse = {
    generatedAt: nowIso(context),
    range: rangeMeta(query.range),
    coverage: aggregate.coverage,
    projects,
    daily: aggregate.daily,
    dailyEstimates: aggregate.dailyEstimates,
  };
  return { status: 200, payload };
}

// ---------------------------------------------------------------------------
// /api/stats/tools
// ---------------------------------------------------------------------------

function buildTools(context: StatsContext, query: { range: ResolvedRange; projectId: string | null }): StatsBuild {
  const scope = scopeFor(query.range, query.projectId);
  const tools = loadToolRows(context.runner, scope);

  const totals = createToolAccumulator();
  const byName = new Map<string | null, ReturnType<typeof createToolAccumulator>>();
  for (const tool of tools) {
    addTool(totals, tool);
    const existing = byName.get(tool.name);
    if (existing === undefined) {
      const created = createToolAccumulator();
      addTool(created, tool);
      byName.set(tool.name, created);
    } else {
      addTool(existing, tool);
    }
  }

  const rows: ToolUsageRow[] = [...byName.entries()]
    .map(([name, accumulator]) => ({ name, ...finishToolTotals(accumulator) }))
    .sort((left, right) => {
      if (left.calls !== right.calls) return right.calls - left.calls;
      return String(left.name ?? '').localeCompare(String(right.name ?? ''));
    });

  const payload: ToolsResponse = {
    generatedAt: nowIso(context),
    range: rangeMeta(query.range),
    totals: finishToolTotals(totals),
    tools: rows,
  };
  return { status: 200, payload };
}

// ---------------------------------------------------------------------------
// /api/sessions
// ---------------------------------------------------------------------------

function sessionSortValue(row: SessionListRow, sort: SessionSortKey): number | string | null {
  switch (sort) {
    case 'updated':
      return row.timeUpdated;
    case 'created':
      return row.timeCreated;
    case 'title':
      return row.title.toLowerCase();
    case 'prompts':
      return row.prompts;
    case 'steps':
      return row.steps;
    case 'tokens':
      return tokenSortValue(row.usage.tokens);
    case 'cost':
      return row.usage.cost.value;
  }
}

function compareSessions(
  left: SessionListRow,
  right: SessionListRow,
  sort: SessionSortKey,
  dir: 'asc' | 'desc',
): number {
  const first = sessionSortValue(left, sort);
  const second = sessionSortValue(right, sort);
  if (first === null && second !== null) return 1;
  if (second === null && first !== null) return -1;
  let ranked: number;
  if (typeof first === 'number' && typeof second === 'number') {
    ranked = first === second ? 0 : first < second ? -1 : 1;
  } else {
    ranked = String(first).localeCompare(String(second));
  }
  if (ranked !== 0) return dir === 'asc' ? ranked : -ranked;
  // Stable tie-break so pagination never repeats or skips a row.
  return left.id.localeCompare(right.id);
}

function buildSessionsList(
  context: StatsContext,
  query: {
    range: ResolvedRange;
    projectId: string | null;
    search: string | null;
    sort: SessionSortKey;
    dir: 'asc' | 'desc';
    limit: number;
    offset: number;
  },
): StatsBuild {
  const scope = scopeFor(query.range, query.projectId);
  const steps = loadStepRows(context.runner, scope);
  const sessions = loadActiveSessions(context.runner, scope);
  const catalog = loadProjectCatalog(context.runner);
  const promptCounts = new Map<string, number>();
  for (const prompt of loadPromptRows(context.runner, scope)) {
    if (!prompt.isRootPrompt || prompt.sessionId === null) continue;
    promptCounts.set(prompt.sessionId, (promptCounts.get(prompt.sessionId) ?? 0) + 1);
  }

  const stepGroups = groupSteps(steps, (row) => row.sessionId);
  const pricing = loadPricingCatalog(context.runner);
  let rows: SessionListRow[] = sessions.map((session) => {
    const sessionSteps = stepGroups.get(session.id) ?? [];
    const { usage } = usageOf(sessionSteps);
    const project = session.projectId === null ? undefined : catalog.get(session.projectId);
    return {
      id: session.id,
      title: sessionLabel(session.id, session.title),
      projectId: session.projectId,
      projectLabel: projectLabel(session.projectId, project),
      parentId: session.parentId,
      isSubagent: session.parentId !== null,
      timeCreated: session.timeCreated,
      timeUpdated: session.timeUpdated,
      prompts: promptCounts.get(session.id) ?? 0,
      steps: sessionSteps.length,
      usage,
      estimate: estimateCost(sessionSteps, pricing),
    };
  });

  // Search covers the session title and ID only, never message content (§5).
  if (query.search !== null) {
    const needle = query.search.toLowerCase();
    rows = rows.filter((row) => row.title.toLowerCase().includes(needle) || row.id.toLowerCase().includes(needle));
  }

  rows.sort((left, right) => compareSessions(left, right, query.sort, query.dir));
  const total = rows.length;
  const page = rows.slice(query.offset, query.offset + query.limit);

  const payload: SessionsResponse = {
    generatedAt: nowIso(context),
    range: rangeMeta(query.range),
    // Coverage describes the request's range/project filter, not the page.
    coverage: usageOf(steps).coverage,
    total,
    limit: query.limit,
    offset: query.offset,
    sort: query.sort,
    dir: query.dir,
    sessions: page,
  };
  return { status: 200, payload };
}

// ---------------------------------------------------------------------------
// /api/sessions/:id
// ---------------------------------------------------------------------------

function buildSessionDetail(
  context: StatsContext,
  query: { range: ResolvedRange; allActivity: boolean; limit: number; offset: number },
  sessionId: string,
): StatsBuild {
  const session = loadSessionMetadata(context.runner, sessionId);
  if (session === null) {
    return {
      status: 404,
      payload: errorEnvelope('not_found', `Unknown session: ${sessionId}`, nowIso(context)),
    };
  }

  const scope = scopeFor(query.range, null, sessionId);
  const steps = loadStepRows(context.runner, scope);
  const prompts = rootPromptDates(loadPromptRows(context.runner, scope));

  // Stable `seq, id` order with NULL sequences last, applied before paging so a
  // page boundary cannot repeat or skip a row.
  const ordered = [...steps].sort((left, right) => {
    if (left.seq === null && right.seq !== null) return 1;
    if (left.seq !== null && right.seq === null) return -1;
    if (left.seq !== null && right.seq !== null && left.seq !== right.seq) return left.seq - right.seq;
    return left.id.localeCompare(right.id);
  });
  const page = ordered.slice(query.offset, query.offset + query.limit);
  const pricing = loadPricingCatalog(context.runner);

  const toolsByMessage = new Map<string, ReturnType<typeof loadToolRows>>();
  for (const tool of loadToolRows(context.runner, scope)) {
    const existing = toolsByMessage.get(tool.messageId);
    if (existing === undefined) toolsByMessage.set(tool.messageId, [tool]);
    else existing.push(tool);
  }

  const entries: SessionStepRow[] = page.map((step) => ({
    id: step.id,
    seq: step.seq,
    timeCreated: step.timeCreated,
    agent: step.agent,
    provider: step.provider,
    model: step.model,
    hasError: step.hasError,
    usage: usageOf([step]).usage,
    estimate: estimateCost([step], pricing),
    tools: (toolsByMessage.get(step.id) ?? []).map((tool) => ({
      name: tool.name,
      status: classifyToolStatus(tool.status),
      durationMs: toolDurationMs(tool),
    })),
  }));

  const parent = session.parentId === null ? null : loadSessionMetadata(context.runner, session.parentId);
  const catalog = loadProjectCatalog(context.runner);
  const project = session.projectId === null ? undefined : catalog.get(session.projectId);
  const aggregate = aggregateRange(query.range, steps, prompts.dates, pricing);

  const payload: SessionDetailResponse = {
    generatedAt: nowIso(context),
    range: rangeMeta(query.range),
    allActivity: query.allActivity,
    session: {
      id: session.id,
      title: sessionLabel(session.id, session.title),
      projectId: session.projectId,
      projectLabel: projectLabel(session.projectId, project),
      parentId: session.parentId,
      isSubagent: session.parentId !== null,
      model: session.model,
      timeCreated: session.timeCreated,
      timeUpdated: session.timeUpdated,
    },
    coverage: aggregate.coverage,
    usage: aggregate.usage,
    estimate: estimateCost(steps, pricing),
    prompts: prompts.count,
    activity: aggregate.activity,
    daily: aggregate.daily,
    dailyEstimates: aggregate.dailyEstimates,
    parent: parent === null ? null : { id: parent.id, title: sessionLabel(parent.id, parent.title) },
    children: loadChildSessions(context.runner, sessionId),
    steps: { total: ordered.length, limit: query.limit, offset: query.offset, entries },
  };
  return { status: 200, payload };
}

// ---------------------------------------------------------------------------
// Routing entry point
// ---------------------------------------------------------------------------

function buildErrors(context: StatsContext, query: { range: ResolvedRange; projectId: string | null; limit: number; offset: number }): StatsBuild {
  const scope = scopeFor(query.range, query.projectId);
  const steps = loadStepRows(context.runner, scope);
  const byId = new Map(steps.map((step) => [step.id, step]));
  const entries: ErrorEventRow[] = steps.filter((step) => step.hasError).map((step) => ({
    messageId: step.id, sessionId: step.sessionId, timeCreated: step.timeCreated,
    kind: 'assistant', type: step.errorType ?? 'UnknownError', provider: step.provider, model: step.model,
  }));
  const assistantErrors = entries.length;
  for (const tool of loadToolRows(context.runner, scope)) {
    if (classifyToolStatus(tool.status) !== 'failed') continue;
    const step = byId.get(tool.messageId);
    if (step === undefined) continue;
    entries.push({ messageId: step.id, sessionId: step.sessionId, timeCreated: step.timeCreated,
      kind: 'tool', type: 'failed', provider: step.provider, model: step.model });
  }
  const grouped = new Map<string, ErrorsResponse['groups'][number]>();
  for (const entry of entries) {
    const key = JSON.stringify([entry.kind, entry.type, entry.provider, entry.model]);
    const group = grouped.get(key) ?? { kind: entry.kind, type: entry.type, provider: entry.provider, model: entry.model, count: 0 };
    group.count++;
    grouped.set(key, group);
  }
  const groups = [...grouped.values()].sort((a, b) => b.count - a.count || JSON.stringify(a).localeCompare(JSON.stringify(b)));
  entries.sort((a, b) => b.timeCreated - a.timeCreated || a.messageId.localeCompare(b.messageId) || a.kind.localeCompare(b.kind));
  const payload: ErrorsResponse = {
    generatedAt: nowIso(context), range: rangeMeta(query.range), assistantErrors,
    toolFailures: entries.length - assistantErrors, groups: groups.slice(0, 100), groupsTruncated: groups.length > 100,
    total: entries.length, limit: query.limit, offset: query.offset, entries: entries.slice(query.offset, query.offset + query.limit),
  };
  return { status: 200, payload };
}

/**
 * Validate a statistics request and return a builder bound to it.
 *
 * Validation happens before any query runs, so an invalid request never opens a
 * read transaction. `now` is captured by the caller and reused for range
 * resolution, `generatedAt`, and error envelopes inside the same response.
 */
export function prepareStatsRequest(
  route: StatsRoute,
  params: URLSearchParams,
  now: number,
  options: { sessionId?: string } = {},
): PreparedStatsRequest {
  const base = parseRangeAndProject(params);
  if (!base.ok) return base;

  if (route === 'stats/errors') {
    const limit = parseBoundedInteger(params.get('limit'), 'limit', 50, 200);
    const offset = parseBoundedInteger(params.get('offset'), 'offset', 0, MAX_OFFSET);
    if (!limit.ok) return limit;
    if (!offset.ok) return offset;
    const query = { range: resolveRange(base.value.rangeKey, now), projectId: base.value.projectId, limit: limit.value, offset: offset.value };
    return { ok: true, build: (context) => buildErrors(context, query) };
  }

  if (route !== 'sessions' && route !== 'session') {
    const range = resolveRange(base.value.rangeKey, now);
    const query = { range, projectId: base.value.projectId };
    if (route === 'stats/overview') return { ok: true, build: (context) => buildOverview(context, query) };
    if (route === 'stats/projects') return { ok: true, build: (context) => buildProjects(context, query) };
    if (route === 'stats/tools') return { ok: true, build: (context) => buildTools(context, query) };

    const modelFilter = parseModelFilter(params);
    if (!modelFilter.ok) return modelFilter;
    const modelQuery = { range, projectId: base.value.projectId, modelFilter: modelFilter.value };
    return { ok: true, build: (context) => buildModels(context, modelQuery) };
  }

  const isList = route === 'sessions';
  const limit = parseBoundedInteger(
    params.get('limit'),
    'limit',
    isList ? SESSION_LIST_DEFAULT_LIMIT : STEP_PAGE_DEFAULT_LIMIT,
    isList ? SESSION_LIST_MAX_LIMIT : STEP_PAGE_MAX_LIMIT,
  );
  if (!limit.ok) return limit;
  const offset = parseBoundedInteger(params.get('offset'), 'offset', 0, MAX_OFFSET);
  if (!offset.ok) return offset;

  if (route === 'sessions') {
    const search = parseText(params.get('search'), 'search', MAX_SEARCH_LENGTH);
    if (!search.ok) return search;
    const sort = parseSessionSort(params);
    if (!sort.ok) return sort;
    const range = resolveRange(base.value.rangeKey, now);
    const query = {
      range,
      projectId: base.value.projectId,
      search: search.value,
      sort: sort.value.sort,
      dir: sort.value.dir,
      limit: limit.value,
      offset: offset.value,
    };
    return { ok: true, build: (context) => buildSessionsList(context, query) };
  }

  const sessionId = options.sessionId ?? '';
  if (sessionId === '') return { ok: false, message: 'A session ID is required' };
  if (sessionId.length > MAX_SESSION_ID_LENGTH) {
    return { ok: false, message: `Session ID must be at most ${String(MAX_SESSION_ID_LENGTH)} characters` };
  }
  const range = resolveRange(base.value.rangeKey, now);
  const query = {
    range,
    allActivity: base.value.rangeKey === 'all',
    limit: limit.value,
    offset: offset.value,
  };
  return { ok: true, build: (context) => buildSessionDetail(context, query, sessionId) };
}
