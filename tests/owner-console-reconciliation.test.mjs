// Owner Console reconciliation: Stripe ledger (fixture mirrors the real test-mode account on 2026-11-10),
// subscription cancellation states, audit error classification, club database states, billing and
// invitation reconciliation. All read only.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { stripeLedger, subscriptionRow, auditErrorsReport, clubDataReport, readAuditForPeriod, billingReconciliation, invitationChecks, keyMode, stripeErrorReason, classifyCharge } from '../owner-console.mjs';

const NOW = Date.parse('2026-11-10T12:00:00Z');
const T = (isoStr) => Math.floor(Date.parse(isoStr) / 1000);
const priceMap = { p_t1: { key: 'tier-1', label: 'Tier 1', kind: 'plan' }, p_t2: { key: 'tier-2', label: 'Tier 2', kind: 'plan' }, p_t3: { key: 'tier-3', label: 'Tier 3', kind: 'plan' }, p_a25: { key: 'extra-25-swimmers', label: '+25', kind: 'addon' }, p_a50: { key: 'extra-50-swimmers', label: '+50', kind: 'addon' } };
const price = (id, amount) => ({ id, unit_amount: amount, currency: 'gbp', recurring: { interval: 'month', interval_count: 1 } });
const bt = (fee, amount) => ({ fee, net: amount - fee, status: 'pending' });
const fixture = {
  charges: [
    { id: 'ch_3', livemode: false, created: T('2026-11-06T01:44:22Z'), status: 'succeeded', paid: true, amount: 499, currency: 'gbp', amount_refunded: 0, description: 'AthlyraX Education - CPD 01 Module 02', billing_details: { name: 'CPD Verifier', email: 'verifier@example.com' }, balance_transaction: bt(36, 499) },
    { id: 'ch_2', livemode: false, created: T('2026-11-06T00:58:23Z'), status: 'succeeded', paid: true, amount: 1500, currency: 'gbp', amount_refunded: 0, description: 'Subscription creation', billing_details: { name: 'Demo Coach', email: 'demo.coach@example.com' }, balance_transaction: bt(67, 1500) },
    { id: 'ch_1', livemode: false, created: T('2026-11-05T12:09:10Z'), status: 'succeeded', paid: true, amount: 499, currency: 'gbp', amount_refunded: 0, description: 'AthlyraX Education - CPD 01 Module 02', billing_details: {}, balance_transaction: bt(36, 499) },
  ],
  refunds: [],
  subscriptions: [
    { id: 'sub_active', livemode: false, status: 'active', customer: 'cus_demo', created: T('2026-11-06T00:58:23Z'), cancel_at_period_end: false, cancel_at: T('2026-12-06T00:58:23Z'), canceled_at: T('2026-11-06T01:05:24Z'), ended_at: null, metadata: { planKey: 'tier-1', username: 'demo.coach' }, items: { data: [{ price: price('p_t2', 3500), quantity: 1, current_period_end: T('2026-12-06T00:58:23Z') }] } },
    { id: 'sub_cancelled', livemode: false, status: 'canceled', customer: 'cus_demo', created: T('2026-11-06T00:40:24Z'), cancel_at_period_end: false, cancel_at: null, canceled_at: T('2026-11-06T00:42:03Z'), ended_at: T('2026-11-06T00:42:03Z'), metadata: { planKey: 'tier-1', username: 'demo.coach' }, items: { data: [{ price: price('p_t3', 9000), quantity: 1 }, { price: price('p_a50', 1500), quantity: 2 }] } },
  ],
  invoices: [{ livemode: false, billing_reason: 'subscription_create', status: 'paid' }, { livemode: false, billing_reason: 'subscription_create', status: 'paid' }],
  events: [{ livemode: false, created: T('2026-11-06T01:05:04Z'), data: { previous_attributes: { items: { data: [{ price: price('p_t1', 1500), quantity: 1 }] } }, object: { id: 'sub_active', items: { data: [{ price: price('p_t2', 3500), quantity: 1 }] } } } }],
};
const fakeStripe = (data, { deny = [] } = {}) => Object.fromEntries(['charges', 'refunds', 'subscriptions', 'invoices', 'events'].map((r) => [r, { list: async (params) => {
  if (deny.includes(r) || (deny.includes('expand') && params.expand)) { const e = new Error("The provided key 'rk_live_*****abc' does not have the required permissions for this endpoint. Having the 'rak_charge_read' permission would allow this request to continue."); e.type = 'StripePermissionError'; e.statusCode = 403; throw e; }
  return { data: r === 'charges' && !params.expand ? data[r].map((c) => ({ ...c, balance_transaction: 'txn_unexpanded' })) : data[r], has_more: false };
} }]));

