/**
 * Hash route parsing and construction.
 *
 * Plan references: §6 "Hash navigation with back/forward support and preserved
 * filters". Every piece of dashboard state that a user can change — page,
 * range, filters, sorting, pagination, and the session-detail activity mode —
 * lives in the URL fragment, so browser back/forward restores the exact view
 * without extra bookkeeping and no returned session data is ever persisted.
 *
 * The module is pure (no DOM, no `window`) so the server test project can
 * exercise it directly under Node's type stripping. The DOM binding lives in
 * `useHashRoute.ts`.
 */

import type { SessionSortKey, StatsRangeKey } from '../shared/api.ts';

export type RouteName = 'overview' | 'models' | 'projects' | 'tools' | 'errors' | 'sessions' | 'session' | 'unknown';

export interface ParsedRoute {
  name: RouteName;
  /** Decoded session ID for the `session` route; null otherwise. */
  sessionId: string | null;
  /** Query parameters, decoded, as a plain record. */
  query: Readonly<Record<string, string>>;
}

/** Path fragment for every route that has no parameters. */
export const ROUTE_PATHS: Readonly<Record<'overview' | 'models' | 'projects' | 'tools' | 'errors' | 'sessions', string>> = {
  overview: '/overview',
  models: '/models',
  projects: '/projects',
  tools: '/tools',
  errors: '/errors',
  sessions: '/sessions',
};

export const ROUTE_TITLES: Readonly<Record<Exclude<RouteName, 'unknown'>, string>> = {
  overview: 'Overview',
  models: 'Models',
  projects: 'Projects',
  tools: 'Tools',
  errors: 'Errors',
  sessions: 'Sessions',
  session: 'Session detail',
};

export const DEFAULT_RANGE_KEY: StatsRangeKey = '30d';

export interface RangeOption {
  value: StatsRangeKey;
  label: string;
  title: string;
}

export const RANGE_OPTIONS: readonly RangeOption[] = [
  { value: '7d', label: '7 days', title: 'Last 7 local calendar days' },
  { value: '30d', label: '30 days', title: 'Last 30 local calendar days' },
  { value: '90d', label: '90 days', title: 'Last 90 local calendar days' },
  { value: 'all', label: 'All time', title: 'Everything recorded in the database' },
];

export const SESSION_SORT_KEYS: readonly SessionSortKey[] = ['updated', 'created', 'title', 'prompts', 'steps', 'tokens', 'cost'];

/** Bounded page sizes offered by the sessions list. */
export const SESSION_PAGE_SIZES: readonly number[] = [25, 50, 100];

/** Bounded page sizes offered by the session step table. */
export const STEP_PAGE_SIZES: readonly number[] = [25, 50, 100];

export const MAX_LIMIT = 200;
export const MAX_OFFSET = 1_000_000;

export function isRangeKey(value: string | null | undefined): value is StatsRangeKey {
  return value === '7d' || value === '30d' || value === '90d' || value === 'all';
}

export function rangeFromQuery(query: Readonly<Record<string, string>>, fallback: StatsRangeKey = DEFAULT_RANGE_KEY): StatsRangeKey {
  const raw = query['range'];
  return isRangeKey(raw) ? raw : fallback;
}

export function rangeLabel(key: StatsRangeKey): string {
  const option = RANGE_OPTIONS.find((entry) => entry.value === key);
  return option?.label ?? key;
}

/** True when the session-detail page requested the explicit all-activity mode. */
export function allActivityFromQuery(query: Readonly<Record<string, string>>): boolean {
  return query['activity'] === 'all';
}

function decodeSegment(segment: string): string | null {
  try {
    const decoded = decodeURIComponent(segment);
    return decoded === '' ? null : decoded;
  } catch {
    return null;
  }
}

function queryFromSearch(search: string): Record<string, string> {
  const query: Record<string, string> = {};
  for (const [key, value] of new URLSearchParams(search)) {
    // Repeated keys keep the last value: the API reads a single scalar anyway.
    if (key !== '') query[key] = value;
  }
  return query;
}

/**
 * Parse a location hash. An empty fragment resolves to the Overview route with
 * no query so the shell can immediately canonicalize the URL.
 */
