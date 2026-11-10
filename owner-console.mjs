// AthlyraX Owner Console: read-only reporting for the primary software owner.
// - Every figure comes from a stored record or a live read-only check; nothing is estimated.
// - A source that cannot be read is reported as { available: false, reason } (the console shows
//   "Unavailable"), never as zero.
// - Stripe is read only (charges, refunds, subscriptions, prices); nothing is created or changed.
//   Live and test objects are kept apart by Stripe's own livemode flag.
// - Personal data: email addresses are masked; no passwords, tokens, codes or keys are returned.
import fs from 'node:fs';
import path from 'node:path';

const DAY = 86400000;
export const PERIODS = Object.freeze({ 7: '7 days', 30: '30 days', 90: '90 days', 365: '12 months', 0: 'All time' });
const text = (v) => String(v ?? '').trim();
const list = (v) => (Array.isArray(v) ? v : []);
export const periodStart = (days, now = Date.now()) => (Number(days) > 0 ? now - Number(days) * DAY : 0);
const inPeriod = (iso, start) => { const t = Date.parse(iso || ''); return Number.isFinite(t) && t >= start; };
const unavailable = (reason) => ({ available: false, reason });

// Email delivery: what the provider confirmed, never more. "sent" only means the provider accepted it.
export const DELIVERY_BUCKETS = Object.freeze({
  queued: 'Queued', sent: 'Accepted by email provider', delivered: 'Delivered (confirmed by provider)', deferred: 'Delayed (provider retrying)',
  bounced: 'Bounced', failed: 'Failed', unknown: 'Unknown / unverified',
});
export function deliveryBucket(status) { return Object.prototype.hasOwnProperty.call(DELIVERY_BUCKETS, status) && status !== 'unknown' ? status : 'unknown'; }

export function accountsReport(users = [], { days = 30, now = Date.now(), coachingRoles, isPrimarySwimmer, hasAthleteRole, guardianVerified } = {}) {
  const start = periodStart(days, now);
  const real = list(users).filter((u) => u && text(u.username));
  const byRole = {}; for (const u of real) { const r = text(u.role) || 'unknown'; byRole[r] = (byRole[r] || 0) + 1; }
  const coaches = real.filter((u) => coachingRoles.has(text(u.role).toLowerCase()) && text(u.role) !== 'software-owner');
  const tiers = {}; let trials = 0; let paid = 0;
  for (const u of coaches) {
    const b = u.billing || {}; const plan = text(b.planKey) || 'free'; const status = text(b.status) || 'inactive';
    const key = `${plan}:${status}`; tiers[key] = (tiers[key] || 0) + 1;
    if (status === 'trialing') trials += 1;
    if (status === 'active') paid += 1;
  }
  const emails = new Map();
  for (const u of real) { const e = text(u.email).toLowerCase(); if (!e) continue; emails.set(e, [...(emails.get(e) || []), u.username]); }
  const duplicateEmails = [...emails.values()].filter((names) => names.length > 1).length;
  const clubs = new Set(coaches.map((u) => text(u.tenantId)).filter(Boolean));
  return {
    available: true,
    total: real.length, byRole,
    registrationsInPeriod: real.filter((u) => inPeriod(u.createdAt, start)).length,
    registrationsWithoutDate: real.filter((u) => !Number.isFinite(Date.parse(u.createdAt || ''))).length,
    clubs: clubs.size,
    coachingAccounts: coaches.length, billing: { byPlanAndStatus: tiers, trialing: trials, active: paid },
    multiRole: {
      coachesWithSwimmerRole: real.filter((u) => !isPrimarySwimmer(u) && hasAthleteRole(u)).length,
      guardianVerifiedAccounts: real.filter((u) => guardianVerified(u)).length,
      guardianManagedChildLogins: real.filter((u) => u.managedBy && typeof u.managedBy === 'object').length,
    },
    pendingApproval: real.filter((u) => u.isApproved === false).length,
    duplicateEmailWarnings: duplicateEmails,
  };
}

