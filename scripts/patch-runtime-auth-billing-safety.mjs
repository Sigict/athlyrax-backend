import fs from 'node:fs';
import path from 'node:path';

const indexPath = path.resolve('index.js');
let source = fs.readFileSync(indexPath, 'utf8').replace(/\r\n/g, '\n');

function replaceRequired(needle, replacement, label) {
  if (source.includes(replacement)) return;
  if (!source.includes(needle)) throw new Error(`${label} anchor was not found.`);
  source = source.replace(needle, replacement);
}

// Auth persistence is a normalization step, not a schema-destructive projection.
// Preserve account metadata that is not explicitly canonicalized, while always
// stripping a legacy plaintext password field and overwriting security-critical
// canonical fields with their normalized values.
const authPreserveNeedle = `\t\t\tconst passwordHash = fromHash || (fromPassword ? hashPassword(fromPassword) : '');\n\t\t\tif (!username || !passwordHash) return null;\n\t\t\treturn {\n\t\t\t\tusername,`;
const authPreserveReplacement = `\t\t\tconst passwordHash = fromHash || (fromPassword ? hashPassword(fromPassword) : '');\n\t\t\tif (!username || !passwordHash) return null;\n\t\t\tconst { password: _discardedPlaintextPassword, ...preservedRow } = row;\n\t\t\treturn {\n\t\t\t\t// ATHLYRAX_AUTH_ROW_METADATA_PRESERVED\n\t\t\t\t...preservedRow,\n\t\t\t\tusername,`;
replaceRequired(authPreserveNeedle, authPreserveReplacement, 'Auth row metadata preservation');

// Billing enforcement must have one source of truth: the persisted billing
// policy. Environment defaults only seed/validate the catalog; they must not
// disagree with the policy returned to clients and edited by the owner.
replaceRequired(
  `\tconst isBillingEnforced = isBillingEnabled && BILLING_ENFORCED;`,
  `\t// ATHLYRAX_BILLING_POLICY_SINGLE_SOURCE\n\tconst isBillingEnforced = isBillingEnabled && getBillingPolicy().enforceCharging;`,
  'Billing access policy source',
);
replaceRequired(
  `\tif (!BILLING_ENFORCED || !stripeClient) return next();`,
  `\tif (!stripeClient || !getBillingPolicy().enforceCharging) return next();`,
  'Billing write policy source',
);

// Never grant a known tier merely because Stripe reports an active status for
// an unknown/unconfigured price. A paid state is valid only when the price maps
// to a configured catalog plan.
replaceRequired(
  `\tif (String(subscription?.status || '').trim().toLowerCase() === 'active') {\n\t\treturn { planKey: 'tier-1', priceId: linePriceId };\n\t}\n\treturn { planKey: 'free', priceId: linePriceId };`,
  `\t// ATHLYRAX_UNKNOWN_STRIPE_PRICE_FAIL_CLOSED\n\treturn { planKey: linePriceId ? 'unrecognized' : 'free', priceId: linePriceId };`,
  'Unknown Stripe price handling',
);
replaceRequired(
  `\tconst isPaid = isPrimarySoftwareOwner || isPaidStatus.has(String(billing?.status || '').trim().toLowerCase());`,
  `\tconst recognizedPaidPlan = Boolean(plan) && String(billing?.planKey || '').trim() !== 'free';\n\tconst isPaid = isPrimarySoftwareOwner || (recognizedPaidPlan && isPaidStatus.has(String(billing?.status || '').trim().toLowerCase()));`,
  'Recognized paid-plan access requirement',
);

// The owner can disable new checkout in the catalog. Enforce that switch at
// the write endpoint, not only in the UI/config response.
const checkoutAnchor = `app.post('/billing/checkout-session', requireStrictAuth, async (req, res) => {\n\tif (!stripeClient) {`;
const checkoutGuard = `app.post('/billing/checkout-session', requireStrictAuth, async (req, res) => {\n\t// ATHLYRAX_BILLING_CHECKOUT_POLICY_ENFORCED\n\tif (!getBillingPolicy().checkoutEnabled) {\n\t\tres.status(403).json({ error: 'Subscription checkout is currently disabled.' });\n\t\treturn;\n\t}\n\tif (!stripeClient) {`;
replaceRequired(checkoutAnchor, checkoutGuard, 'Checkout enabled policy');

// Keep in-memory auth/billing state aligned with durable state when a paired
// auth-store transaction fails. A failed persistence must not leave RAM showing
// a customer/plan that was rolled back on disk.
const usernameUpsertNeedle = `function upsertUserBillingByUsername(username, partialBilling) {\n\tconst target = String(username || '').trim();\n\tif (!target) return null;\n\tconst index = authUsers.findIndex((row) => String(row?.username || '').trim() === target);\n\tif (index < 0) return null;\n\tconst previous = normalizeBillingState(authUsers[index]?.billing);\n\tauthUsers[index] = {\n\t\t...authUsers[index],\n\t\tbilling: normalizeBillingState({\n\t\t\t...previous,\n\t\t\t...(partialBilling && typeof partialBilling === 'object' ? partialBilling : {}),\n\t\t\tupdatedAt: new Date().toISOString(),\n\t\t}),\n\t};\n\tpersistAuthUsers();\n\treturn authUsers[index];\n}`;
const usernameUpsertReplacement = `function upsertUserBillingByUsername(username, partialBilling) {\n\tconst target = String(username || '').trim();\n\tif (!target) return null;\n\tconst index = authUsers.findIndex((row) => String(row?.username || '').trim() === target);\n\tif (index < 0) return null;\n\tconst previousRow = authUsers[index];\n\tconst previous = normalizeBillingState(previousRow?.billing);\n\tauthUsers[index] = {\n\t\t...previousRow,\n\t\tbilling: normalizeBillingState({\n\t\t\t...previous,\n\t\t\t...(partialBilling && typeof partialBilling === 'object' ? partialBilling : {}),\n\t\t\tupdatedAt: new Date().toISOString(),\n\t\t}),\n\t};\n\ttry {\n\t\t// ATHLYRAX_BILLING_MEMORY_ROLLBACK\n\t\tpersistAuthUsers();\n\t} catch (error) {\n\t\tauthUsers[index] = previousRow;\n\t\tthrow error;\n\t}\n\treturn authUsers[index];\n}`;
replaceRequired(usernameUpsertNeedle, usernameUpsertReplacement, 'Username billing memory rollback');

