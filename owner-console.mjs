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
    } catch (err) { return { ...e, priceId: undefined, stripe: unavailable(err?.code === 'resource_missing' || err?.statusCode === 404 ? 'Price not found with this key (wrong Stripe account or mode).' : stripeErrorReason(err)) }; }
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

// ---------------------------------------------------------------------------------------------
// Reconciliation additions (Owner Console finalisation). All read only.
// ---------------------------------------------------------------------------------------------
const iso = (sec) => (Number(sec) > 0 ? new Date(Number(sec) * 1000).toISOString() : null);

// Club databases: every club folder is classified; a folder with no saved database is not a parse
// failure. Nothing is repaired or rewritten here.
export const CLUB_DATA_STATES = Object.freeze({
  ok: 'Readable', empty: 'No data saved yet (folder only)', missing: 'Database file missing but earlier snapshots exist',
  unreadable: 'Database file is not valid JSON', invalid: 'Database file is not a data object',
});
const snapshotNames = (dir) => { try { return fs.readdirSync(dir).filter((n) => n.startsWith('db-') && n.endsWith('.json')).sort(); } catch { return []; } };
export function inspectClubDatabase({ dbPath, snapshotDir }) {
  const snaps = snapshotNames(snapshotDir);
  const latestSnapshot = () => {
    const name = snaps[snaps.length - 1]; if (!name) return { snapshots: 0 };
    let readable = false; try { const v = JSON.parse(fs.readFileSync(path.join(snapshotDir, name), 'utf8')); readable = Boolean(v && typeof v === 'object' && !Array.isArray(v)); } catch {}
    let at = null; try { at = fs.statSync(path.join(snapshotDir, name)).mtime.toISOString(); } catch {}
    return { snapshots: snaps.length, latestSnapshotAt: at, latestSnapshotReadable: readable };
  };
  let stat; try { stat = fs.statSync(dbPath); } catch { stat = null; }
  if (!stat) { const s = latestSnapshot(); return { state: s.snapshots ? 'missing' : 'empty', ...s }; }
  const base = { sizeBytes: stat.size, modifiedAt: stat.mtime.toISOString() };
  let raw; try { raw = fs.readFileSync(dbPath, 'utf8'); } catch { return { state: 'unreadable', detail: 'File could not be read.', ...base, ...latestSnapshot() }; }
  if (!raw.trim()) return { state: 'unreadable', detail: 'File is empty (0 bytes of data).', ...base, ...latestSnapshot() };
  let db; try { db = JSON.parse(raw); } catch (e) {
    // Only the character position is kept from the parser message (it can quote file content).
    const pos = String(e?.message || '').match(/position (\d+)/); return { state: 'unreadable', detail: `Not valid JSON${pos ? ` at character ${pos[1]} of ${raw.length}` : ''}.`, ...base, ...latestSnapshot() };
  }
  if (!db || typeof db !== 'object' || Array.isArray(db)) return { state: 'invalid', detail: `Top level is ${Array.isArray(db) ? 'a list' : typeof db}.`, ...base, ...latestSnapshot() };
  const collections = Object.entries(db).filter(([, v]) => Array.isArray(v));
  return { state: 'ok', ...base, collections: collections.length, rows: collections.reduce((n, [, v]) => n + v.length, 0), swimmers: list(db.swimmers).length, snapshots: snaps.length };
}
export function clubDataReport(keys = [], { pathsOf, clubName = (k) => k, accountsFor = () => 0 } = {}) {
  const clubs = keys.map((key) => { const p = pathsOf(key); return { tenantId: key, club: clubName(key) || key, accounts: accountsFor(key), ...inspectClubDatabase(p) }; });
  const count = (s) => clubs.filter((c) => c.state === s).length;
  const failing = clubs.filter((c) => ['missing', 'unreadable', 'invalid'].includes(c.state));
  return { folders: clubs.length, readable: count('ok'), empty: count('empty'), failing: failing.length, clubs, states: CLUB_DATA_STATES };
}

