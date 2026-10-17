/**
 * Application shell: fixed topbar, desktop sidebar, inset content panel, and
 * the narrow-screen navigation drawer.
 *
 * Plan references: §6 "fixed topbar, desktop sidebar, inset content area",
 * "Global range selector and explicit Refresh following §3's refresh contract;
 * no automatic polling in v1", "Desktop sidebar becomes accessible mobile
 * navigation", and "Theme preference and range may be stored locally".
 *
 * Navigation uses real anchors to `#/…` fragments, so back/forward, middle
 * click, and "open in new tab" behave the way the browser promises. The range
 * control is a native radio group; the mobile drawer moves focus in and out and
 * closes on Escape or scrim click.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';

import type { HealthResponse, StatsRangeKey } from '../../shared/api.ts';
import type { ParsedRoute } from '../route.ts';
import type { ThemePreference } from '../theme.ts';
import type { QueryError } from '../useQuery.ts';

import { formatTime } from '../format.ts';
import { RANGE_OPTIONS, buildHash, carryFilters, rangeLabel } from '../route.ts';
import {
  CloseIcon,
  MenuIcon,
  ModelsIcon,
  MoonIcon,
  OverviewIcon,
  ProjectsIcon,
  RefreshIcon,
  SessionsIcon,
  SunIcon,
  ToolsIcon,
} from './icons.tsx';
import { Segmented } from './ui.tsx';

interface NavItem {
  name: 'overview' | 'models' | 'projects' | 'tools' | 'sessions';
  label: string;
  icon: ReactNode;
}

const NAV_ITEMS: readonly NavItem[] = [
  { name: 'overview', label: 'Overview', icon: <OverviewIcon /> },
  { name: 'models', label: 'Models', icon: <ModelsIcon /> },
  { name: 'projects', label: 'Projects', icon: <ProjectsIcon /> },
  { name: 'tools', label: 'Tools', icon: <ToolsIcon /> },
  { name: 'sessions', label: 'Sessions', icon: <SessionsIcon /> },
];

/** Matches the `max-width: 900px` breakpoint in `styles.css`. */
const NARROW_QUERY = '(max-width: 900px)';

function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() =>
    typeof window.matchMedia === 'function' ? window.matchMedia(query).matches : false,
  );
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const list = window.matchMedia(query);
    const onChange = (event: MediaQueryListEvent): void => setMatches(event.matches);
    setMatches(list.matches);
    list.addEventListener('change', onChange);
    return () => list.removeEventListener('change', onChange);
  }, [query]);
  return matches;
}

export interface ShellProps {
  route: ParsedRoute;
  rangeKey: StatsRangeKey;
  onRangeChange: (key: StatsRangeKey) => void;
  onRefresh: () => void;
  refreshing: boolean;
  health: HealthResponse | null;
  healthError: QueryError | null;
  generatedAt: string | null;
  theme: ThemePreference;
  onToggleTheme: () => void;
  children: ReactNode;
}

function DatabaseChip(props: { health: HealthResponse | null; error: QueryError | null; generatedAt: string | null }) {
  const state = props.health === null ? 'unknown' : props.health.status === 'ok' ? 'ok' : 'unavailable';
  const label =
    state === 'ok' ? 'Database available' : state === 'unavailable' ? 'Database unavailable' : 'Database status unknown';
  return (
    <span className="chip" data-tone={state === 'ok' ? 'ok' : state === 'unavailable' ? 'bad' : 'neutral'} title={label}>
      <span className="dot" aria-hidden="true" />
      <span className="chip-label">{label}</span>
      <span className="chip-meta dim num">
        {props.generatedAt === null ? '' : `updated ${formatTime(Date.parse(props.generatedAt))}`}
      </span>
    </span>
  );
}