test('Stripe ledger reproduces the test account: £24.98 from 3 payments, fees, no refunds, 1 cancelled and 1 scheduled-to-cancel subscription', async () => {
  const r = await stripeLedger(fakeStripe(fixture), { days: 30, now: NOW, priceMap, keyInfo: keyMode('sk_test_x') });
  assert.equal(r.available, true); assert.deepEqual(Object.keys(r.modes), ['test'], 'test data never appears as live');
  const m = r.modes.test;
  assert.deepEqual(m.payments, { succeeded: 3, pending: 0, failed: 0 });
  assert.equal(m.currency.gbp.grossMinor, 2498); assert.equal(m.currency.gbp.refundedMinor, 0); assert.equal(m.currency.gbp.feeMinor, 139); assert.equal(m.currency.gbp.netAfterFeesMinor, 2359);
  assert.deepEqual(Object.fromEntries(Object.entries(m.byProduct).map(([k, v]) => [k, [v.payments, v.grossMinor]])), { 'CPD Module 02': [2, 998], 'Coaching subscription': [1, 1500] });
  assert.equal(m.refunds, 0);
  assert.equal(m.subscriptions.active, 1); assert.equal(m.subscriptions.scheduledToCancel, 1); assert.equal(m.subscriptions.cancelledAllTime, 1);
  assert.equal(m.mrrMinor.continuing.gbp, undefined, 'nothing continues after the scheduled cancellation'); assert.equal(m.mrrMinor.ending.gbp, 3500);
  assert.equal(m.changes[0].change, 'upgrade'); assert.equal(m.changes[0].from, 'Tier 1'); assert.equal(m.changes[0].to, 'Tier 2');
  const active = r.subscriptions.find((s) => s.id === 'sub_active');
  assert.equal(active.state, 'scheduled-cancellation'); assert.equal(active.cancellationRequestedAt, '2026-11-06T01:05:24.000Z'); assert.equal(active.cancellationEffectiveAt, '2026-12-06T00:58:23.000Z');
  assert.equal(active.planKey, 'tier-2', 'plan from the Stripe price, not from stale metadata'); assert.equal(active.metadataPlanKey, 'tier-1');
  const ended = r.subscriptions.find((s) => s.id === 'sub_cancelled');
  assert.equal(ended.state, 'cancelled'); assert.equal(ended.cancellationEffectiveAt, '2026-11-06T00:42:03.000Z'); assert.deepEqual(ended.addons, ['+50 × 2']);
  assert.ok(r.transactions.every((t) => t.mode === 'test' && t.feeMinor !== null));
  assert.ok(!JSON.stringify(r).includes('verifier@example.com'), 'payer emails masked');
});