// Audit log read for a whole period (newest file first) so 30/90-day and all-time figures are not cut
// off at a fixed row count. Reports how far back the stored log actually goes.
export function readAuditForPeriod(dir, activePath, { since = 0, maxRows = 250000 } = {}) {
  let archives = []; try { archives = fs.readdirSync(dir).filter((n) => /^events-.*\.jsonl$/i.test(n)).sort().reverse().map((n) => path.join(dir, n)); } catch {}
  const rows = []; let oldest = null; let reachedStart = false;
  for (const file of [activePath, ...archives]) {
    let raw = ''; try { raw = fs.readFileSync(file, 'utf8'); } catch { continue; }
    const lines = raw.split(/\r?\n/).filter(Boolean).reverse();
    for (const line of lines) {
      let r; try { r = JSON.parse(line); } catch { continue; }
      const t = Date.parse(r?.at || '');
      if (since && Number.isFinite(t) && t < since) { reachedStart = true; break; }
      rows.push(r); if (r?.at) oldest = r.at;
      if (rows.length >= maxRows) return { rows, coverageFrom: oldest, complete: false, truncated: true };
    }
    if (reachedStart) break;
  }
  return { rows, coverageFrom: oldest, complete: reachedStart, truncated: false };
}

// Error outcomes split into software failures and rejected user input (a wrong password is not a
// software error). Each item keeps its time, service, action, reason and route; no names or IPs.
const USER_REJECTION_ACTIONS = new Set(['login_failed', 'register_failed']);
const serviceOf = (a) => (/^(login|register|password|auth|session|email_verif)/.test(a) ? 'Authentication' : /^athlete_invite/.test(a) ? 'Invitations' : /^athlete_link/.test(a) ? 'Athlete account links' : /^swimmer_/.test(a) ? 'Swimmer profile' : /^guardian/.test(a) ? 'Parent / guardian' : /billing|stripe/.test(a) ? 'Billing' : 'Application');
const familyOf = (a) => a.replace(/_(failed|rolled_back|partial|error)$/, '');
export function auditErrorsReport(rows = [], { days = 30, now = Date.now(), coverageFrom = null, complete = true } = {}) {
  const start = periodStart(days, now);
  const ordered = list(rows).filter((r) => Number.isFinite(Date.parse(r?.at || ''))).sort((a, b) => String(a.at).localeCompare(String(b.at)));
  const lastSuccess = new Map();
  const items = [];
  for (let i = ordered.length - 1; i >= 0; i -= 1) {
    const r = ordered[i]; const action = text(r.action); const st = text(r.status).toLowerCase();
    if (st !== 'error') { if (st === 'success' || st === 'info' || st === 'ok') { const f = familyOf(action); if (!lastSuccess.has(f)) lastSuccess.set(f, r.at); } continue; }
    if (!inPeriod(r.at, start)) continue;
    const kind = USER_REJECTION_ACTIONS.has(action) ? 'user' : 'system';
    const later = lastSuccess.get(familyOf(action)) || null;
    items.push({ at: text(r.at), kind, service: serviceOf(action), action, reason: text(r.reason), method: text(r.method), path: text(r.path).slice(0, 120), actorRole: text(r.actorRole), laterSuccessAt: later, state: kind === 'user' ? 'not a software fault' : later ? 'later success recorded' : 'no later success recorded' });
  }
  const system = items.filter((x) => x.kind === 'system');
  const byCategory = {}; for (const x of items) { const k = `${x.service}: ${x.action}${x.reason ? ` (${x.reason})` : ''}`; byCategory[k] = (byCategory[k] || 0) + 1; }
  const signIns = new Set(); for (const r of ordered) if (text(r.action) === 'login_success' && inPeriod(r.at, start)) signIns.add(text(r.actor).toLowerCase());
  return {
    available: true, total: items.length, systemFailures: system.length, userRejections: items.length - system.length,
    unresolvedSystemFailures: system.filter((x) => !x.laterSuccessAt).length,
    byCategory, items: items.slice(0, 200), latest: items[0] || null,
    accountsSignedIn: signIns.size, coverageFrom, periodFullyCovered: complete || !days,
  };
}