const customerUpsertNeedle = `function upsertUserBillingByCustomerId(customerId, partialBilling) {\n\tconst target = String(customerId || '').trim();\n\tif (!target) return null;\n\tconst index = authUsers.findIndex((row) => String(row?.billing?.customerId || '').trim() === target);\n\tif (index < 0) return null;\n\tconst previous = normalizeBillingState(authUsers[index]?.billing);\n\tauthUsers[index] = {\n\t\t...authUsers[index],\n\t\tbilling: normalizeBillingState({\n\t\t\t...previous,\n\t\t\t...(partialBilling && typeof partialBilling === 'object' ? partialBilling : {}),\n\t\t\tcustomerId: target,\n\t\t\tupdatedAt: new Date().toISOString(),\n\t\t}),\n\t};\n\tpersistAuthUsers();\n\treturn authUsers[index];\n}`;
const customerUpsertReplacement = `function upsertUserBillingByCustomerId(customerId, partialBilling) {\n\tconst target = String(customerId || '').trim();\n\tif (!target) return null;\n\tconst index = authUsers.findIndex((row) => String(row?.billing?.customerId || '').trim() === target);\n\tif (index < 0) return null;\n\tconst previousRow = authUsers[index];\n\tconst previous = normalizeBillingState(previousRow?.billing);\n\tauthUsers[index] = {\n\t\t...previousRow,\n\t\tbilling: normalizeBillingState({\n\t\t\t...previous,\n\t\t\t...(partialBilling && typeof partialBilling === 'object' ? partialBilling : {}),\n\t\t\tcustomerId: target,\n\t\t\tupdatedAt: new Date().toISOString(),\n\t\t}),\n\t};\n\ttry {\n\t\t// ATHLYRAX_BILLING_MEMORY_ROLLBACK\n\t\tpersistAuthUsers();\n\t} catch (error) {\n\t\tauthUsers[index] = previousRow;\n\t\tthrow error;\n\t}\n\treturn authUsers[index];\n}`;
replaceRequired(customerUpsertNeedle, customerUpsertReplacement, 'Customer billing memory rollback');

// Catalog update follows the same rule: commit durable state or restore the
// previous in-memory catalog before reporting failure.
const catalogAssignNeedle = `\tbillingCatalog = {\n\t\tversion: Number(billingCatalog?.version || 1) + 1,\n\t\tcurrency: String(normalized?.currency || 'GBP').toUpperCase(),\n\t\tsettings: mergedSettings,\n\t\tplans: normalized.plans,\n\t\taddons: Array.isArray(normalized?.addons) ? normalized.addons : [],\n\t};\n\tpersistBillingCatalog();`;
const catalogAssignReplacement = `\tconst previousBillingCatalog = billingCatalog;\n\tbillingCatalog = {\n\t\tversion: Number(billingCatalog?.version || 1) + 1,\n\t\tcurrency: String(normalized?.currency || 'GBP').toUpperCase(),\n\t\tsettings: mergedSettings,\n\t\tplans: normalized.plans,\n\t\taddons: Array.isArray(normalized?.addons) ? normalized.addons : [],\n\t};\n\ttry {\n\t\t// ATHLYRAX_BILLING_CATALOG_MEMORY_ROLLBACK\n\t\tpersistBillingCatalog();\n\t} catch (error) {\n\t\tbillingCatalog = previousBillingCatalog;\n\t\tres.status(500).json({ error: 'Could not persist billing catalog.', details: error instanceof Error ? error.message : 'Unknown error' });\n\t\treturn;\n\t}`;
replaceRequired(catalogAssignNeedle, catalogAssignReplacement, 'Billing catalog memory rollback');

for (const token of [
  'ATHLYRAX_AUTH_ROW_METADATA_PRESERVED',
  'ATHLYRAX_BILLING_POLICY_SINGLE_SOURCE',
  'ATHLYRAX_UNKNOWN_STRIPE_PRICE_FAIL_CLOSED',
  'recognizedPaidPlan',
  'ATHLYRAX_BILLING_CHECKOUT_POLICY_ENFORCED',
  'ATHLYRAX_BILLING_MEMORY_ROLLBACK',
  'ATHLYRAX_BILLING_CATALOG_MEMORY_ROLLBACK',
]) if (!source.includes(token)) throw new Error(`Runtime auth/billing hardening token is missing: ${token}`);

if (source.includes(`const isBillingEnforced = isBillingEnabled && BILLING_ENFORCED;`)) throw new Error('Legacy billing enforcement source remains.');
if (source.includes(`if (!BILLING_ENFORCED || !stripeClient) return next();`)) throw new Error('Legacy billing write enforcement source remains.');
if (source.includes(`return { planKey: 'tier-1', priceId: linePriceId };`)) throw new Error('Unknown active Stripe price still defaults to tier-1.');

fs.writeFileSync(indexPath, source, 'utf8');
console.log('RUNTIME_AUTH_BILLING_SAFETY_OK');
