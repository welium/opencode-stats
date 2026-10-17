/**
 * Browser entry point: theme bootstrap, canonical hash, and mount.
 *
 * Plan references: §6 "Theme preference and range may be stored locally" and
 * "Hash navigation with back/forward support". Resolving the theme before the
 * React tree renders keeps the first paint in the right theme, and writing a
 * canonical fragment for an empty one means the address bar always shows the
 * page and range the dashboard is displaying.
 */

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './App.tsx';
import { DEFAULT_RANGE_KEY, isRangeKey } from './route.ts';
import { safeLocalStorage } from './storage.ts';
import { readRangePreference } from './theme.ts';
import { applyInitialTheme } from './useTheme.ts';
import './styles.css';

applyInitialTheme();

if (window.location.hash === '') {
  const stored = readRangePreference(safeLocalStorage());
  const range = isRangeKey(stored) ? stored : DEFAULT_RANGE_KEY;
  window.history.replaceState(null, '', `#/overview?range=${range}`);
}

const container = document.getElementById('root');
if (container === null) throw new Error('Missing #root element');

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