test('Refunds reduce net revenue; a cancellation does not; failed and pending payments are counted separately', async () => {
  const data = structuredClone(fixture);
  data.charges.push({ id: 'ch_f', livemode: false, created: T('2026-11-07T00:00:00Z'), status: 'failed', paid: false, amount: 1500, currency: 'gbp', amount_refunded: 0, description: 'Subscription update', failure_message: 'Your card was declined.' });
  data.charges.push({ id: 'ch_p', livemode: false, created: T('2026-11-07T00:00:00Z'), status: 'pending', paid: false, amount: 499, currency: 'gbp', amount_refunded: 0, description: 'AthlyraX Education - CPD 01 Module 02' });
  data.refunds = [{ id: 're_1', charge: 'ch_1', livemode: false, amount: 499, status: 'succeeded', created: T('2026-11-08T00:00:00Z') }];
  const m = (await stripeLedger(fakeStripe(data), { days: 30, now: NOW, priceMap })).modes.test;
  assert.deepEqual(m.payments, { succeeded: 3, pending: 1, failed: 1 });
  assert.equal(m.currency.gbp.grossMinor, 2498); assert.equal(m.currency.gbp.refundedMinor, 499); assert.equal(m.currency.gbp.netAfterFeesMinor, 2498 - 499 - 139);
  assert.equal(m.refunds, 1);
});

test('Live and test objects are reported separately', async () => {
  const data = structuredClone(fixture);
  data.charges.push({ ...data.charges[0], id: 'ch_live', livemode: true });
  const r = await stripeLedger(fakeStripe(data), { days: 30, now: NOW, priceMap });
  assert.equal(r.modes.live.payments.succeeded, 1); assert.equal(r.modes.live.currency.gbp.grossMinor, 499); assert.equal(r.modes.test.currency.gbp.grossMinor, 2498);
});

test('A restricted key is reported as unavailable with the missing permission, never as zero and never with the key', async () => {
  const r = await stripeLedger(fakeStripe(fixture, { deny: ['charges'] }), { days: 30, now: NOW, priceMap, keyInfo: keyMode('rk_live_x') });
  assert.equal(r.available, false); assert.match(r.reason, /rak_charge_read/); assert.ok(!/rk_live_\*/.test(r.reason));
  const partial = await stripeLedger(fakeStripe(fixture, { deny: ['events', 'expand'] }), { days: 30, now: NOW, priceMap });
  assert.equal(partial.available, true); assert.equal(partial.parts.changes, false); assert.equal(partial.modes.test.currency.gbp.feeMinor, null, 'fees unknown → not zero');
  assert.deepEqual(keyMode('rk_live_abc'), { mode: 'live', restricted: true }); assert.deepEqual(keyMode('sk_test_abc'), { mode: 'test', restricted: false });
  assert.equal(stripeErrorReason({ statusCode: 401 }), 'Stripe rejected the key.');
  assert.equal(classifyCharge({ metadata: { course: 'cpd01-module03' } }), 'CPD Module 03');
});

test('Subscription states: active, trialing, past due, scheduled at period end (old API flag)', () => {
  const base = { id: 's', livemode: true, customer: 'c', created: T('2026-11-01T00:00:00Z'), items: { data: [{ price: price('p_t1', 1500), quantity: 1 }] } };
  assert.equal(subscriptionRow({ ...base, status: 'active' }, priceMap).state, 'active');
  assert.equal(subscriptionRow({ ...base, status: 'trialing' }, priceMap).state, 'trialing');
  assert.equal(subscriptionRow({ ...base, status: 'past_due' }, priceMap).state, 'past_due');
  const s = subscriptionRow({ ...base, status: 'active', cancel_at_period_end: true, current_period_end: T('2026-12-01T00:00:00Z') }, priceMap);
  assert.equal(s.state, 'scheduled-cancellation'); assert.equal(s.cancellationEffectiveAt, '2026-12-01T00:00:00.000Z');
});

