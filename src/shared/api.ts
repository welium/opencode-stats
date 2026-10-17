/**
 * Response types shared by the dashboard server and the browser client.
 *
 * All payloads follow the envelope style of the implementation plan (§5):
 * a `generatedAt` capture timestamp, plus a consistent typed error envelope
 * whose `code` maps to the HTTP status used by the API.
 *
 * This module is types-only so it can be imported by Node's type-stripping
 * loader and by the browser bundle without emitting runtime code.
 */

/** HTTP status derivation for the error envelope. */
export type ApiErrorCode =
  | 'bad_request'
  | 'not_found'
  | 'method_not_allowed'
  | 'database_unavailable'
  | 'internal_error';

/** Which source produced the resolved database path. */
export type DatabasePathSource = 'flag' | 'env' | 'xdg-data-home' | 'home-local-share';

/**
 * Distinct database conditions. `missing` is never treated as an empty usage
 * history; `incompatible` is never treated as a successful all-zero result.
 */
export type DatabaseState =
  | 'ready'
  | 'missing'
  | 'unreadable'
  | 'incompatible'
  | 'corrupt'
  | 'busy'
  | 'error';

/** Safe, structured detail about the configured database. */
export interface DatabaseStatus {
  /** Absolute path that was resolved and inspected. */
  path: string;
  pathSource: DatabasePathSource;
  state: DatabaseState;
  /** Safe human message; never contains raw database content. */
  message: string;
  /** Optional low-level SQLite detail (error string only). */
  detail?: string;
}

/** Required-schema probe result. */
export interface SchemaStatus {
  /** True only when every required table and column is present. */
  supported: boolean;
  /** False when the database could not be opened, so nothing was probed. */
  checked: boolean;
  missingTables: string[];
  missingColumns: SchemaMissingColumns[];
}

export interface SchemaMissingColumns {
  table: string;
  columns: string[];
}

export interface ApiError {
  code: ApiErrorCode;
  message: string;
}

/** Error payload used for 400/404/405/503/500 responses. */
export interface ErrorEnvelope {
  generatedAt: string;
  error: ApiError;
}

/** `GET /api/health` — database state and supported-schema status. */
export interface HealthResponse {
  generatedAt: string;
  status: 'ok' | 'unavailable';
  database: DatabaseStatus;
  schema: SchemaStatus;
  /** Present only when `status` is `unavailable`. */
  error?: ApiError;
}

// ---------------------------------------------------------------------------
// Statistics (§4 metric rules, §5 endpoints)
// ---------------------------------------------------------------------------

/** Supported range keys. `all` has no lower bound. */
export type StatsRangeKey = '7d' | '30d' | '90d' | 'all';

/**
 * Resolved range boundaries plus the server's local timezone (§4 time/filter
 * contract). `from` is the inclusive lower bound at local midnight N−1 days
 * before today; `to` is the exclusive upper bound at the captured server clock.
 */
export interface RangeMeta {
  key: StatsRangeKey;
  /** ISO instant of the inclusive lower bound; null for `all`. */
  from: string | null;
  /** ISO instant of the exclusive upper bound (captured clock). */
  to: string;
  /** Local calendar date (`YYYY-MM-DD`) of the lower bound; null for `all`. */
  fromDate: string | null;
  /** Local calendar date of the captured instant. */
  toDate: string;
  /** IANA timezone used for calendar boundaries and daily buckets. */
  timezone: string;
  /** Local calendar dates covered by a finite range; null for `all`. */
  days: number | null;
}

/**
 * A total that records how completely it was measured. `value` is the sum of
 * measured values, or null when nothing was measurable; `complete` is true only
 * when every counted row contributed (§4 missing vs zero).
 */
export interface MeasuredTotal {
  value: number | null;
  complete: boolean;
  /** Rows that contributed a finite value. */
  measured: number;
  /** Rows considered. */
  counted: number;
}

/** Per-category assistant token sums. Categories never overlap (§4). */
export interface TokenTotals {
  input: MeasuredTotal;
  output: MeasuredTotal;
  reasoning: MeasuredTotal;
  cacheRead: MeasuredTotal;
  cacheWrite: MeasuredTotal;
  /** `input + output + reasoning + cacheRead + cacheWrite`; null unless complete. */
  total: number | null;
}

/** Assistant-step usage for one group and range. */
export interface UsageTotals {
  /** Assistant steps counted in this group. */
  steps: number;
  tokens: TokenTotals;
  /** Recorded assistant-message cost; never a session rollup. */
  cost: MeasuredTotal;
  /** cacheRead / (input + cacheRead + cacheWrite); null when unavailable. */
  cacheRate: number | null;
}

/** Coverage metadata that explains unavailable or partial values. */
export interface UsageCoverage {
  /** Assistant steps observed in range. */
  steps: number;
  /** Steps whose message payload JSON could not be read. */
  unreadableSteps: number;
  costComplete: boolean;
  tokensComplete: boolean;
}

/** One zero-filled local calendar date of the daily series. */
export interface DailyActivityPoint {
  /** Local calendar date, `YYYY-MM-DD`. */
  date: string;
  steps: number;
  prompts: number;
  /** Measured token subtotal for the date; null when steps exist but none measured tokens. */
  tokens: number | null;
  /** Measured recorded cost for the date; null when steps exist but none recorded cost. */
  cost: number | null;
}

