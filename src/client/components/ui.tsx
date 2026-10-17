/**
 * Small presentational primitives shared by every page.
 *
 * Plan references: §6 "compact KPI grid", "dense but readable tables",
 * "tabular numerals", "sorted where useful", "visible focus, labeled controls,
 * keyboard navigation", and "Do not rely on color/hover alone" — every value is
 * also present as text, and the segmented control is a real radio group so
 * arrow-key selection and screen-reader semantics come from the platform.
 */

import { useId } from 'react';
import type { ReactNode } from 'react';

import type { FormattedValue } from '../format.ts';

import { PARTIAL_TOTAL_HINT, UNAVAILABLE } from '../format.ts';
import { SortIcon } from './icons.tsx';

export interface CardProps {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  /** Let a table bleed to the card edge. */
  flush?: boolean;
  id?: string;
}

export function Card(props: CardProps): React.ReactElement {
  const generatedId = useId();
  const titleId = `${props.id ?? generatedId}-title`;
  return (
    <section className="card" aria-labelledby={titleId}>
      <div className="card-head">
        <div className="card-titles">
          <h2 className="card-title" id={titleId}>
            {props.title}
          </h2>
          {props.description === undefined ? null : <p className="card-desc">{props.description}</p>}
        </div>
        {props.actions === undefined ? null : <div className="card-actions">{props.actions}</div>}
      </div>
      <div className="card-body" data-flush={props.flush === true}>{props.children}</div>
    </section>
  );
}

export interface StatProps {
  label: string;
  value: string;
  hint?: string;
  /** Extra explanation for the value, exposed as a tooltip and to assistive tech. */
  title?: string;
  /** Marks a value that only partly covers the counted rows. */
  partial?: boolean;
}

export function Stat(props: StatProps): React.ReactElement {
  const unavailable = props.value === UNAVAILABLE;
  const title = props.title ?? (props.partial ? PARTIAL_TOTAL_HINT : undefined);
  return (
    <div className="stat">
      <span className="stat-label">{props.label}</span>
      <span
        className="stat-value"
        data-unavailable={unavailable}
        {...(title === undefined ? {} : { title, 'aria-label': `${props.label}: ${props.value}${props.partial ? ' (measured subtotal)' : ''}` })}
      >
        {props.value}
        {props.partial ? <span className="partial-mark" aria-hidden="true">*</span> : null}
      </span>
      {props.hint === undefined ? null : <span className="stat-hint">{props.hint}</span>}
    </div>
  );
}

/** A value cell for a tables: `—` when unavailable, `≥` when partial. */
export function ValueCell(props: { value: FormattedValue; className?: string }): React.ReactElement {
  const unavailable = props.value.text === UNAVAILABLE;
  return (
    <span
      className={`num ${props.className ?? ''}`.trim()}
      data-unavailable={unavailable}
      {...(props.value.partial
        ? { title: 'Measured subtotal: some steps report no value for this metric' }
        : {})}
    >
      {props.value.text}
      {props.value.partial ? <span className="partial-mark" aria-hidden="true">*</span> : null}
    </span>
  );
}

export type BadgeTone = 'neutral' | 'ok' | 'warn' | 'bad' | 'accent';

export function Badge(props: { tone?: BadgeTone; children: ReactNode; mono?: boolean }): React.ReactElement {
  return (
    <span className="badge" data-tone={props.tone ?? 'neutral'} data-mono={props.mono === true}>
      {props.children}
    </span>
  );
}

export interface SegmentedOption<T extends string> {
  value: T;
  label: string;
  title?: string;
}

export interface SegmentedProps<T extends string> {
  /** Radio group name; unique per control instance. */
  name: string;
  label: string;
  value: T;
  options: readonly SegmentedOption<T>[];
  onChange: (value: T) => void;
  size?: 'sm' | 'md';
}

/**
 * Segmented control built on native radio inputs: arrow keys move and select,
 * `aria-checked` is implicit, and the label text is always visible (state never
 * depends on color alone).
 */
export function Segmented<T extends string>(props: SegmentedProps<T>): React.ReactElement {
  return (
    <div className="segmented" role="radiogroup" aria-label={props.label} data-size={props.size ?? 'md'}>
      {props.options.map((option) => (
        <label
          key={option.value}
          className="segmented-option"
          data-active={option.value === props.value}
          {...(option.title === undefined ? {} : { title: option.title })}
        >
          <input
            type="radio"
            name={props.name}
            value={option.value}
            checked={option.value === props.value}
            onChange={() => props.onChange(option.value)}
          />
          <span>{option.label}</span>
        </label>
      ))}
    </div>
  );
}

export interface SortHeaderProps {
  label: string;
  sortKey: string;
  active: boolean;
  direction: 'asc' | 'desc';
  align?: 'left' | 'right';
  onSort: (sortKey: string) => void;
}

export function SortHeader(props: SortHeaderProps): React.ReactElement {
  const ariaSort = props.active ? (props.direction === 'asc' ? 'ascending' : 'descending') : 'none';
  return (
    <th scope="col" aria-sort={ariaSort} data-align={props.align ?? 'left'}>
      <button type="button" className="th-sort" onClick={() => props.onSort(props.sortKey)}>
        <span>{props.label}</span>
        <SortIcon direction={props.active ? props.direction : null} />
      </button>
    </th>
  );
}

/** Column metadata for a sortable header row. */
export interface ColumnSpec {
  key: string;
  label: string;
  align?: 'left' | 'right';
  /** Direction applied when this column becomes the active sort. */
  initialDir?: 'asc' | 'desc';
}

/** Render a `<tr>` of sortable headers from column metadata. */
export function SortRow(props: {
  columns: readonly ColumnSpec[];
  sort: { key: string; dir: 'asc' | 'desc' };
  onToggle: (key: string, initialDir?: 'asc' | 'desc') => void;
}): React.ReactElement {
  return (
    <tr>
      {props.columns.map((column) => (
        <SortHeader
          key={column.key}
          label={column.label}
          sortKey={column.key}
          {...(column.align === undefined ? {} : { align: column.align })}
          active={props.sort.key === column.key}
          direction={props.sort.dir}
          onSort={(key) => props.onToggle(key, column.initialDir)}
        />
      ))}
    </tr>
  );
}