test('Recorded errors: rejected sign-ins and registrations are not software faults; software failures list time, service and later success', () => {
  const rows = [
    { at: '2026-11-09T10:00:00Z', action: 'login_failed', status: 'error', reason: 'invalid_credentials', actor: 'someone', path: '/auth/login', method: 'POST', ip: '1.2.3.4' },
    { at: '2026-11-09T11:00:00Z', action: 'register_failed', status: 'error', reason: 'email_taken', path: '/auth/register' },
    { at: '2026-11-09T12:00:00Z', action: 'password_reset_request', status: 'error', reason: 'delivery_failed', path: '/auth/password-reset/request' },
    { at: '2026-11-09T13:00:00Z', action: 'password_reset_request', status: 'success', reason: '' },
    { at: '2026-11-09T14:00:00Z', action: 'swimmer_profile_sync_failed', status: 'error', reason: 'write_failed', path: '/swimmer/profile' },
    { at: '2026-11-09T15:00:00Z', action: 'login_success', status: 'success', actor: 'coachA' },
    { at: '2026-10-01T00:00:00Z', action: 'swimmer_profile_sync_failed', status: 'error', reason: 'write_failed' },
  ];
  const r = auditErrorsReport(rows, { days: 7, now: NOW });
  assert.equal(r.total, 4); assert.equal(r.userRejections, 2); assert.equal(r.systemFailures, 2); assert.equal(r.unresolvedSystemFailures, 1);
  const reset = r.items.find((x) => x.action === 'password_reset_request'); assert.equal(reset.laterSuccessAt, '2026-11-09T13:00:00Z'); assert.equal(reset.service, 'Authentication');
  assert.equal(r.items.find((x) => x.action === 'swimmer_profile_sync_failed').state, 'no later success recorded');
  assert.equal(r.accountsSignedIn, 1);
  assert.ok(!JSON.stringify(r).includes('1.2.3.4') && !JSON.stringify(r).includes('someone'), 'no IPs or names');
  assert.equal(auditErrorsReport(rows, { days: 0, now: NOW }).systemFailures, 3);
});