/** Distinct owning sessions active in range, split by `parent_id` (§4). */
export interface SessionCohort {
  total: number;
  root: number;
  subagent: number;
}

export interface AgentUsageRow {
  /** Agent name from the assistant message; null for an unknown group. */
  agent: string | null;
  steps: number;
  usage: UsageTotals;
}

export interface ActivitySummary {
  /** Local dates with at least one assistant step. */
  activeDays: number;
  /** Longest run of consecutive active local dates inside the range. */
  longestStreak: number;
}

/** `GET /api/stats/overview`. */
export interface OverviewResponse {
  generatedAt: string;
  range: RangeMeta;
  coverage: UsageCoverage;
  sessions: SessionCohort;
  /** User messages in range whose owning session is a root session. */
  prompts: number;
  steps: number;
  /** Assistant errors: steps with a non-null `error`. */
  assistantErrors: number;
  usage: UsageTotals;
  activity: ActivitySummary;
  daily: DailyActivityPoint[];
  agents: AgentUsageRow[];
}

export interface ModelUsageRow {
  /** Provider identity from the assistant message; null for an unknown group. */
  provider: string | null;
  /** Model identity from the assistant message; null for an unknown group. */
  model: string | null;
  steps: number;
  /** Distinct owning sessions with an eligible step for this model. */
  sessions: number;
  usage: UsageTotals;
}

/** `GET /api/stats/models`. */
export interface ModelsResponse {
  generatedAt: string;
  range: RangeMeta;
  coverage: UsageCoverage;
  models: ModelUsageRow[];
  daily: DailyActivityPoint[];
}

export interface ProjectUsageRow {
  projectId: string | null;
  /** Display label: name, else worktree basename, else project ID (§4). */
  label: string;
  name: string | null;
  worktree: string | null;
  sessions: number;
  steps: number;
  usage: UsageTotals;
}

/** `GET /api/stats/projects`. */
export interface ProjectsResponse {
  generatedAt: string;
  range: RangeMeta;
  coverage: UsageCoverage;
  projects: ProjectUsageRow[];
  daily: DailyActivityPoint[];
}

export type ToolOutcome = 'succeeded' | 'failed' | 'unfinished';

export interface ToolDurationStats {
  count: number;
  /** Arithmetic median, averaging the two middle values for even samples. */
  p50: number;
  /** Nearest rank `ceil(0.95 × n) − 1`. */
  p95: number;
}

/** Tool call outcomes and durations; thresholds are unavailable, not zero. */
export interface ToolOutcomeTotals {
  calls: number;
  succeeded: number;
  failed: number;
  unfinished: number;
  /** failed / (succeeded + failed); null when there is no terminal call. */
  failureRate: number | null;
  /** Null when no terminal call has a valid nonnegative duration. */
  duration: ToolDurationStats | null;
}

export interface ToolUsageRow extends ToolOutcomeTotals {
  /** Tool name from the content item; null for an unknown group. */
  name: string | null;
}

/** `GET /api/stats/tools`. */
export interface ToolsResponse {
  generatedAt: string;
  range: RangeMeta;
  totals: ToolOutcomeTotals;
  tools: ToolUsageRow[];
}

/** Sort keys accepted by `/api/sessions` (allowlist). */
export type SessionSortKey = 'updated' | 'created' | 'title' | 'prompts' | 'steps' | 'tokens' | 'cost';

export interface SessionListRow {
  id: string;
  title: string;
  projectId: string | null;
  projectLabel: string;
  parentId: string | null;
  isSubagent: boolean;
  timeCreated: number;
  timeUpdated: number;
  prompts: number;
  steps: number;
  usage: UsageTotals;
}

/** `GET /api/sessions`. */
export interface SessionsResponse {
  generatedAt: string;
  range: RangeMeta;
  coverage: UsageCoverage;
  /** Sessions matching the filter, before pagination. */
  total: number;
  limit: number;
  offset: number;
  sort: SessionSortKey;
  dir: 'asc' | 'desc';
  sessions: SessionListRow[];
}

export interface SessionStepTool {
  name: string | null;
  status: ToolOutcome;
  /** `completed - (ran ?? created)` in ms; null when not measurable. */
  durationMs: number | null;
}

export interface SessionStepRow {
  id: string;
  seq: number | null;
  timeCreated: number;
  agent: string | null;
  provider: string | null;
  model: string | null;
  hasError: boolean;
  usage: UsageTotals;
  tools: SessionStepTool[];
}

export interface SessionStepPage {
  total: number;
  limit: number;
  offset: number;
  entries: SessionStepRow[];
}

/** `GET /api/sessions/:id`. */
export interface SessionDetailResponse {
  generatedAt: string;
  range: RangeMeta;
  /** True when the explicit “all session activity” mode removed the range. */
  allActivity: boolean;
  session: {
    id: string;
    title: string;
    projectId: string | null;
    projectLabel: string;
    parentId: string | null;
    isSubagent: boolean;
    /** Session's stored model identity string; metadata only, not usage identity. */
    model: string | null;
    timeCreated: number;
    timeUpdated: number;
  };
  coverage: UsageCoverage;
  usage: UsageTotals;
  prompts: number;
  activity: ActivitySummary;
  daily: DailyActivityPoint[];
  parent: { id: string; title: string } | null;
  children: Array<{ id: string; title: string; timeCreated: number; steps: number }>;
  steps: SessionStepPage;
}