export function parseHash(hash: string): ParsedRoute {
  const raw = hash.startsWith('#') ? hash.slice(1) : hash;
  const queryIndex = raw.indexOf('?');
  const path = queryIndex === -1 ? raw : raw.slice(0, queryIndex);
  const query = queryFromSearch(queryIndex === -1 ? '' : raw.slice(queryIndex + 1));
  const segments = path.split('/').filter((segment) => segment !== '');

  if (segments.length === 0) return { name: 'overview', sessionId: null, query };

  const [head, second, ...rest] = segments;
  if (head === 'sessions') {
    if (second === undefined) return { name: 'sessions', sessionId: null, query };
    if (rest.length > 0) return { name: 'unknown', sessionId: null, query };
    const sessionId = decodeSegment(second);
    if (sessionId === null) return { name: 'unknown', sessionId: null, query };
    return { name: 'session', sessionId, query };
  }
  if (second !== undefined) return { name: 'unknown', sessionId: null, query };

  switch (head) {
    case 'overview':
    case 'models':
    case 'projects':
    case 'tools':
    case 'errors':
      return { name: head, sessionId: null, query };
    default:
      return { name: 'unknown', sessionId: null, query };
  }
}

export function serializeQuery(query: Readonly<Record<string, string>>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== '') search.set(key, value);
  }
  return search.toString();
}

/** Build a comparable route object from a hash, for tests and equality checks. */
export function routePath(route: Pick<ParsedRoute, 'name' | 'sessionId'>): string {
  if (route.name === 'unknown') return '/unknown';
  if (route.name === 'session') {
    return route.sessionId === null ? ROUTE_PATHS.sessions : `/sessions/${encodeURIComponent(route.sessionId)}`;
  }
  return ROUTE_PATHS[route.name];
}

/** Build a `#/…` hash for a route plus its query. */
export function buildHash(route: Pick<ParsedRoute, 'name' | 'sessionId'> & { query?: Readonly<Record<string, string>> }): string {
  const path = routePath(route);
  const search = serializeQuery(route.query ?? {});
  return search === '' ? `#${path}` : `#${path}?${search}`;
}

/**
 * Apply updates to a query record. `null`/`undefined`/`''` remove a key, so a
 * cleared filter leaves no empty parameter behind.
 */
export function updateQuery(
  query: Readonly<Record<string, string>>,
  changes: Readonly<Record<string, string | null | undefined>>,
): Record<string, string> {
  const next: Record<string, string> = { ...query };
  for (const [key, value] of Object.entries(changes)) {
    if (value === null || value === undefined || value === '') delete next[key];
    else next[key] = value;
  }
  return next;
}

/**
 * Parse a bounded non-negative integer query value. Invalid input falls back
 * instead of throwing, so a hand-edited URL never breaks a page.
 */
export function parseBoundedInteger(raw: string | undefined, fallback: number, max: number): number {
  if (raw === undefined || !/^\d+$/.test(raw)) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value > max) return fallback;
  return value;
}

/**
 * Parse `limit`, falling back when it is not one of the offered page sizes.
 * Bounded server-side anyway; this keeps the control and the request in step.
 */
export function parseLimit(raw: string | undefined, fallback: number, allowed: readonly number[]): number {
  const value = parseBoundedInteger(raw, fallback, MAX_LIMIT);
  return allowed.includes(value) ? value : fallback;
}

export function parseSessionSort(raw: string | undefined): SessionSortKey {
  return (SESSION_SORT_KEYS as readonly string[]).includes(raw ?? '') ? (raw as SessionSortKey) : 'updated';
}

export function parseSortDir(raw: string | undefined): 'asc' | 'desc' {
  return raw === 'asc' ? 'asc' : 'desc';
}

/**
 * Filters worth carrying across pages. The range and project filter are
 * meaningful everywhere they are offered; search text and pagination are not,
 * so switching pages cannot silently apply a stale, invisible filter.
 */
export function carryFilters(query: Readonly<Record<string, string>>): Record<string, string> {
  const carried: Record<string, string> = {};
  const range = query['range'];
  if (range !== undefined) carried['range'] = range;
  const projectId = query['projectId'];
  if (projectId !== undefined) carried['projectId'] = projectId;
  return carried;
}

/**
 * Hash for another dashboard page, carrying the filters that stay meaningful
 * across pages and applying `changes` on top.
 */
export function pageHash(
  current: Pick<ParsedRoute, 'query'>,
  name: 'overview' | 'models' | 'projects' | 'tools' | 'errors' | 'sessions',
  changes: Readonly<Record<string, string | null | undefined>> = {},
): string {
  return buildHash({ name, sessionId: null, query: updateQuery(carryFilters(current.query), changes) });
}

/** Hash for a session detail page, keeping the range and dropping list filters. */
export function sessionHash(
  current: Pick<ParsedRoute, 'query'>,
  sessionId: string,
  changes: Readonly<Record<string, string | null | undefined>> = {},
): string {
  const base: Record<string, string> = {};
  const range = current.query['range'];
  if (range !== undefined) base['range'] = range;
  return buildHash({ name: 'session', sessionId, query: updateQuery(base, changes) });
}