// Invitations and their email outcomes across every club, from the stored invitation records.
export function invitationsReport(tenants = [], { days = 30, now = Date.now(), inviteStatus, maskEmail, clubName, emailTenants = [], duplicateIdsOf } = {}) {
  const start = periodStart(days, now);
  const status = {}; const delivery = Object.fromEntries(Object.keys(DELIVERY_BUCKETS).map((k) => [k, 0]));
  const byDeliveryMode = { email: 0, link: 0 };
  const failures = []; let guardianConsents = 0; let accepted = 0; let created = 0;
  const duplicateSwimmerIds = [];
  for (const { tenantId, db } of tenants) {
    const ids = duplicateIdsOf(db); if (ids.length) duplicateSwimmerIds.push({ club: clubName(tenantId), count: ids.length });
    for (const inv of list(db?.athleteAccountInvites)) {
      if (!inPeriod(inv.createdAt, start)) continue;
      created += 1;
      const s = inviteStatus(inv, now); status[s] = (status[s] || 0) + 1;
      byDeliveryMode[inv.delivery === 'email' ? 'email' : 'link'] += 1;
      if (inv.guardianConsent?.at) guardianConsents += 1;
      if (inv.acceptedAt) accepted += 1;
      for (const d of list(inv.deliveries)) {
        const b = deliveryBucket(text(d.status)); delivery[b] += 1;
        if (b === 'failed' || b === 'bounced') failures.push({ club: clubName(tenantId), kind: text(d.kind), to: maskEmail(d.to), status: b, at: text(d.updatedAt || d.at), error: text(d.error).slice(0, 160) });
      }
    }
  }
  return {
    available: true, created, byStatus: status, byDeliveryMode, deliveries: delivery, accepted, guardianConsents,
    recentFailures: failures.sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, 25),
    automaticEmailClubs: emailTenants.length ? emailTenants.map((t) => clubName(t) || t) : 'all clubs',
    duplicateSwimmerIds,
  };
}

// Failures recorded in the audit log (error/blocked outcomes) grouped by category.
export function auditFailures(rows = [], { days = 30, now = Date.now() } = {}) {
  const start = periodStart(days, now);
  const byAction = {}; let total = 0; let latest = null;
  for (const r of list(rows)) {
    const st = text(r.status).toLowerCase();
    if (st !== 'error') continue;
    if (!inPeriod(r.at || r.timestamp || r.createdAt, start)) continue;
    total += 1; const a = text(r.action) || 'unknown'; byAction[a] = (byAction[a] || 0) + 1;
    const at = text(r.at || r.timestamp || r.createdAt); if (!latest || at > latest.at) latest = { at, action: a, reason: text(r.reason) };
  }
  return { total, byAction, latest };
}