// Stripe ledger (read only): transactions, fees, refunds, subscriptions and changes, by mode and product.
export function keyMode(key) { const k = String(key || ''); return { mode: /^(sk|rk)_live_/.test(k) ? 'live' : /^(sk|rk)_test_/.test(k) ? 'test' : 'unknown', restricted: k.startsWith('rk_') }; }
export function stripeErrorReason(err) {
  if (err?.type === 'StripePermissionError' || err?.statusCode === 403) {
    const perms = [...new Set(String(err?.raw?.message || err?.message || '').match(/rak_[a-z_]+/g) || [])];
    return `Restricted Stripe key: missing read permission${perms.length ? ` (${perms.join(', ')})` : ''}.`;
  }
  if (err?.statusCode === 401 || err?.type === 'StripeAuthenticationError') return 'Stripe rejected the key.';
  return 'Stripe could not be reached.';
}
export function classifyCharge(c = {}) {
  const d = text(c.description); const course = text(c.metadata?.course);
  const mod = (course.match(/module0?(\d+)/i) || d.match(/CPD\s*0?1\s*Module\s*0?(\d+)/i) || [])[1];
  if (mod || /CPD/i.test(d)) return mod ? `CPD Module ${String(mod).padStart(2, '0')}` : 'CPD (module not recorded)';
  if (/subscription/i.test(d) || c.invoice) return 'Coaching subscription';
  return 'Other';
}
const maskEmailLite = (e) => { const s = text(e).toLowerCase(); const [u, d] = s.split('@'); return d ? `${u.slice(0, 2)}${'*'.repeat(Math.max(1, Math.min(6, u.length - 2)))}@${d}` : ''; };
const monthly = (p, qty = 1) => { const r = p?.recurring || {}; if (!p?.unit_amount || !r.interval) return null; const n = r.interval_count || 1; return r.interval === 'month' ? (p.unit_amount / n) * qty : r.interval === 'year' ? (p.unit_amount / (12 * n)) * qty : r.interval === 'week' ? (p.unit_amount * 52 / 12 / n) * qty : null; };
export function subscriptionRow(s = {}, priceMap = {}) {
  const items = list(s.items?.data).map((it) => { const p = it.price || {}; const k = priceMap[p.id]; return { product: k?.label || text(p.nickname) || 'Unrecognised price', key: k?.key || null, kind: k?.kind || 'unknown', quantity: it.quantity || 1, amountMinor: p.unit_amount ?? null, currency: p.currency, interval: p.recurring?.interval || null, monthlyMinor: monthly(p, it.quantity || 1) }; });
  const periodEnd = s.current_period_end || Math.max(0, ...list(s.items?.data).map((it) => Number(it.current_period_end) || 0)) || null;
  const cancelAt = s.cancel_at || (s.cancel_at_period_end ? periodEnd : null);
  const ended = s.status === 'canceled' || s.status === 'incomplete_expired';
  const state = ended ? 'cancelled' : cancelAt ? 'scheduled-cancellation' : text(s.status);
  const plan = items.filter((i) => i.kind === 'plan');
  const cust = s.customer && typeof s.customer === 'object' ? s.customer : null;
  return {
    id: text(s.id), livemode: s.livemode === true, status: text(s.status), state,
    customerId: cust ? text(cust.id) : text(s.customer), customer: cust ? [text(cust.name), maskEmailLite(cust.email)].filter(Boolean).join(' · ') : '',
    username: text(s.metadata?.username), plan: plan.map((i) => i.product).join(', ') || null, planKey: plan[0]?.key || null,
    metadataPlanKey: text(s.metadata?.planKey) || null, addons: items.filter((i) => i.kind === 'addon').map((i) => `${i.product}${i.quantity > 1 ? ` × ${i.quantity}` : ''}`),
    items, monthlyMinor: Math.round(items.reduce((n, i) => n + (i.monthlyMinor || 0), 0)), currency: items[0]?.currency || 'gbp',
    createdAt: iso(s.created), currentPeriodEnd: iso(periodEnd),
    cancellationRequestedAt: iso(s.canceled_at), cancellationEffectiveAt: ended ? iso(s.ended_at || s.canceled_at) : iso(cancelAt), endedAt: iso(s.ended_at),
    cancellationReason: text(s.cancellation_details?.reason || s.cancellation_details?.feedback) || null,
  };
}
const changeOf = (prevItems, nextItems, priceMap) => {
  const sum = (items) => list(items).reduce((n, it) => n + (monthly(it.price, it.quantity || 1) || 0), 0);
  const label = (items) => list(items).map((it) => `${priceMap[it.price?.id]?.label || 'Unrecognised price'}${(it.quantity || 1) > 1 ? ` × ${it.quantity}` : ''}`).join(' + ');
  const a = sum(prevItems); const b = sum(nextItems);
  return { from: label(prevItems), to: label(nextItems), fromMonthlyMinor: Math.round(a), toMonthlyMinor: Math.round(b), change: b > a ? 'upgrade' : b < a ? 'downgrade' : 'changed (same monthly amount)' };
};
export async function stripeLedger(stripe, { days = 30, now = Date.now(), label = 'coaching', priceMap = {}, keyInfo = { mode: 'unknown', restricted: false }, maxObjects = 1000 } = {}) {
  if (!stripe) return unavailable('Stripe is not configured for this source.');
  const startSec = Math.floor(periodStart(days, now) / 1000);
  const created = startSec > 0 ? { created: { gte: startSec } } : {};
  const collect = async (resource, params) => {
    const out = []; let starting_after;
    for (;;) {
      const page = await stripe[resource].list({ limit: 100, ...params, ...(starting_after ? { starting_after } : {}) });
      out.push(...page.data);
      if (!page.has_more || out.length >= maxObjects) return { rows: out, truncated: page.has_more };
      starting_after = page.data[page.data.length - 1].id;
    }
  };
  // Optional parts: a restricted key may read charges but not expansions, invoices or events.
  const optional = async (fn) => { try { return { ok: true, ...(await fn()) }; } catch (err) { return { ok: false, reason: stripeErrorReason(err), rows: [] }; } };
  let charges;
  try { charges = await collect('charges', { ...created, expand: ['data.balance_transaction'] }); }
  catch (err) {
    if (err?.type === 'StripePermissionError' || err?.statusCode === 403) { try { charges = await collect('charges', created); charges.feesUnavailable = stripeErrorReason(err); } catch (e2) { return { ...unavailable(stripeErrorReason(e2)), key: keyInfo, source: `Stripe API (${label} key, read only)` }; } }
    else return { ...unavailable(stripeErrorReason(err)), key: keyInfo, source: `Stripe API (${label} key, read only)` };
  }
  const [refunds, subsAll, invoices, events] = await Promise.all([
    optional(() => collect('refunds', created)),
    optional(() => collect('subscriptions', { status: 'all', expand: ['data.customer'] }).catch((err) => (err?.statusCode === 403 ? collect('subscriptions', { status: 'all' }) : Promise.reject(err)))),
    optional(() => collect('invoices', created)),
    optional(() => collect('events', { type: 'customer.subscription.updated', ...created })),
  ]);
  const refundsByCharge = new Map(); for (const r of refunds.rows) { if (r.status === 'failed' || r.status === 'canceled') continue; const k = typeof r.charge === 'object' ? r.charge?.id : r.charge; refundsByCharge.set(k, [...(refundsByCharge.get(k) || []), r]); }
  const modes = {};
  const M = (live) => (modes[live ? 'live' : 'test'] ||= {
    payments: { succeeded: 0, pending: 0, failed: 0 }, currency: {}, byProduct: {}, refunds: 0,
    subscriptions: { active: 0, trialing: 0, scheduledToCancel: 0, pastDue: 0, cancelledAllTime: 0, cancelledInPeriod: 0, newInPeriod: 0, current: 0, everCreated: 0 },
    mrrMinor: { continuing: {}, ending: {} }, renewals: 0, changes: [], failedSubscriptionPayments: 0, addonsActive: {},
  });
  const transactions = [];
  for (const c of charges.rows) {
    const m = M(c.livemode); const product = classifyCharge(c);
    const status = c.status === 'succeeded' ? 'succeeded' : c.status === 'pending' ? 'pending' : 'failed';
    m.payments[status] += 1;
    const bt = c.balance_transaction && typeof c.balance_transaction === 'object' ? c.balance_transaction : null;
    const rf = refundsByCharge.get(c.id) || [];
    const refundedMinor = rf.length ? rf.reduce((n, r) => n + r.amount, 0) : (c.amount_refunded || 0);
    if (status === 'succeeded') {
      const cur = (m.currency[c.currency] ||= { grossMinor: 0, refundedMinor: 0, feeMinor: 0, feesKnown: 0, payments: 0 });
      cur.grossMinor += c.amount; cur.refundedMinor += refundedMinor; cur.payments += 1;
      if (bt) { cur.feeMinor += bt.fee || 0; cur.feesKnown += 1; }
      const p = (m.byProduct[product] ||= { payments: 0, grossMinor: 0, refundedMinor: 0, currency: c.currency }); p.payments += 1; p.grossMinor += c.amount; p.refundedMinor += refundedMinor;
    }
    m.refunds += rf.length;
    transactions.push({
      id: text(c.id), at: iso(c.created), mode: c.livemode ? 'live' : 'test', status, product, description: text(c.description).slice(0, 120),
      payer: [text(c.billing_details?.name), maskEmailLite(c.billing_details?.email || c.receipt_email)].filter(Boolean).join(' · ') || 'Not recorded',
      amountMinor: c.amount, currency: c.currency, feeMinor: bt ? bt.fee : null, netMinor: bt ? bt.net - refundedMinor : null, fundsStatus: bt ? text(bt.status) : null,
      refundedMinor, refunds: rf.map((r) => ({ at: iso(r.created), amountMinor: r.amount, status: text(r.status), reason: text(r.reason) || null })),
      failureReason: status === 'failed' ? text(c.failure_message || c.outcome?.seller_message).slice(0, 160) : null,
    });
  }
  for (const m of Object.values(modes)) for (const v of Object.values(m.currency)) {
    v.netOfRefundsMinor = v.grossMinor - v.refundedMinor;
    v.netAfterFeesMinor = v.feesKnown === v.payments ? v.grossMinor - v.refundedMinor - v.feeMinor : null;
    if (v.feesKnown !== v.payments) v.feeMinor = null;
  }
  const subscriptions = subsAll.rows.map((s) => subscriptionRow(s, priceMap));
  for (const s of subscriptions) {
    const m = M(s.livemode); m.subscriptions.everCreated += 1;
    if (Date.parse(s.createdAt) >= startSec * 1000) m.subscriptions.newInPeriod += 1;
    if (s.state === 'cancelled') { m.subscriptions.cancelledAllTime += 1; if (Date.parse(s.cancellationEffectiveAt || '') >= startSec * 1000) m.subscriptions.cancelledInPeriod += 1; continue; }
    m.subscriptions.current += 1;
    if (s.status === 'trialing') m.subscriptions.trialing += 1;
    if (s.status === 'past_due' || s.status === 'unpaid') m.subscriptions.pastDue += 1;
    if (s.status === 'active') {
      m.subscriptions.active += 1;
      const bucket = s.state === 'scheduled-cancellation' ? m.mrrMinor.ending : m.mrrMinor.continuing;
      bucket[s.currency] = (bucket[s.currency] || 0) + s.monthlyMinor;
      for (const i of s.items) if (i.kind === 'addon') m.addonsActive[i.product] = (m.addonsActive[i.product] || 0) + i.quantity;
    }
    if (s.state === 'scheduled-cancellation') m.subscriptions.scheduledToCancel += 1;
  }
  for (const inv of invoices.rows) {
    const m = M(inv.livemode);
    if (inv.billing_reason === 'subscription_cycle' && inv.status === 'paid') m.renewals += 1;
    if ((inv.status === 'open' && (inv.attempt_count || 0) > 0) || inv.status === 'uncollectible') m.failedSubscriptionPayments += 1;
  }
  for (const e of events.rows) {
    const prev = e.data?.previous_attributes?.items?.data; if (!prev) continue;
    const s = e.data.object || {}; M(e.livemode).changes.push({ at: iso(e.created), subscription: text(s.id), ...changeOf(prev, s.items?.data, priceMap) });
  }
  const notes = [];
  if (charges.feesUnavailable) notes.push(`Fees: ${charges.feesUnavailable}`);
  if (!refunds.ok) notes.push(`Refunds: ${refunds.reason}`);
  if (!subsAll.ok) notes.push(`Subscriptions: ${subsAll.reason}`);
  if (!invoices.ok) notes.push(`Renewals and failed subscription payments: ${invoices.reason}`);
  if (!events.ok) notes.push(`Upgrades and downgrades: ${events.reason}`);
  return {
    available: true, source: `Stripe API (${label} key, read only)`, key: keyInfo, modes,
    parts: { refunds: refunds.ok, subscriptions: subsAll.ok, invoices: invoices.ok, changes: events.ok, fees: !charges.feesUnavailable },
    transactions: transactions.slice(0, 200), subscriptions: subscriptions.slice(0, 200),
    truncated: Boolean(charges.truncated || refunds.truncated || subsAll.truncated || invoices.truncated),
    notes, explanation: 'Gross = successful payments. Net after fees = gross − refunds − Stripe fees. A cancellation stops future billing; it is not a refund. Upgrades and downgrades come from Stripe events, which Stripe keeps for 30 days.',
  };
}

