/**
 * Abortable read hook.
 *
 * Plan references: §3 refresh contract — "Refresh re-fetches all data used by
 * the active page … prevent an older in-flight response from overwriting
 * refreshed results" — and §6's distinct loading / empty-range /
 * unavailable-database / request-error states.
 *
 * `key` identifies the semantic query (route + filters). `refreshToken` is an
 * app-level counter: when only it changes, the previous values stay on screen
 * and are marked `refreshing` instead of collapsing back to a skeleton.
 * Changing the key aborts the superseded request, so a late response can never
 * overwrite a newer one.
 */

import { useEffect, useRef, useState } from 'react';

import { ApiError } from './api.ts';
import { beginRead } from './refreshStatus.ts';

export type QueryErrorKind = 'unavailable' | 'request';

export interface QueryError {
  kind: QueryErrorKind;
  message: string;
}

export interface QueryState<T> {
  status: 'loading' | 'ready' | 'error';
  data: T | null;
  error: QueryError | null;
  /** True while a newer request is in flight and `data` is from an earlier one. */
  refreshing: boolean;
}

export function toQueryError(error: unknown): QueryError {
  if (error instanceof ApiError) {
    return {
      kind: error.code === 'database_unavailable' ? 'unavailable' : 'request',
      message: error.message,
    };
  }
  return { kind: 'request', message: error instanceof Error ? error.message : 'Request failed' };
}

interface InternalState<T> {
  key: string;
  status: 'loading' | 'ready' | 'error';
  data: T | null;
  error: QueryError | null;
  refreshing: boolean;
}

const INITIAL_KEY = '\u0000initial';

export function useQuery<T>(key: string, refreshToken: number, run: (signal: AbortSignal) => Promise<T>): QueryState<T> {
  const [state, setState] = useState<InternalState<T>>({
    key: INITIAL_KEY,
    status: 'loading',
    data: null,
    error: null,
    refreshing: false,
  });
  const runRef = useRef(run);
  runRef.current = run;

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    // Reported to the shell so Refresh can show honest progress.
    const settle = beginRead();

    setState((previous) =>
      previous.key === key
        ? { ...previous, refreshing: true, status: previous.data === null ? 'loading' : previous.status }
        : { key, status: 'loading', data: null, error: null, refreshing: true },
    );

    runRef.current(controller.signal).then(
      (data) => {
        if (!active) return;
        setState({ key, status: 'ready', data, error: null, refreshing: false });
      },
      (error: unknown) => {
        if (!active || controller.signal.aborted) return;
        setState({ key, status: 'error', data: null, error: toQueryError(error), refreshing: false });
      },
    ).finally(settle);

    return () => {
      // Cancelling the superseded request is what makes a stale response unable
      // to overwrite a refreshed one.
      active = false;
      controller.abort();
      settle();
    };
  }, [key, refreshToken]);

  return { status: state.status, data: state.data, error: state.error, refreshing: state.refreshing };
}
