/**
 * Page header: title, one-line description, and page-level actions.
 *
 * Plan references: §6 "Keep accounting rules and technical explanations in
 * maintainer documentation; use concise labels". Descriptions here describe what
 * the page shows, not how the numbers are computed.
 */

import type { ReactNode } from 'react';

export interface PageHeaderProps {
  title: string;
  description: ReactNode;
  actions?: ReactNode;
}

export function PageHeader(props: PageHeaderProps): React.ReactElement {
  return (
    <header className="page-header">
      <div className="page-titles">
        <h1 className="page-title">{props.title}</h1>
        <p className="page-desc">{props.description}</p>
      </div>
      {props.actions === undefined ? null : <div className="page-actions">{props.actions}</div>}
    </header>
  );
}

/** Filter chip with a clear control, so an applied filter is never invisible. */
export function FilterChip(props: { label: string; value: string; onClear: () => void }): React.ReactElement {
  return (
    <span className="filter-chip">
      <span className="dim">{props.label}</span>
      <strong>{props.value}</strong>
      <button type="button" className="filter-clear" onClick={props.onClear} aria-label={`Clear ${props.label} filter`}>
        ×
      </button>
    </span>
  );
}
