// Owner Console reports: real records only, unavailable instead of zero, live and test kept apart.
import test from 'node:test';
import assert from 'node:assert/strict';
import { accountsReport, invitationsReport, auditFailures, stripeSalesReport, priceCheck, deliveryBucket, webhookSummary } from '../owner-console.mjs';

const now = Date.parse('2026-11-10T12:00:00Z');
const roles = new Set(['software-owner', 'head-coach', 'assistant-coach', 'coach', 'viewer']);
const deps = { coachingRoles: roles, isPrimarySwimmer: (u) => u.role === 'swimmer', hasAthleteRole: (u) => u.athleteRole?.enabled === true, guardianVerified: (u) => Boolean(u.guardianVerifiedEmail) };

test('accounts: roles, registrations in period, billing, multi-role, duplicate emails', () => {
  const users = [
    { username: 'owner', role: 'software-owner', createdAt: '2026-01-01T00:00:00Z' },
    { username: 'c1', role: 'head-coach', tenantId: 'club-a', email: 'a@x.com', createdAt: '2026-11-05T00:00:00Z', billing: { planKey: 'tier-1', status: 'active' }, athleteRole: { enabled: true }, guardianVerifiedEmail: 'a@x.com' },
    { username: 'c2', role: 'head-coach', tenantId: 'club-b', email: 'A@x.com', createdAt: '2026-09-01T00:00:00Z', billing: { planKey: 'tier-2', status: 'trialing' } },
    { username: 's1', role: 'swimmer', createdAt: '' , managedBy: { guardianEmail: 'p@x.com' } },
  ];
  const r = accountsReport(users, { days: 30, now, ...deps });
  assert.equal(r.total, 4); assert.equal(r.registrationsInPeriod, 1); assert.equal(r.registrationsWithoutDate, 1);
  assert.equal(r.clubs, 2); assert.equal(r.billing.active, 1); assert.equal(r.billing.trialing, 1);
  assert.deepEqual(r.multiRole, { coachesWithSwimmerRole: 1, guardianVerifiedAccounts: 1, guardianManagedChildLogins: 1 });
  assert.equal(r.duplicateEmailWarnings, 1);
  assert.equal(accountsReport(users, { days: 0, now, ...deps }).registrationsInPeriod, 3, 'all time counts dated records');
});

test('invitations: statuses, delivery buckets never claim delivery without the provider, failures masked', () => {
  const inviteStatus = (i) => (i.acceptedAt ? 'accepted' : i.revokedAt ? 'revoked' : 'pending');
  const db = { swimmers: [{ id: 'a' }, { id: 'a' }], athleteAccountInvites: [
    { id: 'i1', createdAt: '2026-11-09T00:00:00Z', delivery: 'email', deliveries: [{ status: 'sent', to: 'kid@x.com' }, { status: 'bounced', to: 'kid@x.com', at: '2026-11-09T01:00:00Z', error: 'mailbox' }] },
    { id: 'i2', createdAt: '2026-11-08T00:00:00Z', acceptedAt: 'x', guardianConsent: { at: 'y' } },
    { id: 'i3', createdAt: '2025-01-01T00:00:00Z', delivery: 'email', deliveries: [{ status: 'delivered' }] },
  ] };
  const r = invitationsReport([{ tenantId: 'club-a', db }], { days: 30, now, inviteStatus, maskEmail: (e) => `${String(e)[0]}***`, clubName: (k) => k.toUpperCase(), emailTenants: ['demo-company'], duplicateIdsOf: () => ['a'] });
  assert.equal(r.created, 2); assert.equal(r.deliveries.sent, 1); assert.equal(r.deliveries.delivered, 0); assert.equal(r.deliveries.bounced, 1);
  assert.equal(r.recentFailures[0].to, 'k***'); assert.equal(r.byDeliveryMode.link, 1); assert.equal(r.guardianConsents, 1);
  assert.deepEqual(r.duplicateSwimmerIds, [{ club: 'CLUB-A', count: 1 }]);
  assert.equal(deliveryBucket('weird'), 'unknown');
});

test('audit failures and webhook summaries count only recorded errors in the period', () => {
  const rows = [{ status: 'error', action: 'login', at: '2026-11-09T00:00:00Z' }, { status: 'success', action: 'login', at: '2026-11-09T00:00:00Z' }, { status: 'error', action: 'x', at: '2025-01-01T00:00:00Z' }];
  assert.equal(auditFailures(rows, { days: 7, now }).total, 1);
  const hooks = [{ source: 'stripe', at: '2026-11-09T00:00:00Z', ok: true, livemode: true, type: 'a' }, { source: 'stripe', at: '2026-11-09T01:00:00Z', ok: false, livemode: false, type: 'b' }];
  const w = webhookSummary(hooks, 'stripe', { days: 7, now });
  assert.deepEqual([w.received, w.failed, w.live, w.test, w.lastType], [2, 1, 1, 1, 'b']);
});

test('Stripe sales: live and test separate, refunds and MRR from real objects, unavailable when not configured or restricted', async () => {
  assert.equal((await stripeSalesReport(null)).available, false);
  const page = (data) => ({ data, has_more: false });
  const fake = {
    charges: { list: async () => page([{ livemode: true, status: 'succeeded', paid: true, currency: 'gbp', amount: 1500 }, { livemode: false, status: 'succeeded', paid: true, currency: 'gbp', amount: 9999 }, { livemode: true, status: 'failed', currency: 'gbp', amount: 1500 }]) },
    refunds: { list: async () => page([{ livemode: true, status: 'succeeded', currency: 'gbp', amount: 499 }]) },
    subscriptions: { list: async () => page([{ livemode: true, status: 'active', created: now / 1000 - 10, items: { data: [{ quantity: 1, price: { unit_amount: 3500, currency: 'gbp', recurring: { interval: 'month', interval_count: 1 } } }] } }]) },
  };
  const r = await stripeSalesReport(fake, { days: 30, now });
  assert.equal(r.modes.live.currency.gbp.grossMinor, 1500); assert.equal(r.modes.live.currency.gbp.refundedMinor, 499); assert.equal(r.modes.live.currency.gbp.netOfRefundsMinor, 1001);
  assert.equal(r.modes.test.currency.gbp.grossMinor, 9999, 'test kept apart');
  assert.equal(r.modes.live.failedPayments, 1); assert.equal(r.modes.live.mrrMinor.gbp, 3500); assert.equal(r.modes.live.subscriptions.newInPeriod, 1);
  const restricted = { charges: { list: async () => { const e = new Error('x'); e.type = 'StripePermissionError'; throw e; } }, refunds: fake.refunds, subscriptions: fake.subscriptions };
  assert.match((await stripeSalesReport(restricted)).reason, /restricted/);
  const pc = await priceCheck({ prices: { retrieve: async () => ({ unit_amount: 1500, currency: 'gbp', active: true, livemode: true, recurring: { interval: 'month' } }) } }, [{ product: 'T1', expectedMinor: 1500, priceId: 'price_1' }, { product: 'T2', expectedMinor: 3500 }]);
  assert.equal(pc[0].stripe.matchesCode, true); assert.equal(pc[0].priceId, undefined, 'price ids are not echoed'); assert.equal(pc[1].stripe.available, false);
});
