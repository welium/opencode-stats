/**
 * Shared page props.
 *
 * Plan references: §3 refresh contract — every page receives the app-level
 * refresh token, so an explicit Refresh re-fetches everything the active page
 * shows — and §6 "preserved filters" — pages mutate the URL fragment through
 * `setParams` so filter changes are navigable with back/forward.
 */

import type { StatsRangeKey } from '../../shared/api.ts';
import type { ParsedRoute } from '../route.ts';

export interface PageProps {
  route: ParsedRoute;
  rangeKey: StatsRangeKey;
  /** Incremented by the shell's Refresh action; part of every query key. */
  refreshToken: number;
  /** Re-runs the active page's queries (used by retry actions). */
  onRefresh: () => void;
  /** Merge or remove query parameters on the current route. */
  setParams: (changes: Readonly<Record<string, string | null | undefined>>, options?: { replace?: boolean }) => void;
}