export function Shell(props: ShellProps): React.ReactElement {
  const narrow = useMediaQuery(NARROW_QUERY);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuButtonRef = useRef<HTMLButtonElement | null>(null);
  const navRef = useRef<HTMLElement | null>(null);

  const closeMenu = useCallback((restoreFocus: boolean) => {
    setMenuOpen(false);
    if (restoreFocus) menuButtonRef.current?.focus();
  }, []);

  // Leaving the narrow layout must never strand the drawer in the "open" state.
  useEffect(() => {
    if (!narrow) setMenuOpen(false);
  }, [narrow]);

  useEffect(() => {
    if (!menuOpen) return;
    navRef.current?.querySelector<HTMLAnchorElement>('a.nav-row')?.focus();
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault();
        closeMenu(true);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [menuOpen, closeMenu]);

  const activeName = props.route.name === 'session' ? 'sessions' : props.route.name;
  const carried = carryFilters(props.route.query);
  const themeAction = props.theme === 'dark' ? 'light' : 'dark';

  return (
    <div className="shell">
      {/*
        The first tab stop. It is a button rather than a `#main-content` anchor
        because the fragment is this app's router: a plain anchor would navigate
        the router to a non-route and render "page not found".
      */}
      <button
        type="button"
        className="skip-link"
        onClick={() => {
          document.getElementById('main-content')?.focus();
        }}
      >
        Skip to main content
      </button>

      <header className="topbar">
        <button
          type="button"
          ref={menuButtonRef}
          className="btn btn-icon topbar-menu"
          aria-label={menuOpen ? 'Close navigation' : 'Open navigation'}
          aria-expanded={menuOpen}
          aria-controls="app-navigation"
          onClick={() => setMenuOpen((open) => !open)}
        >
          {menuOpen ? <CloseIcon /> : <MenuIcon />}
        </button>

        <div className="brand">
          <span className="brand-name">OpenCode Stats</span>
          <span className="brand-sub">local, read-only</span>
        </div>

        <div className="topbar-actions">
          <span className="topbar-status">
            <DatabaseChip health={props.health} error={props.healthError} generatedAt={props.generatedAt} />
          </span>
          <button
            type="button"
            className="btn"
            onClick={props.onRefresh}
            disabled={props.refreshing}
            aria-label="Refresh statistics"
          >
            <RefreshIcon size={14} />
            <span>{props.refreshing ? 'Refreshing…' : 'Refresh'}</span>
          </button>
          <button
            type="button"
            className="btn btn-icon"
            aria-label={`Switch to ${themeAction} theme`}
            title={`Switch to ${themeAction} theme`}
            onClick={props.onToggleTheme}
          >
            {props.theme === 'dark' ? <SunIcon /> : <MoonIcon />}
          </button>
        </div>

        <div className="topbar-range">
          <Segmented
            name="global-range"
            label="Time range"
            value={props.rangeKey}
            options={RANGE_OPTIONS.map((option) => ({ value: option.value, label: option.label, title: option.title }))}
            onChange={props.onRangeChange}
            size="sm"
          />
        </div>
      </header>

      {menuOpen ? (
        <div className="scrim" role="presentation" onClick={() => closeMenu(true)} />
      ) : null}

      <nav
        id="app-navigation"
        ref={navRef}
        className="sidebar"
        data-open={menuOpen}
        aria-label="Pages"
        {...(narrow && !menuOpen ? { inert: true } : {})}
      >
        <p className="nav-heading">Usage</p>
        {NAV_ITEMS.map((item) => {
          const active = activeName === item.name;
          return (
            <a
              key={item.name}
              className="nav-row"
              href={buildHash({ name: item.name, sessionId: null, query: carried })}
              data-active={active}
              aria-current={active ? 'page' : undefined}
              onClick={() => setMenuOpen(false)}
            >
              <span className="nav-icon" aria-hidden="true">
                {item.icon}
              </span>
              <span>{item.label}</span>
            </a>
          );
        })}
        <p className="nav-foot dim">
          Range: <strong>{rangeLabel(props.rangeKey)}</strong>. Values update when you press Refresh.
        </p>
      </nav>

      <main className="content" id="main-content" tabIndex={-1}>
        {props.children}
      </main>
    </div>
  );
}
