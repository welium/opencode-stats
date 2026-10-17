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

// ---------------------------------------------------------------------------
// Offline API-equivalent estimates (§2 verified accounting, §7 Phase 4)
// ---------------------------------------------------------------------------

/** State of the optional local pricing catalog used for estimates. */
export interface PricingCatalogMeta {
  /** True only when the envelope and its string body parsed into a usable catalog. */
  available: boolean;
  /** The catalog's own `updatedAt` as an ISO instant; null when absent or unusable. */
  updatedAt: string | null;
  /** Reserved; always null. Arbitrary local digest strings are not exposed. */
  digest: string | null;
}

/**
 * `complete` = every counted step was priced; `partial` = a priced subtotal of a
 * larger counted set; `unavailable` = nothing could be priced.
 */
export type EstimateStatus = 'complete' | 'partial' | 'unavailable';

/**
 * Why one counted step could not be priced. Every unpriced step gets exactly one
 * reason: `no-model-price` (unknown provider/model or a rejected price entry),
 * `missing-tokens` (a token category is missing, negative, or not finite),
 * `missing-rate` (a required rate for a positive category is missing or invalid),
 * `ambiguous-tier` (invalid tier descriptors or duplicate applicable thresholds).
 */
export type EstimateUnpricedReason = 'no-model-price' | 'missing-tokens' | 'missing-rate' | 'ambiguous-tier';

/** A provider/model identity with at least one unpriced step. */
export interface UnpricedModelRow {
  provider: string | null;
  model: string | null;
  steps: number;
}

/**
 * An offline API-equivalent estimate for one usage group. This is a separate
 * value that is never added to, or mixed with, recorded cost (§7 Phase 4).
 */
export interface CostEstimate {
  status: EstimateStatus;
  /** Priced subtotal in USD; null when `status` is `unavailable`. */
  cost: number | null;
  /** Assistant steps considered; the same scope as the sibling usage totals. */
  steps: number;
  pricedSteps: number;
  unpricedSteps: number;
  unpricedByReason: Record<EstimateUnpricedReason, number>;
  /** Unpriced identities ranked by step count, bounded to the top rows. */
  unpricedModels: UnpricedModelRow[];
  /** True when more unpriced identities exist than `unpricedModels` lists. */
  unpricedModelsTruncated: boolean;
  catalog: PricingCatalogMeta;
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

export interface DailyEstimatePoint {
  date: string;
  estimate: CostEstimate;
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
  estimate: CostEstimate;
}

/** Assistant activity and streaks (local calendar dates). */
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
  /** Offline API-equivalent estimate for the same steps as `usage`. */
  estimate: CostEstimate;
  activity: ActivitySummary;
  daily: DailyActivityPoint[];
  dailyEstimates: DailyEstimatePoint[];
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
  /**
   * API-equivalent estimate for this model's steps. Kept separate from `usage`
   * so an estimate can never be read as, or added to, recorded cost.
   */
  estimate: CostEstimate;
}

/** `GET /api/stats/models`. */
export interface ModelsResponse {
  generatedAt: string;
  range: RangeMeta;
  coverage: UsageCoverage;
  models: ModelUsageRow[];
  daily: DailyActivityPoint[];
  dailyEstimates: DailyEstimatePoint[];
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
  /** API-equivalent estimate for this project's steps; never added to `usage`. */
  estimate: CostEstimate;
}

/** `GET /api/stats/projects`. */
export interface ProjectsResponse {
  generatedAt: string;
  range: RangeMeta;
  coverage: UsageCoverage;
  projects: ProjectUsageRow[];
  daily: DailyActivityPoint[];
  dailyEstimates: DailyEstimatePoint[];
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
  /** API-equivalent estimate for this session's in-range steps. */
  estimate: CostEstimate;
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
  estimate: CostEstimate;
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
  estimate: CostEstimate;
  prompts: number;
  activity: ActivitySummary;
  daily: DailyActivityPoint[];
  dailyEstimates: DailyEstimatePoint[];
  parent: { id: string; title: string } | null;
  children: Array<{ id: string; title: string; timeCreated: number; steps: number }>;
  steps: SessionStepPage;
}

/** Safe metadata only: error messages, data, and tool state are never returned. */
export interface ErrorEventRow {
  messageId: string;
  sessionId: string | null;
  timeCreated: number;
  kind: 'assistant' | 'tool';
  type: string;
  provider: string | null;
  model: string | null;
}

export interface ErrorsResponse {
  generatedAt: string;
  range: RangeMeta;
  assistantErrors: number;
  toolFailures: number;
  groups: Array<{ kind: 'assistant' | 'tool'; type: string; provider: string | null; model: string | null; count: number }>;
  groupsTruncated: boolean;
  total: number;
  limit: number;
  offset: number;
  entries: ErrorEventRow[];
}
