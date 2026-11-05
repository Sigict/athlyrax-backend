// Coaching Software commercial rules: tiers, swimmer-capacity blocks and the Stopwatch entitlement
// that every paid coaching tier includes. Pure functions only, so every rule is unit-tested.

export const COACHING_PLAN_RULES = Object.freeze({
	'tier-1': Object.freeze({ label: 'Tier 1 — Small Club', amountMinor: 1500, maxSwimmers: 24, stopwatch: Object.freeze({ lanes: 3, assistants: 0 }) }),
	'tier-2': Object.freeze({ label: 'Tier 2 — Medium Club', amountMinor: 3500, maxSwimmers: 100, stopwatch: Object.freeze({ lanes: 3, assistants: 0 }) }),
	'tier-3': Object.freeze({ label: 'Tier 3 — Club', amountMinor: 9000, maxSwimmers: 200, stopwatch: Object.freeze({ lanes: 10, assistants: 5 }) }),
});

export const CAPACITY_ADDON_RULES = Object.freeze({
	'extra-25-swimmers': Object.freeze({ label: 'Additional 25 swimmers', swimmers: 25, amountMinor: 1000, priceEnv: 'STRIPE_PRICE_ADDON_25_SWIMMERS' }),
	'extra-50-swimmers': Object.freeze({ label: 'Additional 50 swimmers', swimmers: 50, amountMinor: 1500, priceEnv: 'STRIPE_PRICE_ADDON_50_SWIMMERS' }),
});

// The most blocks of one size a single checkout or subscription may carry. Generous, but it stops
// a typo (e.g. 500 instead of 5) turning into a large recurring charge.
export const MAX_ADDON_QUANTITY = 40;

export const PAID_STATUSES = new Set(['active', 'trialing']);

// Free Stopwatch: the standalone free tier. Used whenever no paid coaching tier is in force.
export const FREE_STOPWATCH = Object.freeze({ lanes: 1, assistants: 0 });

function text(value) {
	return String(value ?? '').trim();
}

function quantityOf(value) {
	const parsed = Number(value);
	return Number.isInteger(parsed) && parsed > 0 ? parsed : 0;
}

/**
 * Reads every subscription item (not just the first) and separates the base plan from capacity add-ons.
 * planByPrice / addonByPrice map Stripe price ids to rule keys.
 */
export function resolveSubscriptionComposition(subscription, { planByPrice, addonByPrice }) {
	const items = Array.isArray(subscription?.items?.data) ? subscription.items.data : [];
	let planKey = '';
	let priceId = '';
	const addons = {};
	const unknownPriceIds = [];
	for (const item of items) {
		const id = text(item?.price?.id);
		if (!id) continue;
		if (planByPrice.has(id)) {
			if (!planKey) {
				planKey = planByPrice.get(id);
				priceId = id;
			}
			continue;
		}
		if (addonByPrice.has(id)) {
			const key = addonByPrice.get(id);
			addons[key] = (addons[key] || 0) + Math.max(1, quantityOf(item?.quantity));
			continue;
		}
		unknownPriceIds.push(id);
	}
	return { planKey, priceId, addons, unknownPriceIds };
}

/** Base tier capacity plus every purchased block. No Enterprise tier, no surcharge above 300. */
export function computeSwimmerCapacity(planKey, addons = {}, planRules = COACHING_PLAN_RULES) {
	const plan = planRules[text(planKey)];
	if (!plan) return null;
	let extra = 0;
	for (const [key, qty] of Object.entries(addons || {})) {
		const rule = CAPACITY_ADDON_RULES[key];
		if (rule) extra += rule.swimmers * quantityOf(qty);
	}
	return plan.maxSwimmers + extra;
}

