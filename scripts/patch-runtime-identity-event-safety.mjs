import fs from 'node:fs';
import path from 'node:path';

const indexPath = path.resolve('index.js');
let source = fs.readFileSync(indexPath, 'utf8').replace(/\r\n/g, '\n');

function replaceRequired(needle, replacement, label) {
  if (source.includes(replacement)) return;
  if (!source.includes(needle)) throw new Error(`${label} anchor was not found.`);
  source = source.replace(needle, replacement);
}

// Preserve forward-compatible invite metadata instead of projecting every row
// onto a fixed legacy schema during each persistence operation.
replaceRequired(
  `\t\t\treturn {\n\t\t\t\tcode,\n\t\t\t\trole,\n\t\t\t\tcreatedBy,`,
  `\t\t\treturn {\n\t\t\t\t// ATHLYRAX_INVITE_ROW_METADATA_PRESERVED\n\t\t\t\t...row,\n\t\t\t\tcode,\n\t\t\t\trole,\n\t\t\t\tcreatedBy,`,
  'Invite metadata preservation',
);

// Invite codes are credentials. Use the cryptographic RNG already available in
// this process rather than Math.random().
replaceRequired(
  `\tfor (let index = 0; index < 12; index += 1) {\n\t\traw += alphabet[Math.floor(Math.random() * alphabet.length)];\n\t}`,
  `\t// ATHLYRAX_INVITE_CODE_CRYPTO_RNG\n\tfor (let index = 0; index < 12; index += 1) {\n\t\traw += alphabet[crypto.randomInt(0, alphabet.length)];\n\t}`,
  'Invite code cryptographic RNG',
);

// Do not continue after the bounded collision loop unless uniqueness is proven.
const inviteCollisionAnchor = `\tfor (let attempt = 0; attempt < 4; attempt += 1) {\n\t\tif (!authInvites.some((row) => String(row?.code || '').trim().toUpperCase() === code)) break;\n\t\tcode = makeInviteCode();\n\t}\n\n\tconst createdAt = new Date();`;
const inviteCollisionGuard = `\tfor (let attempt = 0; attempt < 4; attempt += 1) {\n\t\tif (!authInvites.some((row) => String(row?.code || '').trim().toUpperCase() === code)) break;\n\t\tcode = makeInviteCode();\n\t}\n\t// ATHLYRAX_INVITE_CODE_UNIQUENESS_FAIL_CLOSED\n\tif (authInvites.some((row) => String(row?.code || '').trim().toUpperCase() === code)) {\n\t\tres.status(503).json({ error: 'Could not allocate a unique invite code. Try again.' });\n\t\treturn;\n\t}\n\n\tconst createdAt = new Date();`;
replaceRequired(inviteCollisionAnchor, inviteCollisionGuard, 'Invite collision fail-closed check');

// Usernames are case-insensitive at login. Creation must enforce uniqueness with
// the same semantics or it can create a login ambiguity that only appears after
// persistence/startup validation.
source = source.replaceAll(
  `authUsers.some((row) => row.username === username)`,
  `authUsers.some((row) => String(row?.username || '').trim().toLowerCase() === username.toLowerCase())`,
);
const adminDuplicateNeedle = `\tif (authUsers.some((row) => row.username === username)) {`;
if (source.includes(adminDuplicateNeedle)) {
  source = source.replace(adminDuplicateNeedle, `\tif (authUsers.some((row) => String(row?.username || '').trim().toLowerCase() === username.toLowerCase())) {`);
}
if (!source.includes(`String(row?.username || '').trim().toLowerCase() === username.toLowerCase()`)) {
  throw new Error('Case-insensitive username uniqueness was not installed.');
}

// Persist Stripe event order with the billing state. Webhooks may be retried or
// delivered out of order; an older checkout/subscription/payment event must not
// overwrite a newer authoritative state.
replaceRequired(
  `\t\tcancelAtPeriodEnd: raw?.cancelAtPeriodEnd === true,\n\t\tupdatedAt: String(raw?.updatedAt || fallback.updatedAt).trim() || fallback.updatedAt,`,
  `\t\tcancelAtPeriodEnd: raw?.cancelAtPeriodEnd === true,\n\t\tlastStripeEventCreated: Math.max(0, Number.parseInt(raw?.lastStripeEventCreated || '0', 10) || 0),\n\t\tlastStripeEventId: String(raw?.lastStripeEventId || '').trim(),\n\t\tupdatedAt: String(raw?.updatedAt || fallback.updatedAt).trim() || fallback.updatedAt,`,
  'Stripe event ordering fields',
);

