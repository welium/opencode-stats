/**
 * Hash router binding for React.
 *
 * Plan references: §6 "Hash navigation with back/forward support and preserved
 * filters". The URL fragment is the single source of truth: navigation assigns
 * `location.hash`, the browser's own history stack provides back/forward, and a
 * `hashchange` listener re-parses the fragment. Pure parsing lives in
 * `route.ts`.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import type { ParsedRoute } from './route.ts';

import { buildHash, parseHash, updateQuery } from './route.ts';

export interface HashRouter {
  route: ParsedRoute;
  /** Merge query parameters into the current route, or remove them with null. */
  setParams: (changes: Readonly<Record<string, string | null | undefined>>, options?: { replace?: boolean }) => void;
}

export function useHashRoute(): HashRouter {
  const [route, setRoute] = useState<ParsedRoute>(() => parseHash(window.location.hash));
  const pathRef = useRef<string>(`${route.name}:${route.sessionId ?? ''}`);

  useEffect(() => {
    const onHashChange = (): void => {
      const next = parseHash(window.location.hash);
      const path = `${next.name}:${next.sessionId ?? ''}`;
      // A new page starts at the top; a filter change keeps the reading position.
      if (path !== pathRef.current) window.scrollTo({ top: 0 });
      pathRef.current = path;
      setRoute(next);
    };
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  const setParams = useCallback(
    (changes: Readonly<Record<string, string | null | undefined>>, options?: { replace?: boolean }) => {
      const current = parseHash(window.location.hash);
      const hash = buildHash({
        name: current.name,
        sessionId: current.sessionId,
        query: updateQuery(current.query, changes),
      });
      if (options?.replace === true) {
        // `history.replaceState` does not fire `hashchange`, so the state is
        // refreshed explicitly and no history entry is added.
        window.history.replaceState(null, '', hash);
        setRoute(parseHash(hash));
        return;
      }
      if (window.location.hash === hash) return;
      window.location.hash = hash;
    },
    [],
  );

  return { route, setParams };
}
