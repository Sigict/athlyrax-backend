import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { ATHLETE_PLAN_RULES, athletePlanCatalogue, athleteEntitlement } from '../athlete-plans.mjs';

test('item 27: athlete plans are planned prices only (£4.99 / £8.99), never on sale, no Stripe product', () => {
  assert.equal(ATHLETE_PLAN_RULES.athlete.amountMinor, 499);
  assert.equal(ATHLETE_PLAN_RULES['athlete-parent'].amountMinor, 899);
  for (const p of athletePlanCatalogue()) {
    assert.equal(p.onSale, false); assert.equal(p.stripeProduct, null); assert.equal(p.status, 'planned');
    assert.equal(p.interval, 'not decided', 'billing interval is an owner decision, not assumed');
  }
});

test('item 27: current Athlete App access is unchanged while the plans are not on sale', () => {
  assert.deepEqual(athleteEntitlement().access, 'included');
  assert.equal(athleteEntitlement().paidPlan, null);
});

test('item 27: no Stripe call, price id or checkout exists for athlete plans', () => {
  const source = fs.readFileSync(new URL('../athlete-plans.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /stripe\.(products|prices|checkout)|price_[A-Za-z0-9]|STRIPE_PRICE_ATHLETE/);
  const index = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8');
  assert.doesNotMatch(index, /STRIPE_PRICE_ATHLETE|athlete-plans\/checkout|athletePlanCheckout/);
});
