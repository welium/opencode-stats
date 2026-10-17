import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { estimateCost, parseCatalog } from '../src/server/pricing.ts';
import type { StepRow } from '../src/server/metrics.ts';

function step(overrides: Partial<StepRow> = {}): StepRow {
  return { id: 'a', sessionId: 's', seq: 1, timeCreated: 1, projectId: 'p', unreadable: false,
    cost: 77, input: 600, output: 200, reasoning: 50, cacheRead: 300, cacheWrite: 100,
    provider: 'provider', model: 'model', agent: 'build', hasError: false, ...overrides };
}

function catalog(cost: unknown) {
  return parseCatalog(JSON.stringify({ updatedAt: 1_700_000_000_000, digest: 'test', body: JSON.stringify({ provider: { id: 'provider', models: { model: { id: 'model', cost } } } }) }));
}
const rates = { input: 2, output: 8, cache_read: 0.5, cache_write: 3 };
const zero = { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 };

describe('offline estimates', () => {
  it('prices disjoint input, visible output + reasoning, and both cache categories by hand', () => {
    const original = step();
    const result = estimateCost([original], catalog(rates));
    // (600*2 + 250*8 + 300*0.5 + 100*3) / 1e6 = .00365
    assert.equal(result.cost, 0.00365);
    assert.equal(result.status, 'complete');
    assert.equal(result.pricedSteps, 1);
    assert.equal(result.catalog.updatedAt, '2023-11-14T22:13:20.000Z');
    assert.equal(original.cost, 77);
  });

  it('keeps explicit free rates, requires no rates for zero categories, and does not default missing positive rates', () => {
    assert.equal(estimateCost([step()], catalog({ input: 0, output: 0, cache_read: 0, cache_write: 0 })).cost, 0);
    assert.equal(estimateCost([step(zero)], catalog({})).cost, 0);
    assert.equal(estimateCost([step(zero)], catalog(undefined)).cost, 0);
    assert.equal(estimateCost([step({ ...zero, reasoning: 10 })], catalog({})).unpricedByReason['missing-rate'], 1);
    assert.equal(estimateCost([step(zero)], catalog({ input: -1 })).status, 'unavailable');
    assert.equal(estimateCost([step({ ...zero, output: 10 })], catalog({ output: 4 })).cost, 0.00004);
    const missing = estimateCost([step()], catalog({ input: 2, output: 8, cache_read: 0.5 }));
    assert.equal(missing.status, 'unavailable');
    assert.equal(missing.unpricedByReason['missing-rate'], 1);
  });

  it('uses strict full-context tier boundaries including cache writes and the highest tier', () => {
    const pricing = catalog({ input: 1, tiers: [
      { tier: { type: 'context', size: 1000 }, input: 2, cache_read: 2, cache_write: 2 },
      { tier: { type: 'context', size: 2000 }, input: 4, cache_read: 4, cache_write: 4 },
    ] });
    assert.equal(estimateCost([step({ ...zero, input: 1000 })], pricing).cost, .001);
    assert.equal(estimateCost([step({ ...zero, input: 1001 })], pricing).cost, .002002);
    assert.equal(estimateCost([step({ ...zero, input: 2000 })], pricing).cost, .004);
    assert.equal(estimateCost([step({ ...zero, input: 2001 })], pricing).cost, .008004);
    assert.equal(estimateCost([step({ ...zero, input: 500, cacheRead: 300, cacheWrite: 201 })], pricing).cost, .002002);
  });

  it('ignores legacy context_over_200k instead of inventing prices', () => {
    const pricing = catalog({ input: 1, context_over_200k: { input: 99 } });
    assert.equal(estimateCost([step({ ...zero, input: 300_000 })], pricing).cost, .3);
  });

  it('never aliases a provider or a conflicting catalog identity', () => {
    const pricing = catalog(rates);
    for (const overrides of [{ provider: 'other' }, { provider: null }, { model: null }, { model: 'other' }]) {
      assert.equal(estimateCost([step(overrides)], pricing).unpricedByReason['no-model-price'], 1);
    }
    const conflicting = parseCatalog(JSON.stringify({ updatedAt: 0, body: JSON.stringify({ provider: { id: 'other', models: { model: { id: 'model', cost: rates } } } }) }));
    assert.equal(estimateCost([step()], conflicting).status, 'unavailable');
  });

  it('reports partial subtotal, unpriced steps/models and missing-token coverage without modifying cost', () => {
    const result = estimateCost([step(), step({ model: 'unknown' }), step({ input: null }), step({ reasoning: -1 })], catalog(rates));
    assert.equal(result.status, 'partial');
    assert.equal(result.cost, .00365);
    assert.equal(result.pricedSteps, 1);
    assert.equal(result.unpricedSteps, 3);
    assert.equal(result.unpricedByReason['missing-tokens'], 2);
    assert.deepEqual(result.unpricedModels, [{ provider: 'provider', model: 'model', steps: 2 }, { provider: 'provider', model: 'unknown', steps: 1 }]);
  });

  it('bounds unpriced identity metadata', () => {
    const result = estimateCost(Array.from({ length: 70 }, (_, i) => step({ model: `unknown-${i}` })), catalog(rates));
    assert.equal(result.unpricedModels.length, 50);
    assert.equal(result.unpricedModelsTruncated, true);
  });

  it('missing or malformed optional catalogs disable only estimates', () => {
    for (const raw of [null, '', '{', '[]', '{}', JSON.stringify({ updatedAt: 0, body: {} }), JSON.stringify({ updatedAt: 'bad', body: '{}' }), JSON.stringify({ updatedAt: 0, body: '[]' }), JSON.stringify({ updatedAt: 0, body: '{' })]) {
      const pricing = parseCatalog(raw);
      assert.equal(pricing.meta.available, false);
      assert.equal(estimateCost([step()], pricing).cost, null);
    }
  });

  it('rejects negative, nonfinite, null and nonnumeric applicable rates', () => {
    for (const input of [-1, null, '2', true]) {
      assert.equal(estimateCost([step()], catalog({ ...rates, input })).status, 'unavailable');
    }
    // JSON syntax permits exponents that overflow JS numbers.
    const raw = JSON.stringify({ updatedAt: 0, body: '{"provider":{"id":"provider","models":{"model":{"id":"model","cost":{"input":1e999}}}}}' });
    assert.equal(estimateCost([step({ ...zero, input: 1 })], parseCatalog(raw)).status, 'unavailable');
  });

  it('rejects ambiguous/invalid applicable tiers and does not inherit missing tier rates', () => {
    const first = { tier: { type: 'context', size: 10 }, ...rates };
    for (const tiers of [[first, first], [{ ...first, tier: { type: 'context', size: -1 } }], [{ ...first, input: -1 }], [{ tier: { type: 'context', size: 10 } }], {}, [null]]) {
      assert.equal(estimateCost([step()], catalog({ ...rates, tiers })).status, 'unavailable');
    }
    assert.equal(estimateCost([step({ ...zero, input: 10 })], catalog({ input: 1, tiers: [first, first] })).cost, .00001);
    assert.equal(estimateCost([step()], catalog({ ...rates, tiers: [{ ...first, input: -1 }, { ...first, tier: { type: 'context', size: 20 } }] })).status, 'unavailable');
  });
});