test('Audit log is read across rotated files for the whole period and reports its coverage', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-'));
  try {
    const line = (at, action = 'login_success', status = 'success') => JSON.stringify({ at, action, status });
    fs.writeFileSync(path.join(dir, 'events-2026-10-20T00-00-00-000Z.jsonl'), [line('2026-10-15T00:00:00Z', 'x_failed', 'error'), line('2026-10-20T00:00:00Z')].join('\n'));
    fs.writeFileSync(path.join(dir, 'events.jsonl'), Array.from({ length: 1500 }, (_, i) => line(new Date(Date.parse('2026-11-01T00:00:00Z') + i * 60000).toISOString())).join('\n'));
    const all = readAuditForPeriod(dir, path.join(dir, 'events.jsonl'));
    assert.equal(all.rows.length, 1502, 'not cut at 1,000 rows'); assert.equal(all.coverageFrom, '2026-10-15T00:00:00Z');
    const p30 = readAuditForPeriod(dir, path.join(dir, 'events.jsonl'), { since: NOW - 30 * 86400000 });
    assert.equal(p30.complete, false, 'stored log starts after the period start'); assert.equal(p30.rows.length, 1502);
    const p7 = readAuditForPeriod(dir, path.join(dir, 'events.jsonl'), { since: NOW - 7 * 86400000 });
    assert.equal(p7.complete, true); assert.equal(p7.rows.length, 0);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('Club databases: readable, folder without data, missing with history, invalid JSON and wrong shape are distinguished; nothing is changed', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'clubs-'));
  try {
    const dir = (k) => path.join(root, k);
    fs.mkdirSync(dir('good'), { recursive: true }); fs.writeFileSync(path.join(dir('good'), 'db.json'), JSON.stringify({ swimmers: [{ id: 1 }, { id: 2 }], trainingSessions: [{ id: 's' }] }));
    fs.mkdirSync(path.join(dir('empty'), 'db-snapshots'), { recursive: true });
    fs.mkdirSync(path.join(dir('lost'), 'db-snapshots'), { recursive: true }); fs.writeFileSync(path.join(dir('lost'), 'db-snapshots', 'db-2026-11-01.json'), '{"swimmers":[]}');
    fs.mkdirSync(dir('broken'), { recursive: true }); fs.writeFileSync(path.join(dir('broken'), 'db.json'), '{"swimmers":[{"name":"Private Name"}');
    fs.mkdirSync(dir('shape'), { recursive: true }); fs.writeFileSync(path.join(dir('shape'), 'db.json'), '[]');
    const before = fs.readFileSync(path.join(dir('broken'), 'db.json'), 'utf8');
    const r = clubDataReport(['good', 'empty', 'lost', 'broken', 'shape'], { pathsOf: (k) => ({ dbPath: path.join(dir(k), 'db.json'), snapshotDir: path.join(dir(k), 'db-snapshots') }), accountsFor: (k) => (k === 'empty' ? 1 : 0) });
    const by = Object.fromEntries(r.clubs.map((c) => [c.tenantId, c]));
    assert.equal(by.good.state, 'ok'); assert.equal(by.good.swimmers, 2); assert.equal(by.good.rows, 3);
    assert.equal(by.empty.state, 'empty'); assert.equal(by.empty.accounts, 1);
    assert.equal(by.lost.state, 'missing'); assert.equal(by.lost.latestSnapshotReadable, true);
    assert.equal(by.broken.state, 'unreadable'); assert.match(by.broken.detail, /character \d+ of \d+/); assert.ok(!JSON.stringify(r).includes('Private Name'), 'file content never quoted');
    assert.equal(by.shape.state, 'invalid');
    assert.deepEqual([r.folders, r.readable, r.empty, r.failing], [5, 1, 1, 3]);
    assert.equal(fs.readFileSync(path.join(dir('broken'), 'db.json'), 'utf8'), before, 'read only');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('Billing reconciliation compares account records with Stripe; invitation checks find duplicates and consent', () => {
  const subs = [{ customerId: 'cus_demo', id: 'sub_active', livemode: false, state: 'scheduled-cancellation', status: 'active', planKey: 'tier-2', createdAt: '2026-11-06T00:58:23Z' }, { customerId: 'cus_demo', id: 'sub_old', livemode: false, state: 'cancelled', status: 'canceled', planKey: 'tier-3', createdAt: '2026-11-06T00:40:24Z' }, { customerId: 'cus_x', id: 'sub_x', livemode: false, state: 'active', status: 'active', planKey: 'tier-1', createdAt: '2026-11-01' }];
  const rows = billingReconciliation(subs, [{ username: 'demo.coach', billing: { customerId: 'cus_demo', status: 'active', planKey: 'tier-2', cancelAtPeriodEnd: true } }]);
  assert.equal(rows.length, 2); assert.equal(rows[0].subscription, 'sub_active', 'latest subscription per customer'); assert.equal(rows[0].matches, true);
  assert.deepEqual(rows[1].issues, ['No AthlyraX account linked to this Stripe customer']);
  const bad = billingReconciliation(subs.slice(0, 1), [{ username: 'demo.coach', billing: { customerId: 'cus_demo', status: 'active', planKey: 'tier-1', cancelAtPeriodEnd: false } }]);
  assert.equal(bad[0].matches, false); assert.equal(bad[0].issues.length, 2);
  const future = new Date(NOW + 86400000).toISOString();
  const status = (inv) => (inv.revokedAt ? 'revoked' : inv.acceptedAt ? 'accepted' : inv.guardianRequired && !inv.guardianConsent ? 'awaiting-guardian' : 'pending');
  const c = invitationChecks([{ db: { athleteAccountInvites: [
    { swimmerId: 'a', expiresAt: future }, { swimmerId: 'a', expiresAt: future }, { swimmerId: 'b', guardianRequired: true, expiresAt: future }, { swimmerId: 'c', guardianRequired: true, guardianConsent: { at: 'x' }, acceptedAt: 'y' }, { swimmerId: 'd', delivery: 'email', deliveries: [], revokedAt: 'z', supersededBy: 'q' },
  ] } }], { inviteStatus: status });
  assert.deepEqual(c, { open: 3, duplicateOpenInvitations: 1, superseded: 1, guardianRequired: 2, guardianConsented: 1, guardianPending: 1, emailInvitesWithoutSendAttempt: 1 });
});