// Account billing records compared with Stripe subscriptions (customer id link).
export function billingReconciliation(subscriptions = [], users = []) {
  const byCustomer = new Map(list(users).filter((u) => text(u?.billing?.customerId)).map((u) => [text(u.billing.customerId), u]));
  const latest = new Map(); for (const s of list(subscriptions)) { const prev = latest.get(s.customerId); if (!prev || String(s.createdAt) > String(prev.createdAt)) latest.set(s.customerId, s); }
  const rows = [];
  for (const [customerId, s] of latest) {
    const u = byCustomer.get(customerId) || null; const b = u?.billing || {};
    const issues = [];
    if (!u) issues.push('No AthlyraX account linked to this Stripe customer');
    else {
      if (text(b.status) !== s.status) issues.push(`Account status ${text(b.status) || 'none'} ≠ Stripe ${s.status}`);
      if (s.state !== 'cancelled' && s.planKey && text(b.planKey) !== s.planKey) issues.push(`Account plan ${text(b.planKey) || 'none'} ≠ Stripe ${s.planKey}`);
      if (s.state === 'scheduled-cancellation' && b.cancelAtPeriodEnd !== true) issues.push('Stripe has a scheduled cancellation; account does not');
    }
    rows.push({ customerId, mode: s.livemode ? 'live' : 'test', username: text(u?.username) || null, subscription: s.id, stripeState: s.state, stripePlan: s.planKey, accountPlan: text(b.planKey) || null, accountStatus: text(b.status) || null, matches: issues.length === 0, issues });
  }
  return rows;
}