/** Monthly total in pence for a tier plus blocks (used for display and tests; Stripe remains the charge authority). */
export function computeMonthlyAmountMinor(planKey, addons = {}) {
	const plan = COACHING_PLAN_RULES[text(planKey)];
	if (!plan) return null;
	let total = plan.amountMinor;
	for (const [key, qty] of Object.entries(addons || {})) {
		const rule = CAPACITY_ADDON_RULES[key];
		if (rule) total += rule.amountMinor * quantityOf(qty);
	}
	return total;
}

/** Stopwatch entitlement included with a coaching subscription; never a second charge. */
export function stopwatchEntitlement({ planKey, status, isPrimaryOwner = false } = {}) {
	if (isPrimaryOwner) return { source: 'owner', lanes: 10, assistants: 5, included: true };
	const plan = COACHING_PLAN_RULES[text(planKey)];
	if (plan && PAID_STATUSES.has(text(status).toLowerCase())) {
		return { source: 'coaching-subscription', planKey: text(planKey), lanes: plan.stopwatch.lanes, assistants: plan.stopwatch.assistants, included: true };
	}
	return { source: 'free', lanes: FREE_STOPWATCH.lanes, assistants: FREE_STOPWATCH.assistants, included: false };
}

/**
 * Validates a checkout request for add-on blocks. Returns { ok, lineItems, error }.
 * addonPriceIds maps rule key -> configured Stripe price id.
 */
export function buildAddonLineItems(requested, addonPriceIds) {
	const lineItems = [];
	if (requested === undefined || requested === null) return { ok: true, lineItems };
	if (typeof requested !== 'object' || Array.isArray(requested)) return { ok: false, error: 'Add-ons must be an object of { addonKey: quantity }.' };
	for (const [key, raw] of Object.entries(requested)) {
		if (!CAPACITY_ADDON_RULES[key]) return { ok: false, error: `Unknown add-on: ${key}.` };
		const qty = Number(raw);
		if (!Number.isInteger(qty) || qty < 0 || qty > MAX_ADDON_QUANTITY) return { ok: false, error: `Add-on quantity for ${key} must be a whole number from 0 to ${MAX_ADDON_QUANTITY}.` };
		if (qty === 0) continue;
		const price = text(addonPriceIds?.[key]);
		if (!price) return { ok: false, error: `Add-on ${key} is not configured for sale.` };
		lineItems.push({ price, quantity: qty });
	}
	return { ok: true, lineItems };
}

function isActiveSwimmerRow(row) {
	if (!row || typeof row !== 'object') return false;
	if (row.deleted === true || row.isDeleted === true || text(row.deletedAt)) return false;
	if (row.archived === true || row.isArchived === true || text(row.archivedAt)) return false;
	// Disconnected swimmer archives are stored as active: false (coach-link reconnect flow).
	if (row.active === false) return false;
	const status = text(row.status).toLowerCase();
	if (status === 'archived' || status === 'inactive' || status === 'deleted' || status === 'left') return false;
	return true;
}

export function countActiveSwimmers(db) {
	const rows = Array.isArray(db?.swimmers) ? db.swimmers : [];
	const ids = new Set();
	let anonymous = 0;
	for (const row of rows) {
		if (!isActiveSwimmerRow(row)) continue;
		const id = text(row.id);
		if (id) ids.add(id);
		else anonymous += 1;
	}
	return ids.size + anonymous;
}

/**
 * Capacity guard for a whole-database save. It only refuses saves that ADD active swimmers beyond
 * the paid capacity, so a club already over its limit (e.g. after a downgrade) can still edit,
 * record results and archive swimmers. Existing data is never blocked or removed.
 */
export function checkSwimmerCapacity({ existingDb, nextDb, capacity }) {
	if (capacity === null || capacity === undefined) return { ok: true };
	const before = countActiveSwimmers(existingDb);
	const after = countActiveSwimmers(nextDb);
	if (after <= capacity || after <= before) return { ok: true, before, after, capacity };
	return { ok: false, before, after, capacity, error: `This subscription allows ${capacity} active swimmers. Add a 25 or 50 swimmer block, or archive swimmers, before adding more.` };
}
