import test from 'node:test';
import assert from 'node:assert/strict';
import {
	COACHING_PLAN_RULES, CAPACITY_ADDON_RULES, resolveSubscriptionComposition, computeSwimmerCapacity,
	computeMonthlyAmountMinor, stopwatchEntitlement, buildAddonLineItems, checkSwimmerCapacity, countActiveSwimmers,
} from '../coaching-billing.mjs';

test('published tier prices and caps match the catalogue', () => {
	assert.deepEqual(
		Object.fromEntries(Object.entries(COACHING_PLAN_RULES).map(([k, v]) => [k, [v.amountMinor, v.maxSwimmers]])),
		{ 'tier-1': [1500, 24], 'tier-2': [3500, 100], 'tier-3': [9000, 200] },
	);
	assert.equal(CAPACITY_ADDON_RULES['extra-25-swimmers'].amountMinor, 1000);
	assert.equal(CAPACITY_ADDON_RULES['extra-50-swimmers'].amountMinor, 1500);
});

test('capacity and monthly price for 200, 225, 250, 275, 300 and beyond, with mixed blocks', () => {
	const cases = [
		[{}, 200, 9000],
		[{ 'extra-25-swimmers': 1 }, 225, 10000],
		[{ 'extra-50-swimmers': 1 }, 250, 10500],
		[{ 'extra-25-swimmers': 1, 'extra-50-swimmers': 1 }, 275, 11500],
		[{ 'extra-50-swimmers': 2 }, 300, 12000],
		[{ 'extra-25-swimmers': 1, 'extra-50-swimmers': 2 }, 325, 13000],
		[{ 'extra-50-swimmers': 6 }, 500, 18000],
	];
	for (const [addons, capacity, amount] of cases) {
		assert.equal(computeSwimmerCapacity('tier-3', addons), capacity, JSON.stringify(addons));
		assert.equal(computeMonthlyAmountMinor('tier-3', addons), amount, JSON.stringify(addons));
	}
	// Blocks also extend the smaller tiers without changing their features.
	assert.equal(computeSwimmerCapacity('tier-1', { 'extra-25-swimmers': 2 }), 74);
	assert.equal(computeSwimmerCapacity('free', {}), null);
});

test('Stopwatch entitlement is included with each coaching tier and free otherwise', () => {
	assert.deepEqual([stopwatchEntitlement({ planKey: 'tier-1', status: 'active' }).lanes, stopwatchEntitlement({ planKey: 'tier-1', status: 'active' }).assistants], [3, 0]);
	assert.deepEqual([stopwatchEntitlement({ planKey: 'tier-2', status: 'trialing' }).lanes, stopwatchEntitlement({ planKey: 'tier-2', status: 'trialing' }).assistants], [3, 0]);
	const t3 = stopwatchEntitlement({ planKey: 'tier-3', status: 'active' });
	assert.equal(t3.lanes, 10);
	assert.ok(t3.assistants > 0);
	assert.equal(t3.included, true);
	for (const status of ['past_due', 'canceled', 'inactive', 'unpaid']) {
		const e = stopwatchEntitlement({ planKey: 'tier-3', status });
		assert.deepEqual([e.source, e.lanes, e.assistants], ['free', 1, 0], status);
	}
});

test('subscription parsing reads every item, so add-ons before the tier item are counted', () => {
	const planByPrice = new Map([['price_t3', 'tier-3']]);
	const addonByPrice = new Map([['price_a25', 'extra-25-swimmers'], ['price_a50', 'extra-50-swimmers']]);
	const parsed = resolveSubscriptionComposition({ items: { data: [
		{ price: { id: 'price_a50' }, quantity: 2 },
		{ price: { id: 'price_t3' }, quantity: 1 },
		{ price: { id: 'price_a25' }, quantity: 1 },
	] } }, { planByPrice, addonByPrice });
	assert.equal(parsed.planKey, 'tier-3');
	assert.deepEqual(parsed.addons, { 'extra-50-swimmers': 2, 'extra-25-swimmers': 1 });
	assert.equal(computeSwimmerCapacity(parsed.planKey, parsed.addons), 325);
});

test('checkout add-on requests are validated', () => {
	const ids = { 'extra-25-swimmers': 'price_a25', 'extra-50-swimmers': 'price_a50' };
	assert.deepEqual(buildAddonLineItems({ 'extra-25-swimmers': 1, 'extra-50-swimmers': 2 }, ids).lineItems,
		[{ price: 'price_a25', quantity: 1 }, { price: 'price_a50', quantity: 2 }]);
	assert.deepEqual(buildAddonLineItems(undefined, ids), { ok: true, lineItems: [] });
	assert.equal(buildAddonLineItems({ 'extra-25-swimmers': -1 }, ids).ok, false);
	assert.equal(buildAddonLineItems({ 'extra-25-swimmers': 1.5 }, ids).ok, false);
	assert.equal(buildAddonLineItems({ 'extra-25-swimmers': 41 }, ids).ok, false);
	assert.equal(buildAddonLineItems({ enterprise: 1 }, ids).ok, false);
	assert.equal(buildAddonLineItems({ 'extra-50-swimmers': 1 }, { 'extra-25-swimmers': 'price_a25' }).ok, false, 'unconfigured add-on refused');
});

test('capacity guard refuses only saves that add swimmers beyond capacity; existing data is never blocked', () => {
	const swimmers = (n, extra = {}) => ({ swimmers: Array.from({ length: n }, (_, i) => ({ id: `s${i}`, ...extra })) });
	assert.equal(checkSwimmerCapacity({ existingDb: swimmers(24), nextDb: swimmers(24), capacity: 24 }).ok, true);
	const refused = checkSwimmerCapacity({ existingDb: swimmers(24), nextDb: swimmers(25), capacity: 24 });
	assert.equal(refused.ok, false);
	assert.match(refused.error, /25 or 50 swimmer block/);
	// Over capacity after a downgrade: edits and removals still save.
	assert.equal(checkSwimmerCapacity({ existingDb: swimmers(120), nextDb: swimmers(120), capacity: 100 }).ok, true);
	assert.equal(checkSwimmerCapacity({ existingDb: swimmers(120), nextDb: swimmers(110), capacity: 100 }).ok, true);
	// Archived swimmers do not count.
	const db = swimmers(30);
	db.swimmers.slice(0, 6).forEach((row) => { row.archived = true; });
	assert.equal(countActiveSwimmers(db), 24);
	assert.equal(checkSwimmerCapacity({ existingDb: swimmers(0), nextDb: db, capacity: 24 }).ok, true);
	// Disconnected swimmer archives (active: false) do not count.
	const linked = swimmers(24);
	linked.swimmers.push({ id: 'gone', active: false });
	assert.equal(countActiveSwimmers(linked), 24);
	// No capacity in force (billing not enforced): never refused.
	assert.equal(checkSwimmerCapacity({ existingDb: swimmers(0), nextDb: swimmers(999), capacity: null }).ok, true);
});
