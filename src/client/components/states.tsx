/**
 * Route-level states and the generic query panel.
 *
 * Plan references: §6 "Loading, empty-range, unavailable-database, and
 * request-error states are distinct." Each state has its own icon, heading, and
 * tone so the four conditions are distinguishable without reading the message,
 * and none of them is color-only. An unavailable database keeps the shell and a
 * retry action available rather than looking like an empty history (§3).
 */

import type { ReactNode } from 'react';

import type { QueryState } from '../useQuery.ts';

import { DatabaseIcon, InboxIcon, RefreshIcon, WarningIcon } from './icons.tsx';

function StateBlock(props: {
  variant: 'empty' | 'unavailable' | 'error';
  icon: ReactNode;
  title: string;
  message: ReactNode;
  action?: ReactNode;
}): React.ReactElement {
  return (
    <div className="state" data-variant={props.variant} role={props.variant === 'empty' ? undefined : 'alert'}>
      <span className="state-icon" aria-hidden="true">
        {props.icon}
      </span>
      <div className="state-text">
        <p className="state-title">{props.title}</p>
        <p className="state-message">{props.message}</p>
      </div>
      {props.action === undefined ? null : <div className="state-action">{props.action}</div>}
    </div>
  );
}

export function RetryButton(props: { onRetry: () => void; label?: string }): React.ReactElement {
  return (
    <button type="button" className="btn" onClick={props.onRetry}>
      <RefreshIcon size={14} />
      {props.label ?? 'Try again'}
    </button>
  );
}

export function LoadingState(props: { label?: string }): React.ReactElement {
  return (
    <div className="loading" role="status">
      <span className="skeleton skeleton-line" />
      <span className="skeleton skeleton-line short" />
      <span className="visually-hidden">{props.label ?? 'Loading statistics'}</span>
    </div>
  );
}

export interface QueryPanelProps<T> {
  state: QueryState<T>;
  onRetry: () => void;
  /** True when the response is a legitimate empty range rather than an error. */
  isEmpty: (data: T) => boolean;
  empty: { title: string; message: ReactNode };
  children: (data: T) => ReactNode;
}

export function QueryPanel<T>(props: QueryPanelProps<T>): React.ReactElement {
  const { state } = props;

  if (state.status === 'loading') return <LoadingState />;

  if (state.status === 'error' && state.error !== null) {
    if (state.error.kind === 'unavailable') {
      return (
        <StateBlock
          variant="unavailable"
          icon={<DatabaseIcon size={22} />}
          title="Database unavailable"
          message={state.error.message}
          action={<RetryButton onRetry={props.onRetry} label="Retry" />}
        />
      );
    }
    return (
      <StateBlock
        variant="error"
        icon={<WarningIcon size={22} />}
        title="Request failed"
        message={state.error.message}
        action={<RetryButton onRetry={props.onRetry} />}
      />
    );
  }

  if (state.data === null) return <LoadingState />;

  if (props.isEmpty(state.data)) {
    return (
      <StateBlock
        variant="empty"
        icon={<InboxIcon size={22} />}
        title={props.empty.title}
        message={props.empty.message}
      />
    );
  }

  return <>{props.children(state.data)}</>;
}
