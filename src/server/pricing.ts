/** Offline pricing only. Read afresh inside the statistics request transaction. */
import type { CostEstimate, EstimateUnpricedReason, PricingCatalogMeta } from '../shared/api.ts';
import type { QueryRunner, StepRow } from './metrics.ts';

type ObjectValue = Record<string, unknown>;
export interface PricingCatalog {
  meta: PricingCatalogMeta;
  providers: ObjectValue | null;
}

function object(value: unknown): ObjectValue | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as ObjectValue : null;
}

function own(value: ObjectValue | null, key: string): unknown {
  return value !== null && Object.hasOwn(value, key) ? value[key] : undefined;
}

export function parseCatalog(raw: unknown): PricingCatalog {
  const unavailable: PricingCatalog = { meta: { available: false, updatedAt: null, digest: null }, providers: null };
  if (typeof raw !== 'string') return unavailable;
  try {
    const envelope = object(JSON.parse(raw));
    if (envelope === null || typeof envelope['body'] !== 'string') return unavailable;
    const providers = object(JSON.parse(envelope['body']));
    const timestamp = envelope['updatedAt'];
    if (providers === null || typeof timestamp !== 'number' || !Number.isFinite(timestamp) || !Number.isFinite(new Date(timestamp).getTime())) return unavailable;
    return {
      providers,
      // A digest is not returned: its contents are arbitrary local catalog data.
      meta: { available: true, updatedAt: new Date(timestamp).toISOString(), digest: null },
    };
  } catch {
    return unavailable;
  }
}

export function loadPricingCatalog(runner: QueryRunner): PricingCatalog {
  const table = runner.get<{ name: string }>("SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'kv'");
  if (table === undefined) return parseCatalog(null);
  const columns = runner.all<{ name: string }>('PRAGMA table_info(kv)');
  if (!columns.some((column) => column.name === 'key') || !columns.some((column) => column.name === 'value')) return parseCatalog(null);
  const row = runner.get<{ value: unknown }>('SELECT value FROM kv WHERE key = ?', ['models-dev:catalog']);
  return parseCatalog(row?.value);
}

function priceStep(step: StepRow, catalog: PricingCatalog): number | EstimateUnpricedReason {
  const tokens = [step.input, step.output, step.reasoning, step.cacheRead, step.cacheWrite];
  if (tokens.some((value) => value === null || !Number.isFinite(value) || value < 0)) return 'missing-tokens';
  if (step.provider === null || step.model === null) return 'no-model-price';
  const provider = object(own(catalog.providers, step.provider));
  const model = object(own(object(provider?.['models']), step.model));
  // Keys are the canonical identity. Conflicting explicit IDs are not aliases.
  if (provider?.['id'] !== step.provider || model?.['id'] !== step.model) return 'no-model-price';
  const base = model['cost'] === undefined ? {} : object(model['cost']);
  if (base === null) return 'no-model-price';
  const input = step.input!;
  const output = step.output! + step.reasoning!;
  const read = step.cacheRead!;
  const write = step.cacheWrite!;
  const context = input + read + write;
  if (!Number.isFinite(context) || !Number.isFinite(output)) return 'missing-tokens';
  let rates = base;
  let threshold = -1;
  const seen = new Set<number>();
  const tiers = base['tiers'];
  if (tiers !== undefined) {
    if (!Array.isArray(tiers)) return 'ambiguous-tier';
    for (const item of tiers) {
      const candidate = object(item);
      const tier = object(candidate?.['tier']);
      const size = tier?.['size'];
      if (candidate === null || tier?.['type'] !== 'context' || typeof size !== 'number' || !Number.isFinite(size) || size < 0) return 'ambiguous-tier';
      if (size >= context) continue;
      for (const name of ['input', 'output', 'cache_read', 'cache_write']) {
        const rate = candidate[name];
        if (rate !== undefined && (typeof rate !== 'number' || !Number.isFinite(rate) || rate < 0)) return 'missing-rate';
      }
      if (seen.has(size)) return 'ambiguous-tier';
      seen.add(size);
      if (size > threshold) { rates = candidate; threshold = size; }
    }
  }
  const categories = [[input, 'input'], [output, 'output'], [read, 'cache_read'], [write, 'cache_write']] as const;
  let total = 0;
  for (const [count, name] of categories) {
    const rate = rates[name];
    // An explicit invalid rate is rejected even when this category has no tokens.
    if (rate !== undefined && (typeof rate !== 'number' || !Number.isFinite(rate) || rate < 0)) return 'missing-rate';
    if (count === 0) continue;
    if (typeof rate !== 'number') return 'missing-rate';
    total += count * rate;
  }
  return Number.isFinite(total) ? total / 1_000_000 : 'missing-rate';
}

export function estimateCost(steps: readonly StepRow[], catalog: PricingCatalog): CostEstimate {
  let cost = 0;
  let pricedSteps = 0;
  const reasons: CostEstimate['unpricedByReason'] = { 'no-model-price': 0, 'missing-tokens': 0, 'missing-rate': 0, 'ambiguous-tier': 0 };
  const models = new Map<string, { provider: string | null; model: string | null; steps: number }>();
  for (const step of steps) {
    const price = priceStep(step, catalog);
    if (typeof price === 'number' && Number.isFinite(cost + price)) { cost += price; pricedSteps++; continue; }
    reasons[typeof price === 'number' ? 'missing-rate' : price]++;
    const key = JSON.stringify([step.provider, step.model]);
    const entry = models.get(key) ?? { provider: step.provider, model: step.model, steps: 0 };
    entry.steps++;
    models.set(key, entry);
  }
  const unpricedModels = [...models.values()].sort((a, b) => b.steps - a.steps || JSON.stringify([a.provider, a.model]).localeCompare(JSON.stringify([b.provider, b.model])));
  const available = catalog.meta.available && (pricedSteps > 0 || steps.length === 0);
  return {
    status: !available ? 'unavailable' : pricedSteps === steps.length ? 'complete' : 'partial',
    cost: available ? cost : null,
    steps: steps.length, pricedSteps, unpricedSteps: steps.length - pricedSteps,
    unpricedByReason: reasons, unpricedModels: unpricedModels.slice(0, 50), unpricedModelsTruncated: unpricedModels.length > 50,
    catalog: catalog.meta,
  };
}