// Stripe (read only). Objects carry livemode; live and test are reported separately.
export async function stripeSalesReport(stripe, { days = 30, now = Date.now(), maxObjects = 1000, label = 'coaching' } = {}) {
  if (!stripe) return unavailable('Stripe is not configured for this source.');
  const created = Number(days) > 0 ? { gte: Math.floor(periodStart(days, now) / 1000) } : undefined;
  const collect = async (resource, params) => {
    const out = []; let starting_after;
    for (;;) {
      const page = await stripe[resource].list({ limit: 100, ...params, ...(starting_after ? { starting_after } : {}) });
      out.push(...page.data);
      if (!page.has_more || out.length >= maxObjects) return { rows: out, truncated: page.has_more };
      starting_after = page.data[page.data.length - 1].id;
    }
  };
  try {
    const [charges, refunds, subs] = await Promise.all([
      collect('charges', created ? { created } : {}),
      collect('refunds', created ? { created } : {}),
      collect('subscriptions', { status: 'all' }),
    ]);
    const modes = {};
    const bucket = (live) => (modes[live ? 'live' : 'test'] ||= { currency: {}, successfulPayments: 0, failedPayments: 0, refunds: 0, subscriptions: { active: 0, trialing: 0, pastDue: 0, canceledInPeriod: 0, newInPeriod: 0 }, mrrMinor: {} });
    const add = (obj, cur, key, v) => { obj[cur] ||= { grossMinor: 0, refundedMinor: 0 }; obj[cur][key] += v; };
    for (const c of charges.rows) {
      const b = bucket(c.livemode);
      if (c.status === 'succeeded' && c.paid) { b.successfulPayments += 1; add(b.currency, c.currency, 'grossMinor', c.amount); }
      else if (c.status === 'failed') b.failedPayments += 1;
    }
    for (const r of refunds.rows) { if (r.status === 'failed' || r.status === 'canceled') continue; const b = bucket(r.livemode); b.refunds += 1; add(b.currency, r.currency, 'refundedMinor', r.amount); }
    const start = periodStart(days, now) / 1000;
    for (const s of subs.rows) {
      const b = bucket(s.livemode);
      if (s.status === 'active') b.subscriptions.active += 1;
      if (s.status === 'trialing') b.subscriptions.trialing += 1;
      if (s.status === 'past_due' || s.status === 'unpaid') b.subscriptions.pastDue += 1;
      if (s.created >= start) b.subscriptions.newInPeriod += 1;
      if (s.canceled_at && s.canceled_at >= start) b.subscriptions.canceledInPeriod += 1;
      if (s.status === 'active') {
        for (const it of list(s.items?.data)) {
          const p = it.price || {}; const r = p.recurring || {};
          if (!p.unit_amount || !r.interval) continue;
          const perMonth = r.interval === 'month' ? p.unit_amount / (r.interval_count || 1) : r.interval === 'year' ? p.unit_amount / (12 * (r.interval_count || 1)) : null;
          if (perMonth === null) continue;
          b.mrrMinor[p.currency] = (b.mrrMinor[p.currency] || 0) + Math.round(perMonth * (it.quantity || 1));
        }
      }
    }
    for (const m of Object.values(modes)) for (const v of Object.values(m.currency)) v.netOfRefundsMinor = v.grossMinor - v.refundedMinor;
    return { available: true, source: `Stripe API (${label} key, read only)`, modes, truncated: charges.truncated || refunds.truncated || subs.truncated, note: 'Net = gross minus refunds, before Stripe fees and VAT.' };
  } catch (err) {
    const msg = err?.type === 'StripePermissionError' || err?.statusCode === 403 ? 'The configured key cannot read payments (restricted key).' : err?.statusCode === 401 ? 'Stripe rejected the key.' : 'Stripe could not be reached.';
    return unavailable(msg);
  }
}

// Configured prices compared with the amounts in the code (read only).
export async function priceCheck(stripe, entries = []) {
  if (!stripe) return entries.map((e) => ({ ...e, stripe: unavailable('Stripe is not configured.') }));
  return Promise.all(entries.map(async (e) => {
    if (!e.priceId) return { ...e, stripe: unavailable('No Stripe price configured.') };
    try {
      const p = await stripe.prices.retrieve(e.priceId);
      return { ...e, priceId: undefined, stripe: { available: true, amountMinor: p.unit_amount, currency: p.currency, active: p.active, livemode: p.livemode, recurring: p.recurring?.interval || 'one-time', matchesCode: e.expectedMinor === undefined ? null : p.unit_amount === e.expectedMinor } };
    } catch { return { ...e, priceId: undefined, stripe: unavailable('Price could not be read.') }; }
  }));
}

// Webhook receipts (type, mode, outcome, time; no payloads) for the health view.
export function createWebhookLog(storageRoot) {
  const file = path.join(storageRoot, 'ops', 'webhook-events.jsonl');
  return {
    record(source, entry) {
      try { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.appendFileSync(file, `${JSON.stringify({ source, at: new Date().toISOString(), ...entry })}\n`); } catch { /* never block a webhook */ }
    },
    read(limit = 2000) {
      try { return fs.readFileSync(file, 'utf8').trim().split('\n').slice(-limit).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); } catch { return []; }
    },
  };
}
export function webhookSummary(rows = [], source, { days = 30, now = Date.now() } = {}) {
  const start = periodStart(days, now);
  const mine = list(rows).filter((r) => r.source === source);
  const inP = mine.filter((r) => inPeriod(r.at, start));
  const last = mine[mine.length - 1] || null;
  const lastFailure = [...mine].reverse().find((r) => r.ok === false) || null;
  return { received: inP.length, failed: inP.filter((r) => r.ok === false).length, live: inP.filter((r) => r.livemode === true).length, test: inP.filter((r) => r.livemode === false).length, lastAt: last?.at || null, lastType: last?.type || null, lastFailureAt: lastFailure?.at || null };
}