const usernamePreviousAnchor = `\tconst previousRow = authUsers[index];\n\tconst previous = normalizeBillingState(previousRow?.billing);\n\tauthUsers[index] = {`;
const usernameOrdering = `\tconst previousRow = authUsers[index];\n\tconst previous = normalizeBillingState(previousRow?.billing);\n\tconst incomingEventCreated = Math.max(0, Number.parseInt(partialBilling?.lastStripeEventCreated || '0', 10) || 0);\n\tconst incomingEventId = String(partialBilling?.lastStripeEventId || '').trim();\n\tif (incomingEventId && previous.lastStripeEventId === incomingEventId) return previousRow;\n\tif (incomingEventCreated > 0 && previous.lastStripeEventCreated > incomingEventCreated) return previousRow;\n\t// ATHLYRAX_STRIPE_EVENT_ORDER_GUARD\n\tauthUsers[index] = {`;
// There are two upsert functions with the same previous-row anchor. Replace both.
let orderingReplacements = 0;
while (source.includes(usernamePreviousAnchor) && orderingReplacements < 2) {
  source = source.replace(usernamePreviousAnchor, usernameOrdering);
  orderingReplacements += 1;
}
if (orderingReplacements !== 2) throw new Error(`Stripe event ordering was installed in ${orderingReplacements} billing upsert functions; expected 2.`);

replaceRequired(
  `async function handleStripeSubscriptionEvent(subscriptionObject) {`,
  `async function handleStripeSubscriptionEvent(subscriptionObject, stripeEvent = null) {`,
  'Subscription event metadata argument',
);
replaceRequired(
  `\t\tcancelAtPeriodEnd: subscription?.cancel_at_period_end === true,\n\t\tupdatedAt: new Date().toISOString(),`,
  `\t\tcancelAtPeriodEnd: subscription?.cancel_at_period_end === true,\n\t\tlastStripeEventCreated: Math.max(0, Number.parseInt(stripeEvent?.created || '0', 10) || 0),\n\t\tlastStripeEventId: String(stripeEvent?.id || '').trim(),\n\t\tupdatedAt: new Date().toISOString(),`,
  'Subscription billing event markers',
);
replaceRequired(
  `\t\t\t\tawait handleStripeSubscriptionEvent(event?.data?.object);`,
  `\t\t\t\tawait handleStripeSubscriptionEvent(event?.data?.object, event);`,
  'Subscription webhook event forwarding',
);

replaceRequired(
  `\t\t\t\t\t\tstatus: String(session?.status || 'active').trim() || 'active',\n\t\t\t\t\t\tupdatedAt: new Date().toISOString(),`,
  `\t\t\t\t\t\tstatus: String(session?.status || 'active').trim() || 'active',\n\t\t\t\t\t\tlastStripeEventCreated: Math.max(0, Number.parseInt(event?.created || '0', 10) || 0),\n\t\t\t\t\t\tlastStripeEventId: String(event?.id || '').trim(),\n\t\t\t\t\t\tupdatedAt: new Date().toISOString(),`,
  'Checkout webhook event markers',
);
replaceRequired(
  `\t\t\t\t\t\tstatus: 'past_due',\n\t\t\t\t\t\tupdatedAt: new Date().toISOString(),`,
  `\t\t\t\t\t\tstatus: 'past_due',\n\t\t\t\t\t\tlastStripeEventCreated: Math.max(0, Number.parseInt(event?.created || '0', 10) || 0),\n\t\t\t\t\t\tlastStripeEventId: String(event?.id || '').trim(),\n\t\t\t\t\t\tupdatedAt: new Date().toISOString(),`,
  'Failed invoice webhook event markers',
);

for (const token of [
  'ATHLYRAX_INVITE_ROW_METADATA_PRESERVED',
  'ATHLYRAX_INVITE_CODE_CRYPTO_RNG',
  'ATHLYRAX_INVITE_CODE_UNIQUENESS_FAIL_CLOSED',
  'ATHLYRAX_STRIPE_EVENT_ORDER_GUARD',
  'lastStripeEventCreated',
  'lastStripeEventId',
]) if (!source.includes(token)) throw new Error(`Runtime identity/event hardening token is missing: ${token}`);

if (source.includes(`Math.floor(Math.random() * alphabet.length)`)) throw new Error('Invite generation still uses Math.random().');
if (source.includes(`if (authUsers.some((row) => row.username === username))`)) throw new Error('Case-sensitive admin username duplicate check remains.');

fs.writeFileSync(indexPath, source, 'utf8');
console.log('RUNTIME_IDENTITY_EVENT_SAFETY_OK');
