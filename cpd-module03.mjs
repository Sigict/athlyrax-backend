import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import express from 'express';
import Stripe from 'stripe';
import { buildCertificatePdf } from './cpd-module02.mjs';

// AthlyraX Education — CPD 01, Module 03 (one-time £4.99 course).
// Independent of the coaching-software subscription system: its own Stripe price,
// its own learner entitlements and its own private files under <storage>/cpd/module-03.
// Every route fails closed until the owner has configured it.

export const CPD_MODULE03_COURSE = 'cpd01-module03';
const COOKIE = 'athlyrax_cpd03';
const COOKIE_PATH = '/api/cpd/module-03';
const ACCESS_TTL_S = 400 * 24 * 3600;             // learner cookie lifetime (renewed on every visit)
const REVERIFY_MS = 6 * 3600 * 1000;               // re-check refunds/disputes with Stripe this often
const STRIPE_OUTAGE_GRACE_MS = 7 * 24 * 3600 * 1000;
const RECOVERY_TTL_MS = 30 * 60 * 1000;
const MAX_DEVICES = 10;                            // claims/recoveries per purchase
const CHUNK_MAX = 4 * 1024 * 1024;                 // bytes per video response (proxy friendly)
const UPLOAD_CHUNK_MAX = 8 * 1024 * 1024;
const UPLOAD_TOTAL_MAX = 2 * 1024 * 1024 * 1024;
const WATCH_REQUIRED = 0.8;                        // share of a lesson file that must have been streamed
const PRICE_PENCE = 499;
const LESSONS = Object.freeze([
  { n: 1, file: 'lesson-1.mp4', title: 'Design the Stimulus', duration: 'Video 1' },
  { n: 2, file: 'lesson-2.mp4', title: 'Match the Stimulus', duration: 'Video 2' },
  { n: 3, file: 'lesson-3.mp4', title: 'Coach the Response', duration: 'Video 3' },
]);
const SECTIONS = Object.freeze({ 'check-1': { afterLesson: 1, count: 3 }, 'check-2': { afterLesson: 2, count: 3 }, 'check-3': { afterLesson: 3, count: 3 }, final: { afterLesson: 3, count: 10 } });
const COURSE_TITLE = 'CPD 01 - Module 03: Swimming Set Design - From Purpose to Practice';

const sha = (x) => crypto.createHash('sha256').update(String(x)).digest('hex');
const emailValid = (x) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(x) && x.length <= 254;
const sessionIdValid = (x) => /^cs_(test_|live_)?[A-Za-z0-9]{10,170}$/.test(x);
const fixedTimeEqual = (a, b) => { const x = Buffer.from(String(a)); const y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };
const fail = (res, status, message, extra = {}) => res.status(status).set('Cache-Control', 'no-store').json({ error: message, ...extra });
const cleanName = (x) => String(x || '').replace(/[\u0000-\u001f\u007f<>]/g, '').replace(/\s+/g, ' ').trim();

function cookieValue(req, name) {
  const part = String(req.headers.cookie || '').split(';').map((s) => s.trim()).find((s) => s.startsWith(name + '='));
  return part ? part.slice(name.length + 1) : '';
}

function loadQuestions() {
  const file = path.join(path.dirname(new URL(import.meta.url).pathname), 'cpd-module03-private-questions.json');
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const q = raw.questions;
  const ok = Array.isArray(q) && q.length === 19 && Object.entries(SECTIONS).every(([s, d]) => q.filter((x) => x.section === s).length === d.count)
    && q.every((x) => typeof x.id === 'string' && typeof x.question === 'string' && Array.isArray(x.options) && x.options.length === 4
      && Number.isInteger(x.correct_option_index) && x.correct_option_index >= 0 && x.correct_option_index < 4);
  if (!ok) throw Error('CPD Module 3 question bank invalid');
  return q;
}

// ---------- small JSON store (atomic writes, private file modes) ----------
function makeStore(root) {
  const file = (kind, key) => path.join(root, kind, sha(key) + '.json');
  return {
    read(kind, key) { try { return JSON.parse(fs.readFileSync(file(kind, key), 'utf8')); } catch { return null; } },
    write(kind, key, value) {
      const f = file(kind, key); fs.mkdirSync(path.dirname(f), { recursive: true, mode: 0o700 });
      const tmp = f + '.' + crypto.randomBytes(8).toString('hex') + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(value), { mode: 0o600, flag: 'wx' }); fs.renameSync(tmp, f);
    },
    remove(kind, key) { try { fs.unlinkSync(file(kind, key)); } catch {} },
  };
}

// Simple fixed-window limiter kept in memory (per process).
function limiter(max, windowMs) {
  const hits = new Map();
  return (key) => {
    const now = Date.now(); const h = hits.get(key);
    if (!h || now - h.start > windowMs) { hits.set(key, { start: now, n: 1 }); if (hits.size > 5000) hits.clear(); return true; }
    h.n += 1; return h.n <= max;
  };
}

