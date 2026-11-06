import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync('index.js', 'utf8');
const start = source.indexOf("app.post('/billing/checkout-session'");
const route = source.slice(start, source.indexOf('\napp.', start + 1));

test('checkout replaces a stored Stripe customer that does not exist in the configured account', () => {
	assert.ok(route.includes('ATHLYRAX_CHECKOUT_STALE_CUSTOMER'));
	const retrieve = route.indexOf('stripeClient.customers.retrieve(customerId)');
	const create = route.indexOf('stripeClient.customers.create(');
	assert.ok(retrieve > 0 && create > retrieve, 'the stored customer is checked before a new one is created');
	assert.match(route, /resource_missing/);
	assert.match(route, /existing\.deleted/);
	// Other Stripe errors still fail the checkout (no silent new customer on outages).
	assert.match(route, /else throw error;/);
});
