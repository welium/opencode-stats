/**
 * Application root: routing, the global range and refresh actions, data-source
 * health, and the page switch.
 *
 * Plan references: §6 "Global range selector and explicit Refresh following §3's
 * refresh contract; no automatic polling in v1", "Hash navigation with
 * back/forward support and preserved filters", and "Theme preference and range
 * may be stored locally; do not persist returned session data". The only things
 * this module writes to storage are the theme and the range preference; every
 * returned value lives in component state and is discarded on reload.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';

import type { HealthResponse, StatsRangeKey } from '../shared/api.ts';

import { fetchHealth } from './api.ts';
import { Shell } from './components/Shell.tsx';
import { PageHeader } from './components/PageHeader.tsx';
import { ModelsPage } from './pages/ModelsPage.tsx';
import { OverviewPage } from './pages/OverviewPage.tsx';
import { ProjectsPage } from './pages/ProjectsPage.tsx';
import { SessionDetailPage } from './pages/SessionDetailPage.tsx';
import { SessionsPage } from './pages/SessionsPage.tsx';
import { ToolsPage } from './pages/ToolsPage.tsx';
import { ErrorsPage } from './pages/ErrorsPage.tsx';
import type { PageProps } from './pages/types.ts';
import { ROUTE_TITLES, pageHash, rangeFromQuery } from './route.ts';
import { safeLocalStorage } from './storage.ts';
import { writeRangePreference } from './theme.ts';
import { useHashRoute } from './useHashRoute.ts';
import { usePendingReads } from './refreshStatus.ts';
import { useQuery } from './useQuery.ts';
import { useTheme } from './useTheme.ts';

const APP_NAME = 'OpenCode Stats Dashboard';

function NotFoundPage(props: PageProps): React.ReactElement {
  return (
    <div className="page">
      <PageHeader
        title="Page not found"
        description="This address does not match a dashboard page. No statistics were requested."
        actions={
          <a className="btn" href={pageHash(props.route, 'overview', { range: props.rangeKey })}>
            Go to Overview
          </a>
        }
      />
    </div>
  );
}

export function App(): React.ReactElement {
  const { route, setParams } = useHashRoute();
  const { theme, toggle } = useTheme();
  const [refreshToken, setRefreshToken] = useState(0);
  const pendingReads = usePendingReads();

  const health = useQuery<HealthResponse>('health', refreshToken, (signal) => fetchHealth(signal));

  const rangeKey = rangeFromQuery(route.query);

  // The range is a preference, not returned data, so it is the one query value
  // worth remembering between visits (§6).
  useEffect(() => {
    writeRangePreference(safeLocalStorage(), rangeKey);
  }, [rangeKey]);

  useEffect(() => {
    document.title = route.name === 'unknown' ? `Page not found · ${APP_NAME}` : `${ROUTE_TITLES[route.name]} · ${APP_NAME}`;
  }, [route.name]);

  const onRefresh = useCallback(() => {
    setRefreshToken((token) => token + 1);
  }, []);

  const onRangeChange = useCallback(
    (key: StatsRangeKey) => {
      // Pagination is dropped with the range: page N of a wider range is not the
      // same set of rows, and landing past the end would look like an empty range.
      setParams({ range: key, offset: null, stepOffset: null });
    },
    [setParams],
  );

  const onToggleTheme = useCallback(() => {
    toggle();
  }, [toggle]);

  const pageProps: PageProps = useMemo(
    () => ({ route, rangeKey, refreshToken, onRefresh, setParams }),
    [route, rangeKey, refreshToken, onRefresh, setParams],
  );

  // Progress is only meaningful for a user-requested refresh, not the first paint.
  const refreshing = refreshToken > 0 && pendingReads > 0;

  return (
    <Shell
      route={route}
      rangeKey={rangeKey}
      onRangeChange={onRangeChange}
      onRefresh={onRefresh}
      refreshing={refreshing}
      health={health.data}
      healthError={health.error}
      generatedAt={health.data?.generatedAt ?? null}
      theme={theme}
      onToggleTheme={onToggleTheme}
    >
      {route.name === 'overview' ? <OverviewPage {...pageProps} /> : null}
      {route.name === 'models' ? <ModelsPage {...pageProps} /> : null}
      {route.name === 'projects' ? <ProjectsPage {...pageProps} /> : null}
      {route.name === 'tools' ? <ToolsPage {...pageProps} /> : null}
      {route.name === 'errors' ? <ErrorsPage {...pageProps} /> : null}
      {route.name === 'sessions' ? <SessionsPage {...pageProps} /> : null}
      {route.name === 'session' ? <SessionDetailPage {...pageProps} /> : null}
      {route.name === 'unknown' ? <NotFoundPage {...pageProps} /> : null}
    </Shell>
  );
}
