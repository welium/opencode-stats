import type { CostEstimate } from '../../shared/api.ts';
import { formatCost, formatDateTime, formatInteger } from '../format.ts';

function unpricedLabel(steps: number): string {
  return `${formatInteger(steps)} unpriced ${steps === 1 ? 'step' : 'steps'}`;
}

/** Kept visually separate from recorded cost, with explicit subtotal status. */
export function EstimateValue({ estimate }: { estimate: CostEstimate | undefined }): React.ReactElement {
  const partial = estimate?.status === 'partial';
  const value = formatCost(estimate?.cost);
  const title = estimate === undefined ? undefined : `Recorded costs; API estimates only for steps recorded at $0. ${partial ? 'Partial subtotal' : estimate.status} · ${unpricedLabel(estimate.unpricedSteps)}${estimate.catalog.updatedAt === null ? '' : ` · Catalog ${formatDateTime(Date.parse(estimate.catalog.updatedAt))}`}`;
  return (
    <span className="num" title={title} aria-label={partial ? `${value} (partial subtotal)` : undefined}>
      {value}
      {partial ? <span className="partial-mark" aria-hidden="true">*</span> : null}
    </span>
  );
}

export function EstimateStat({ estimate }: { estimate: CostEstimate }): React.ReactElement {
  return <div className="stat">
    <span className="stat-label">Cost with estimates</span>
    <span className="stat-value">{formatCost(estimate.cost)}</span>
    <span className="stat-hint">Recorded costs; API estimates for $0 steps</span>
    <span className="stat-hint">{estimate.status === 'complete' ? 'Complete' : estimate.status === 'partial' ? 'Partial subtotal' : 'Unavailable'}{estimate.unpricedSteps > 0 ? ` · ${unpricedLabel(estimate.unpricedSteps)}` : ''}</span>
    {estimate.catalog.updatedAt === null ? null : <span className="stat-hint">Catalog {formatDateTime(Date.parse(estimate.catalog.updatedAt))}</span>}
  </div>;
}
