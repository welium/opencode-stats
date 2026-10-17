import type { CostEstimate } from '../../shared/api.ts';
import { formatCost, formatDateTime, formatInteger } from '../format.ts';

function unpricedLabel(steps: number): string {
  return `${formatInteger(steps)} unpriced ${steps === 1 ? 'step' : 'steps'}`;
}

/** Kept visually separate from recorded cost, with explicit subtotal status. */
export function EstimateValue({ estimate }: { estimate: CostEstimate | undefined }): React.ReactElement {
  const title = estimate === undefined ? undefined : `${estimate.status} · ${unpricedLabel(estimate.unpricedSteps)}${estimate.catalog.updatedAt === null ? '' : ` · Catalog ${formatDateTime(Date.parse(estimate.catalog.updatedAt))}`}`;
  return <span className="num" title={title}>{formatCost(estimate?.cost)}{estimate?.status === 'partial' ? <span className="cell-secondary">Partial subtotal</span> : null}</span>;
}

export function EstimateStat({ estimate }: { estimate: CostEstimate }): React.ReactElement {
  return <div className="stat">
    <span className="stat-label">API-equivalent estimate</span>
    <span className="stat-value">{formatCost(estimate.cost)}</span>
    <span className="stat-hint">{estimate.status === 'complete' ? 'Complete' : estimate.status === 'partial' ? 'Partial subtotal' : 'Unavailable'}{estimate.unpricedSteps > 0 ? ` · ${unpricedLabel(estimate.unpricedSteps)}` : ''}</span>
    {estimate.catalog.updatedAt === null ? null : <span className="stat-hint">Catalog {formatDateTime(Date.parse(estimate.catalog.updatedAt))}</span>}
  </div>;
}