function mergeRanges(ranges) {
  const sorted = ranges.filter((r) => Array.isArray(r) && r[1] >= r[0]).sort((a, b) => a[0] - b[0]); const out = [];
  for (const r of sorted) { const last = out[out.length - 1]; if (last && r[0] <= last[1] + 1) last[1] = Math.max(last[1], r[1]); else out.push([r[0], r[1]]); }
  return out.slice(0, 400);
}
const coveredBytes = (ranges) => ranges.reduce((s, r) => s + (r[1] - r[0] + 1), 0);

export function registerCpdModule03(app, deps) {
  const { storageRoot, requireStrictAuth, requireSoftwareOwnerRole, sendMail = null, isSoftwareOwner = () => false } = deps;
  const root = path.join(storageRoot, 'cpd', 'module-03');
  const store = makeStore(root);
  const secret = String(process.env.CPD_SESSION_SECRET || '').trim();
  const priceId = String(process.env.CPD_MODULE03_PRICE_ID || '').trim();
  const salesFlag = process.env.CPD_MODULE03_SALES_ENABLED === 'true';
  const origin = String(process.env.CPD_SITE_ORIGIN || 'https://athlyrax.com').replace(/\/+$/, '');
  const courseKey = String(process.env.CPD_MODULE03_STRIPE_SECRET_KEY || process.env.CPD_STRIPE_SECRET_KEY || '').trim();
  const stripe = deps.courseStripeClient || (courseKey ? new Stripe(courseKey) : null);
  const configuredKey = courseKey;
  const stripeMode = deps.courseStripeMode || (/^(sk|rk)_test_/.test(configuredKey) ? 'test' : 'live');
  // Optional guard: the Stripe account the course must use (non-secret, e.g. acct_...).
  // When set, the course stays closed unless the key in use belongs to that account.
  const expectedAccount = String(process.env.CPD_STRIPE_EXPECTED_ACCOUNT || '').trim();
  const keySource = deps.courseStripeClient ? 'injected' : courseKey ? 'Dedicated CPD key configured' : 'not configured';
  // Environment variables are read once when the server process starts; a changed
  // Render variable takes effect only after the service restarts or redeploys.
  const serverStartedAt = new Date().toISOString();
  // Non-secret Stripe configuration check, cached for 10 minutes.
  let configCheck = null, configCheckAt = 0;
  async function stripeConfigCheck(force = false) {
    if (!stripe) return null;
    if (!force && configCheck && Date.now() - configCheckAt < 600000) return configCheck;
    const out = { accountId: null, livemode: null, accountError: null, accountLookupRestricted: false, price: null, verifiedByPrice: false };
    try { const a = await stripe.accounts.retrieve(); out.accountId = String(a?.id || ''); out.livemode = Boolean(a?.livemode); }
    catch (err) {
      out.accountLookupRestricted = err?.statusCode === 403 || err?.type === 'StripePermissionError';
      out.accountError = err?.statusCode === 401 ? 'Stripe API key rejected'
        : out.accountLookupRestricted ? 'Restricted Stripe key cannot retrieve account details'
        : 'Stripe account lookup unavailable';
    }
    if (priceId) {
      try {
        const p = await stripe.prices.retrieve(priceId);
        out.price = { found: true, active: Boolean(p.active), oneTime: p.type === 'one_time', gbp: String(p.currency).toLowerCase() === 'gbp', amount: p.unit_amount, livemode: Boolean(p.livemode),
          validForSale: Boolean(p.active) && p.type === 'one_time' && String(p.currency).toLowerCase() === 'gbp' && p.unit_amount === PRICE_PENCE };
      } catch (err) { out.price = { found: false, error: err?.code === 'resource_missing' ? 'Price ID does not exist in this Stripe account' : err?.statusCode === 401 ? 'Stripe key rejected' : 'Price lookup failed' }; }
    }
    out.expectedAccountMatches = expectedAccount ? (out.accountId ? out.accountId === expectedAccount : null) : null;
    // Stripe restricted keys may not have GET /v1/account permission. A successful
    // retrieval of the *specific configured* active GBP 499 price in the expected
    // mode proves that this key can reach the selected course price; do not
    // require wider account permissions just for this optional account-ID check.
    out.verifiedByPrice = Boolean(expectedAccount && out.accountLookupRestricted && !out.accountId
      && out.price?.validForSale && out.price?.livemode === (stripeMode === 'live'));
    configCheck = out; configCheckAt = Date.now();
    return out;
  }
  const accountGuardOk = () => !expectedAccount || configCheck?.expectedAccountMatches === true || configCheck?.verifiedByPrice === true;
  const questions = loadQuestions();
  let logoJpeg = null;
  try { logoJpeg = fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), 'cpd-assets', 'athlyrax-logo.jpg')); } catch {}
  const checkoutLimit = limiter(20, 3600 * 1000), recoverIpLimit = limiter(10, 3600 * 1000), recoverEmailLimit = limiter(3, 3600 * 1000), verifyLimit = limiter(60, 3600 * 1000);
  const lessonPath = (n) => path.join(root, LESSONS[n - 1].file);
  const lessonSize = (n) => { try { const st = fs.statSync(lessonPath(n)); return st.isFile() && st.size > 1024 ? st.size : 0; } catch { return 0; } };
  const videosReady = () => LESSONS.every((l) => lessonSize(l.n) > 0);
  const setup = () => ({ videos: videosReady(), signingKey: secret.length >= 32, price: Boolean(priceId), stripe: Boolean(stripe) && accountGuardOk(), salesSwitch: salesFlag, recoveryEmail: Boolean(sendMail) });
  // Purchase confirmation must be deliverable to the buyer on a durable medium.
  const salesOpen = () => Object.values(setup()).every(Boolean);
  const ipOf = (req) => String(req.ip || req.socket?.remoteAddress || '');

  // ---------- Stripe verification ----------
  function sessionProblem(cs) {
    if (!cs) return 'not found';
    if (cs.mode !== 'payment') return 'not a one-time payment';
    if (cs.payment_status !== 'paid') return 'not paid';
    if (cs.metadata?.course !== CPD_MODULE03_COURSE) return 'different product';
    if (cs.amount_total !== PRICE_PENCE || String(cs.currency).toLowerCase() !== 'gbp') return 'unexpected amount';
    return '';
  }
  function chargeProblem(cs) {
    const pi = cs.payment_intent && typeof cs.payment_intent === 'object' ? cs.payment_intent : null;
    const charge = pi?.latest_charge && typeof pi.latest_charge === 'object' ? pi.latest_charge : null;
    if (pi && pi.status && pi.status !== 'succeeded') return 'payment ' + pi.status;
    if (charge?.refunded || Number(charge?.amount_refunded || 0) > 0) return 'refunded';
    if (charge?.disputed) return 'disputed';
    return '';
  }
  async function fetchSession(id) {
    return stripe.checkout.sessions.retrieve(id, { expand: ['payment_intent.latest_charge'] });
  }
  function entitlementFromSession(cs, previous) {
    const pi = typeof cs.payment_intent === 'object' ? cs.payment_intent?.id : cs.payment_intent;
    return {
      course: CPD_MODULE03_COURSE, sessionId: cs.id, mode: cs.livemode ? 'live' : 'test',
      email: String(cs.customer_details?.email || cs.customer_email || previous?.email || '').trim().toLowerCase(),
      name: cleanName(cs.metadata?.learner_name || previous?.name || 'Learner').slice(0, 110),
      paymentIntent: String(pi || previous?.paymentIntent || ''),
      status: previous?.status === 'revoked' ? 'revoked' : 'active', revokedReason: previous?.revokedReason || '',
      createdAt: previous?.createdAt || new Date().toISOString(), verifiedAt: Date.now(), devices: previous?.devices || 0,
    };
  }
  function saveEntitlement(ent) {
    store.write('entitlements', ent.sessionId, ent);
    if (ent.email) { const idx = store.read('emails', ent.email) || { sessionIds: [] }; if (!idx.sessionIds.includes(ent.sessionId)) { idx.sessionIds.push(ent.sessionId); store.write('emails', ent.email, idx); } }
    if (ent.paymentIntent) store.write('payments', ent.paymentIntent, { sessionId: ent.sessionId });
  }
  function revoke(ent, reason) {
    if (!ent || ent.status === 'revoked') return;
    ent.status = 'revoked'; ent.revokedReason = reason; ent.revokedAt = new Date().toISOString(); saveEntitlement(ent);
  }
  // Verify (or re-verify) one purchase with Stripe and store the result.
  async function verifyPurchase(id) {
    const cs = await fetchSession(id);
    const previous = store.read('entitlements', id);
    const problem = sessionProblem(cs);
    if (problem) { if (previous) revoke(previous, problem); return { ent: previous, problem }; }
    const ent = entitlementFromSession(cs, previous);
    const cp = chargeProblem(cs);
    if (cp) { ent.status = 'revoked'; ent.revokedReason = cp; ent.revokedAt = ent.revokedAt || new Date().toISOString(); }
    saveEntitlement(ent);
    return { ent, problem: ent.status === 'revoked' ? ent.revokedReason : '' };
  }

  // ---------- learner access cookie ----------
  function sign(data) { const p = Buffer.from(JSON.stringify(data)).toString('base64url'); return p + '.' + crypto.createHmac('sha256', secret).update(p).digest('base64url'); }
  function readCookie(req) {
    if (secret.length < 32) return null;
    const v = cookieValue(req, COOKIE), dot = v.lastIndexOf('.'); if (dot < 1) return null;
    const p = v.slice(0, dot), mac = v.slice(dot + 1);
    if (!fixedTimeEqual(mac, crypto.createHmac('sha256', secret).update(p).digest('base64url'))) return null;
    try { const d = JSON.parse(Buffer.from(p, 'base64url').toString('utf8')); return d?.course === CPD_MODULE03_COURSE && sessionIdValid(String(d.id)) && d.exp > Date.now() / 1000 ? d : null; } catch { return null; }
  }
  function setAccessCookie(res, id) {
    res.cookie(COOKIE, sign({ course: CPD_MODULE03_COURSE, id, exp: Math.floor(Date.now() / 1000) + ACCESS_TTL_S }), { httpOnly: true, secure: true, sameSite: 'lax', path: COOKIE_PATH, maxAge: ACCESS_TTL_S * 1000 });
  }
  // The learner's active entitlement, or null. Stripe is consulted only every few hours.
  async function learner(req) {
    const c = readCookie(req); if (!c) return null;
    let ent = store.read('entitlements', c.id);
    if (!ent || ent.status !== 'active') return null;
    if (Date.now() - Number(ent.verifiedAt || 0) > REVERIFY_MS && stripe) {
      try { ent = (await verifyPurchase(c.id)).ent; } catch { if (Date.now() - Number(ent.verifiedAt || 0) > STRIPE_OUTAGE_GRACE_MS) return null; }
    }
    return ent && ent.status === 'active' ? ent : null;
  }

  // ---------- progress ----------
  const emptyProgress = (id) => ({ course: CPD_MODULE03_COURSE, sessionId: id, lessons: [], checks: [], watched: { 1: [], 2: [], 3: [] }, finalAttempts: 0, bestFinal: 0 });
  const progressCache = new Map(); // sessionId -> { record, dirty, savedAt }
  function getProgress(id) {
    let e = progressCache.get(id);
    if (!e) { const r = store.read('progress', id); e = { record: r && r.sessionId === id ? { ...emptyProgress(id), ...r } : emptyProgress(id), dirty: false, savedAt: Date.now() }; progressCache.set(id, e); if (progressCache.size > 2000) progressCache.delete(progressCache.keys().next().value); }
    return e.record;
  }
  function saveProgress(id, now = false) {
    const e = progressCache.get(id); if (!e) return;
    e.dirty = true;
    if (now || Date.now() - e.savedAt > 15000) { store.write('progress', id, e.record); e.dirty = false; e.savedAt = Date.now(); }
  }
  const watchedShare = (record, n) => { const size = lessonSize(n); return size ? Math.min(1, coveredBytes(record.watched?.[n] || []) / size) : 0; };
  function progressView(id) {
    const p = getProgress(id);
    return { lessons: p.lessons, checks: p.checks, watched: Object.fromEntries(LESSONS.map((l) => [l.n, Math.round(watchedShare(p, l.n) * 100)])), finalAttempts: p.finalAttempts, bestFinal: p.bestFinal };
  }

  const base = '/cpd/module-03';
  const noStore = (res) => res.set('Cache-Control', 'no-store');

  // Signing out clears only this device's learner session; the purchase and progress remain.
  app.post(base + '/logout', (req, res) => {
    noStore(res);
    res.clearCookie(COOKIE, { httpOnly: true, secure: true, sameSite: 'lax', path: COOKIE_PATH });
    res.status(200).json({ ok: true });
  });

  app.get(base + '/status', async (req, res) => {
    noStore(res);
    let ent = null; try { ent = await learner(req); } catch {}
    const revoked = (() => { const c = readCookie(req); const e = c && store.read('entitlements', c.id); return e && e.status === 'revoked' ? e.revokedReason || 'revoked' : ''; })();
    const completion = ent ? store.read('completions', ent.sessionId) : null;
    if (ent) setAccessCookie(res, ent.sessionId); // keep returning learners signed in
    let check = null; try { check = await stripeConfigCheck(); } catch {}
    res.json({
      course: CPD_MODULE03_COURSE, title: COURSE_TITLE, price: { amount: PRICE_PENCE, currency: 'gbp' },
      salesEnabled: salesOpen(), testMode: stripeMode === 'test', setup: setup(),
      // Non-secret: which key is in use and whether the configured price exists in
      // that key's Stripe account. No key, account ID or raw provider error.
      stripeConfig: { keySource, mode: stripeMode, serverStartedAt,
        priceInKeyAccount: check?.price ? check.price.found === true : null,
        priceValidForSale: check?.price?.found ? check.price.validForSale : null,
        expectedAccountMatches: check ? check.expectedAccountMatches : null, verifiedByPrice: check?.verifiedByPrice === true },
      lessons: LESSONS.map((l) => ({ n: l.n, title: l.title, duration: l.duration })),
      paidAccess: Boolean(ent), accessRevoked: revoked,
      learner: ent ? { name: ent.name, email: ent.email.replace(/^(.).*(@.*)$/, '$1***$2') } : null,
      progress: ent ? progressView(ent.sessionId) : null,
      certificate: completion ? { id: completion.certificateId, completedAt: completion.completedAt, score: completion.score } : null,
    });
  });

  app.post(base + '/checkout', async (req, res) => {
    // Warm the account guard before checking salesOpen: otherwise the first
    // customer checkout after a process restart can be incorrectly denied.
    if (expectedAccount) {
      let check = null; try { check = await stripeConfigCheck(true); } catch {}
      if (check?.expectedAccountMatches === false) return fail(res, 503, 'Course Stripe key belongs to a different Stripe account than CPD_STRIPE_EXPECTED_ACCOUNT.');
      if (check?.expectedAccountMatches !== true && check?.verifiedByPrice !== true) return fail(res, 503, 'Course Stripe key cannot verify the configured live course price or expected account.');
    }
    if (!salesOpen()) return fail(res, 503, 'Course purchase is not yet open.');
    if (stripeMode === 'test' && !isSoftwareOwner(req)) return fail(res, 503, 'Course purchase is in owner testing and not yet open.');
    if (!checkoutLimit(ipOf(req))) return fail(res, 429, 'Too many attempts. Please try again later.');
    const email = String(req.body?.email || '').trim().toLowerCase(), name = cleanName(req.body?.fullName);
    if (!emailValid(email) || name.length < 2 || name.length > 110) return fail(res, 400, 'Enter your full name (as it should appear on the certificate) and a valid email address.');
    if (req.body?.digitalContentConsent !== true || req.body?.cancellationAcknowledged !== true) return fail(res, 400, 'Express consent to immediate digital access and acknowledgement of losing the 14-day cancellation right are required.');
    try {
      const price = await stripe.prices.retrieve(priceId);
      if (!price.active || price.type !== 'one_time' || String(price.currency).toLowerCase() !== 'gbp' || price.unit_amount !== PRICE_PENCE) return fail(res, 503, 'Course price is not configured for sale.');
      const cs = await stripe.checkout.sessions.create({
        mode: 'payment', customer_email: email,
        line_items: [{ price: priceId, quantity: 1 }],
        success_url: origin + '/education/module-03.html?session_id={CHECKOUT_SESSION_ID}',
        cancel_url: origin + '/education/module-03.html?checkout=cancelled',
        metadata: { course: CPD_MODULE03_COURSE, learner_name: name, digital_access_consent: 'yes', cancellation_acknowledged: 'yes', consent_recorded_at: new Date().toISOString(), consent_version: '2026-11-06' },
        payment_intent_data: { metadata: { course: CPD_MODULE03_COURSE, digital_access_consent: 'yes', cancellation_acknowledged: 'yes', consent_version: '2026-11-06' }, description: 'AthlyraX Education - CPD 01 Module 03' },
        allow_promotion_codes: false,
      });
      noStore(res).json({ url: cs.url });
    } catch (err) {
      // Stripe errors must not leak tokens, request details or raw provider messages.
      // A missing price is usually a mismatch between the secret key's Stripe
      // account and CPD_MODULE03_PRICE_ID, not a customer's payment failure.
      if (err?.code === 'resource_missing' && err?.param === 'price') {
        return fail(res, 503, 'Course Stripe price is not in the configured Stripe account. Check the CPD Stripe key and price ID.');
      }
      if (err?.code === 'resource_missing' && /price/i.test(String(err?.message || ''))) {
        return fail(res, 503, 'Course Stripe price is not in the configured Stripe account. Check the CPD Stripe key and price ID.');
      }
      if (err?.type === 'StripeAuthenticationError' || err?.statusCode === 401) {
        return fail(res, 503, 'Course Stripe test key is invalid or no longer active. Check CPD_STRIPE_SECRET_KEY.');
      }
      if (err?.type === 'StripePermissionError' || err?.statusCode === 403) {
        return fail(res, 503, 'Course Stripe key cannot create checkout sessions. Check its account and permissions.');
      }
      // Retain generic messaging for all other errors. Do not weaken the
      // payment, owner-only test or CSRF controls in order to bypass failure.
      fail(res, 502, 'Could not start the secure checkout. Please try again.');
    }
  });

  app.post(base + '/claim', async (req, res) => {
    if (secret.length < 32 || !stripe) return fail(res, 503, 'Course access is not configured.');
    const id = String(req.body?.session_id || '').trim();
    if (!sessionIdValid(id)) return fail(res, 400, 'Invalid checkout reference.');
    let result; try { result = await verifyPurchase(id); } catch { return fail(res, 502, 'Payment could not be verified just now. Please reload the page.'); }
    if (result.problem || !result.ent) return fail(res, 403, result.problem === 'refunded' || result.problem === 'disputed' ? 'This purchase was refunded or disputed, so course access has ended.' : 'No verified course purchase was found.');
    const ent = result.ent;
    if (!readCookie(req) || readCookie(req).id !== id) {
      if (ent.devices >= MAX_DEVICES) return fail(res, 403, 'This purchase has been opened on too many devices. Use "Restore access" with your purchase email.');
      ent.devices += 1; saveEntitlement(ent);
    }
    setAccessCookie(res, id);
    noStore(res).json({ paidAccess: true, learner: { name: ent.name } });
  });

  // Returning learners on a new device: a single-use link is emailed to the purchase address.
  app.post(base + '/recover', async (req, res) => {
    const generic = { sent: true, message: 'If that email address bought this course, a sign-in link is on its way. It works once, for 30 minutes.' };
    const email = String(req.body?.email || '').trim().toLowerCase();
    if (!emailValid(email)) return fail(res, 400, 'Enter the email address used for the purchase.');
    if (!sendMail) return fail(res, 503, 'Access recovery by email is not available yet. Please contact athlyrax@outlook.com.');
    if (!recoverIpLimit(ipOf(req)) || !recoverEmailLimit(email)) return noStore(res).json(generic);
    const ids = store.read('emails', email)?.sessionIds || [];
    const active = ids.map((id) => store.read('entitlements', id)).find((e) => e && e.status === 'active');
    if (active) {
      const token = crypto.randomBytes(32).toString('base64url');
      store.write('recovery', token, { sessionId: active.sessionId, exp: Date.now() + RECOVERY_TTL_MS, used: false });
      try {
        await sendMail({ to: active.email, subject: 'Your AthlyraX Education course link', text: [
          `Hello ${active.name},`, '', 'Use this link to open CPD 01 - Module 03: Swimming Set Design on this device:',
          `${origin}/education/module-03.html?access=${token}`, '', 'The link works once and expires in 30 minutes.',
          'If you did not ask for it, you can ignore this email.', '', 'AthlyraX Education',
        ].join('\n') });
      } catch { /* same answer either way: no enumeration */ }
    }
    noStore(res).json(generic);
  });
  app.post(base + '/redeem', async (req, res) => {
    if (secret.length < 32) return fail(res, 503, 'Course access is not configured.');
    const token = String(req.body?.token || '').trim();
    if (!/^[A-Za-z0-9_-]{40,60}$/.test(token)) return fail(res, 400, 'This link is not valid.');
    const r = store.read('recovery', token);
    if (!r || r.used || r.exp < Date.now()) return fail(res, 403, 'This link has expired or was already used. Request a new one.');
    r.used = true; store.write('recovery', token, r);
    const ent = store.read('entitlements', r.sessionId);
    if (!ent || ent.status !== 'active') return fail(res, 403, 'Course access for this purchase has ended.');
    ent.devices = (ent.devices || 0) + 1; saveEntitlement(ent);
    setAccessCookie(res, ent.sessionId);
    noStore(res).json({ paidAccess: true, learner: { name: ent.name } });
  });

  // ---------- private lesson video (byte ranges, bounded responses) ----------
  app.get(base + '/video/:lesson', async (req, res) => {
    let ent = null; try { ent = await learner(req); } catch {}
    if (!ent) return fail(res, 401, 'A verified purchase is required to watch this lesson.');
    const n = Number(req.params.lesson);
    if (!Number.isInteger(n) || n < 1 || n > 3) return fail(res, 404, 'Lesson not found.');
    const size = lessonSize(n);
    if (!size) return fail(res, 404, 'This lesson video is not available yet.');
    res.set({ 'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes', 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Disposition': 'inline' });
    const range = String(req.headers.range || '');
    let start = 0, end = size - 1, partial = false;
    if (range) {
      const m = /^bytes=(\d*)-(\d*)$/.exec(range);
      if (!m || (m[1] === '' && m[2] === '')) { res.set('Content-Range', 'bytes */' + size).status(416).end(); return; }
      if (m[1] === '') { start = Math.max(0, size - Number(m[2])); end = size - 1; } else { start = Number(m[1]); end = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1; }
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= size || start > end) { res.set('Content-Range', 'bytes */' + size).status(416).end(); return; }
      end = Math.min(end, start + CHUNK_MAX - 1); partial = true;
    }
    if (req.method !== 'HEAD') {
      const p = getProgress(ent.sessionId); p.watched[n] = mergeRanges([...(p.watched[n] || []), [start, end]]); saveProgress(ent.sessionId);
    }
    if (partial) res.status(206).set('Content-Range', `bytes ${start}-${end}/${size}`);
    res.set('Content-Length', String(end - start + 1));
    fs.createReadStream(lessonPath(n), { start, end }).on('error', () => res.destroy()).pipe(res);
  });

  // Questions are paid course content: only a verified purchaser who has reached that step gets them.
  app.get(base + '/questions', async (req, res) => {
    const section = String(req.query.section || '');
    if (!SECTIONS[section]) return fail(res, 400, 'Unknown assessment.');
    let ent = null; try { ent = await learner(req); } catch {}
    if (!ent) return fail(res, 401, 'Course purchase required.');
    const p = getProgress(ent.sessionId), def = SECTIONS[section];
    if (!p.lessons.includes(def.afterLesson)) return fail(res, 409, `Watch lesson ${def.afterLesson} first.`);
    if (section === 'final' && !(p.lessons.length === 3 && ['check-1', 'check-2', 'check-3'].every(s => p.checks.includes(s)))) return fail(res, 409, 'Complete all three lessons and all three knowledge checks first.');
    noStore(res).json({ section, questions: questions.filter((x) => x.section === section).map((x) => ({ id: x.id, question: x.question, options: x.options })) });
  });

  app.post(base + '/lesson-complete', async (req, res) => {
    let ent = null; try { ent = await learner(req); } catch {}
    if (!ent) return fail(res, 401, 'Course purchase required.');
    const n = Number(req.body?.lesson);
    if (!Number.isInteger(n) || n < 1 || n > 3) return fail(res, 400, 'Invalid lesson.');
    const p = getProgress(ent.sessionId);
    if (n > 1 && !p.checks.includes('check-' + (n - 1))) return fail(res, 409, `Complete knowledge check ${n - 1} first.`);
    const share = watchedShare(p, n);
    if (share < WATCH_REQUIRED) return fail(res, 409, `Please watch the whole lesson first (about ${Math.round(share * 100)}% watched so far).`, { watched: Math.round(share * 100) });
    if (!p.lessons.includes(n)) p.lessons = [...p.lessons, n].sort();
    saveProgress(ent.sessionId, true);
    noStore(res).json(progressView(ent.sessionId));
  });

  app.post(base + '/assessment', async (req, res) => {
    let ent = null; try { ent = await learner(req); } catch {}
    if (!ent) return fail(res, 401, 'Course purchase required for graded assessments.');
    const section = String(req.body?.section || '');
    const def = SECTIONS[section]; if (!def) return fail(res, 400, 'Invalid assessment section.');
    const p = getProgress(ent.sessionId);
    if (!p.lessons.includes(def.afterLesson)) return fail(res, 409, `Watch lesson ${def.afterLesson} first.`);
    if (section === 'final' && !(p.lessons.length === 3 && ['check-1', 'check-2', 'check-3'].every(s => p.checks.includes(s)))) return fail(res, 409, 'Complete all three lessons and all three knowledge checks first.');
    const qs = questions.filter((x) => x.section === section), answers = req.body?.answers;
    if (!Array.isArray(answers) || answers.length !== qs.length || answers.some((x) => !Number.isInteger(x) || x < 0 || x > 3)) return fail(res, 400, 'Answer every question before submitting.');
    const score = qs.reduce((s, q, i) => s + Number(q.correct_option_index === answers[i]), 0);
    if (section !== 'final') {
      if (score === qs.length && !p.checks.includes(section)) p.checks = [...p.checks, section];
      saveProgress(ent.sessionId, true);
      return noStore(res).json({ section, score, total: qs.length, feedback: qs.map((q, i) => ({ questionId: q.id, correct: q.correct_option_index === answers[i], correctAnswerIndex: q.correct_option_index, explanation: q.explanation })) });
    }
    // Final assessment: score only, so the answer key is never revealed by retrying.
    const pass = score >= 8;
    p.finalAttempts = (p.finalAttempts || 0) + 1; p.bestFinal = Math.max(p.bestFinal || 0, score);
    saveProgress(ent.sessionId, true);
    let completion = store.read('completions', ent.sessionId);
    if (pass && !completion) {
      const certificateId = 'AXE-M03-' + sha('cert:' + ent.sessionId).slice(0, 10).toUpperCase();
      completion = { course: CPD_MODULE03_COURSE, sessionId: ent.sessionId, certificateId, learnerName: ent.name, completedAt: new Date().toISOString(), score, total: 10, attempts: p.finalAttempts };
      store.write('completions', ent.sessionId, completion);
      store.write('certificates', certificateId, { sessionId: ent.sessionId });
    }
    noStore(res).json({ section, score, total: 10, pass, passMark: 8, attempts: p.finalAttempts, certificate: completion ? { id: completion.certificateId } : null });
  });

  app.get(base + '/certificate', async (req, res) => {
    let ent = null; try { ent = await learner(req); } catch {}
    if (!ent) return fail(res, 401, 'Course access required.');
    const c = store.read('completions', ent.sessionId);
    if (!c || c.sessionId !== ent.sessionId || c.score < 8) return fail(res, 403, 'Pass the final assessment (8/10) to receive your certificate.');
    const pdf = buildCertificatePdf({ name: c.learnerName, completedAt: c.completedAt, certificateId: c.certificateId, score: c.score, verifyUrl: `${origin}/education/module-03.html?verify=${c.certificateId}`, logoJpeg, courseHeading: 'CPD 01 - Module 03: Swimming Set Design', courseSubtitle: 'From Purpose to Practice', courseSummary: 'Three video lessons, three knowledge checks and a final assessment' });
    res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename="AthlyraX-Education-${c.certificateId}.pdf"`, 'Cache-Control': 'private, no-store', 'Content-Length': String(pdf.length) }).send(pdf);
  });

  // Public certificate check: confirms a certificate ID, the name and the date (nothing else).
  app.get(base + '/verify/:id', (req, res) => {
    noStore(res);
    const id = String(req.params.id || '').toUpperCase();
    if (!verifyLimit(ipOf(req))) return fail(res, 429, 'Too many checks. Try again later.');
    if (!/^AXE-M03-[0-9A-F]{10}$/.test(id)) return res.json({ valid: false });
    const ref = store.read('certificates', id); const c = ref && store.read('completions', ref.sessionId); const ent = ref && store.read('entitlements', ref.sessionId);
    if (!c || c.certificateId !== id) return res.json({ valid: false });
    res.json({ valid: true, revoked: ent?.status === 'revoked', certificateId: id, learnerName: c.learnerName, course: COURSE_TITLE, completedAt: c.completedAt.slice(0, 10) });
  });

  // ---------- Stripe webhook hooks (called from the existing signed /billing/webhook) ----------
  async function onCheckoutCompleted(session) {
    if (session?.metadata?.course !== CPD_MODULE03_COURSE || !sessionIdValid(String(session.id || ''))) return false;
    try {
      if (stripe) {
        const { ent, problem } = await verifyPurchase(session.id);
        // Email a durable confirmation of the buyer's explicit consent and
        // acknowledgement. Stripe metadata retains the timestamped evidence.
        if (!problem && ent?.status === 'active' && ent.email && sendMail
          && session.metadata?.digital_access_consent === 'yes'
          && session.metadata?.cancellation_acknowledged === 'yes'
          && !store.read('purchase-confirmations', session.id)) {
          try {
            await sendMail({
              to: ent.email,
              subject: 'AthlyraX Education — Module 3 purchase confirmation',
              text: [
                'Your purchase of CPD 01 Module 03: Swimming Set Design is confirmed.',
                'Price paid: £4.99 (one-time digital course purchase).',
                '',
                'Before purchase, you expressly consented to immediate digital access',
                'and acknowledged that once access begins you lose the statutory',
                '14-day right to cancel. This does not affect your statutory rights',
                'if digital content is faulty or not as described.',
                '',
                'Open your course: ' + origin + '/education/module-03.html',
                'Your purchase is associated with this email address. You can',
                'restore access from the course page if you change devices.',
                '',
                'AthlyraX Education',
              ].join('\n'),
            });
            store.write('purchase-confirmations', session.id, { sentAt: new Date().toISOString(), consentVersion: '2026-11-06' });
          } catch { /* keep the learner's paid entitlement and retry on a repeated signed event */ }
        }
      }
    } catch {}
    return true;
  }
  // The event only says which payment to look at; the refund/dispute itself is confirmed with Stripe.
  async function onRefundOrDispute(object) {
    const pi = String(object?.payment_intent?.id || object?.payment_intent || '');
    const ref = pi && store.read('payments', pi);
    if (!ref || !stripe) return false;
    try { await verifyPurchase(ref.sessionId); } catch {}
    return true;
  }

  // ---------- owner reporting and access revocation; separate Module 03 uploader is already registered ----------
  app.get(base + '/admin/sales', requireStrictAuth, requireSoftwareOwnerRole, (req, res) => {
    try {
      const folder = path.join(root, 'entitlements');
      const names = fs.existsSync(folder) ? fs.readdirSync(folder).filter((x) => /^[a-f0-9]{64}\.json$/.test(x)).slice(0, 20000) : [];
      const records = [];
      for (const name of names) {
        try {
          const row = JSON.parse(fs.readFileSync(path.join(folder, name), 'utf8'));
          if (row?.course === CPD_MODULE03_COURSE && ['active', 'revoked'].includes(row.status)
            && ['test', 'live'].includes(row.mode) && typeof row.sessionId === 'string') records.push(row);
        } catch {}
      }
      const rows = records.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
      const count = (mode, status) => rows.filter((x) => x.mode === mode && x.status === status).length;
      const completed = (mode) => rows.filter((x) => x.mode === mode && x.status === 'active' &&
        Boolean(store.read('completions', x.sessionId))).length;
      const summary = Object.fromEntries(['test', 'live'].map((mode) => [mode, {
        recordedPurchases: rows.filter((x) => x.mode === mode).length,
        activeAccess: count(mode, 'active'),
        revokedAccess: count(mode, 'revoked'),
        verifiedCompletions: completed(mode),
        activeAccessFaceValuePence: count(mode, 'active') * PRICE_PENCE,
      }]));
      noStore(res).json({
        source: 'locally-verified-cpd-course-entitlements',
        asOf: new Date().toISOString(),
        currency: 'gbp',
        unitAmountPence: PRICE_PENCE,
        warning: 'Not a complete Stripe sales ledger, profit or net revenue report. Refunds, taxes, fees and unclaimed purchases need separate Stripe reconciliation.',
        summary,
        customers: rows.slice(0, 100).map((row) => ({
          name: String(row.name || '').slice(0, 110),
          email: String(row.email || '').slice(0, 254),
          purchasedAt: row.createdAt || null,
          status: row.status, mode: row.mode,
          completed: Boolean(store.read('completions', row.sessionId)),
        })),
      });
    } catch { fail(res, 500, 'Course sales reporting is temporarily unavailable.'); }
  });
  app.post(base + '/admin/revoke', requireStrictAuth, requireSoftwareOwnerRole, (req, res) => {
    const email = String(req.body?.email || '').trim().toLowerCase();
    const ids = store.read('emails', email)?.sessionIds || [];
    ids.forEach((id) => revoke(store.read('entitlements', id), 'revoked by AthlyraX'));
    noStore(res).json({ revoked: ids.length });
  });

  // Viewing progress is buffered briefly; flush it every 15 s (timer does not keep the process alive).
  const flush = () => { for (const [id, e] of progressCache) if (e.dirty) { try { store.write('progress', id, e.record); e.dirty = false; e.savedAt = Date.now(); } catch {} } };
  setInterval(flush, 15000).unref();
  return { onCheckoutCompleted, onRefundOrDispute, flush, isCourseSession: (s) => s?.metadata?.course === CPD_MODULE03_COURSE };
}