// Invitation reconciliation: counts that must add up, duplicates and consent.
export function invitationChecks(tenants = [], { now = Date.now(), inviteStatus } = {}) {
  let open = 0; let duplicateOpen = 0; let guardianRequired = 0; let guardianConsented = 0; let guardianPending = 0; let emailWithoutAttempt = 0; let superseded = 0;
  for (const { db } of tenants) {
    const openBySwimmer = new Map();
    for (const inv of list(db?.athleteAccountInvites)) {
      const s = inviteStatus(inv, now);
      if (inv.supersededBy) superseded += 1;
      if (inv.guardianRequired) { guardianRequired += 1; if (inv.guardianConsent?.at) guardianConsented += 1; else if (s === 'awaiting-guardian') guardianPending += 1; }
      if (inv.delivery === 'email' && !list(inv.deliveries).length) emailWithoutAttempt += 1;
      if (s === 'pending' || s === 'awaiting-guardian') { open += 1; const k = text(inv.swimmerId); openBySwimmer.set(k, (openBySwimmer.get(k) || 0) + 1); }
    }
    for (const n of openBySwimmer.values()) if (n > 1) duplicateOpen += n - 1;
  }
  return { open, duplicateOpenInvitations: duplicateOpen, superseded, guardianRequired, guardianConsented, guardianPending, emailInvitesWithoutSendAttempt: emailWithoutAttempt };
}
