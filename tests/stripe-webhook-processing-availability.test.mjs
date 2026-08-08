import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const source = fs.readFileSync(path.resolve('index.js'), 'utf8');

function webhookRoute() {
  const start = source.indexOf("app.post('/billing/webhook'");
  assert.ok(start >= 0, 'Stripe webhook route is missing.');
  const next = source.indexOf('\napp.', start + 1);
  return source.slice(start, next >= 0 ? next : source.length);
}

test('production does not acknowledge Stripe webhooks that cannot be processed', () => {
  const route = webhookRoute();
  assert.ok(route.includes('ATHLYRAX_STRIPE_WEBHOOK_PROCESSING_AVAILABLE'));
  assert.ok(route.includes("res.status(503).json({ error: 'Stripe webhook processing is temporarily unavailable.' });"));
  assert.ok(route.includes("res.status(200).json({ ok: true, skipped: 'stripe_not_configured' });"), 'Development skip behavior should remain available.');
  const unavailableIndex = route.indexOf('if (!stripeClient) {');
  const productionIndex = route.indexOf('if (IS_PRODUCTION) {', unavailableIndex);
  const status503Index = route.indexOf('res.status(503)', productionIndex);
  const skipped200Index = route.indexOf("skipped: 'stripe_not_configured'", unavailableIndex);
  assert.ok(unavailableIndex >= 0 && productionIndex > unavailableIndex && status503Index > productionIndex && skipped200Index > status503Index,
    'Production 503 must be evaluated before the development 200 skip response.');
});
