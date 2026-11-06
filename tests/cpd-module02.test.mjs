import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { registerCpdModule02 } from '../cpd-module02.mjs';

const BANK = JSON.parse(fs.readFileSync(new URL('../cpd-module02-private-questions.json', import.meta.url))).questions;
const key = (section) => BANK.filter((q) => q.section === section).map((q) => q.correct_option_index);
const wrong = (i) => (i + 1) % 4;

// A fake Stripe account whose purchases can be paid, unpaid, refunded or disputed.
function fakeStripe() {
  const sessions = new Map(); const created = [];
  const stripe = {
    created, sessions,
    add(id, over = {}) {
      const s = { id, mode: 'payment', payment_status: 'paid', livemode: false, metadata: { course: 'cpd01-module02', learner_name: 'Alex Learner' }, amount_total: 499, currency: 'gbp', customer_details: { email: 'alex@example.com' }, payment_intent: { id: 'pi_' + id.slice(-8), status: 'succeeded', latest_charge: { refunded: false, amount_refunded: 0, disputed: false } }, ...over };
      sessions.set(id, s); return s;
    },
    checkout: { sessions: {
      retrieve: async (id) => { const s = sessions.get(id); if (!s) throw new Error('No such checkout.session'); return structuredClone(s); },
      create: async (params) => { created.push(params); return { url: 'https://checkout.stripe.com/c/pay/cs_test_fake' }; },
    } },
    prices: { retrieve: async () => ({ active: true, type: 'one_time', currency: 'gbp', unit_amount: 499, product: 'prod_test' }) },
    accounts: { retrieve: async () => ({ id: stripe.accountId, livemode: false }) },
    accountId: 'acct_1UXqgPPGSvfRRDt1',
  };
  return stripe;
}

async function startCourse({ sales = true, mode = 'live', mail = null, expectedAccount = '' } = {}) {
  const saved = { ...process.env };
  process.env.CPD_SESSION_SECRET = 'test-secret-longer-than-thirty-two-characters!!';
  process.env.CPD_MODULE02_PRICE_ID = 'price_test_module02';
  process.env.CPD_MODULE02_SALES_ENABLED = sales ? 'true' : 'false';
  if (expectedAccount) process.env.CPD_STRIPE_EXPECTED_ACCOUNT = expectedAccount; else delete process.env.CPD_STRIPE_EXPECTED_ACCOUNT;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cpd02-'));
  const stripe = fakeStripe();
  const app = express();
  app.use(express.json({ limit: '25mb' }));
  const owner = (req, res, next) => (req.headers['x-test-owner'] === 'yes' ? next() : res.status(401).json({ error: 'owner only' }));
  const hooks = registerCpdModule02(app, { courseStripeClient: stripe, courseStripeMode: mode, storageRoot: root, requireStrictAuth: owner, requireSoftwareOwnerRole: owner,
    sendMail: mail, isSoftwareOwner: (req) => req.headers['x-test-owner'] === 'yes' });
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const api = 'http://127.0.0.1:' + server.address().port + '/cpd/module-02';
  const call = (p, { method = 'GET', body, cookie, headers = {} } = {}) => fetch(api + p, { method, headers: { ...(body !== undefined && !(body instanceof Uint8Array) ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}), ...headers }, body: body === undefined ? undefined : body instanceof Uint8Array ? body : JSON.stringify(body) });
  const stop = async () => { await new Promise((r) => server.close(r)); fs.rmSync(root, { recursive: true, force: true }); process.env = saved; };
  return { root, stripe, hooks, call, stop };
}

function mp4(size) { const b = Buffer.alloc(size, 7); b.writeUInt32BE(24, 0); b.write('ftypisom', 4, 'ascii'); return b; }
async function upload(call, lesson, data, chunk = 64 * 1024) {
  let r;
  for (let off = 0; off < data.length; off += chunk) {
    r = await call(`/admin/video/${lesson}?offset=${off}&total=${data.length}`, { method: 'PUT', body: new Uint8Array(data.subarray(off, off + chunk)), headers: { 'x-test-owner': 'yes', 'content-type': 'application/octet-stream' } });
    assert.equal(r.status, 200, 'chunk accepted');
  }
  return r.json();
}
async function watchAll(call, cookie, lesson, size) {
  for (let off = 0; off < size; off += 4 * 1024 * 1024) {
    const r = await call(`/video/${lesson}`, { cookie, headers: { Range: `bytes=${off}-` } }); assert.equal(r.status, 206); await r.arrayBuffer();
  }
}
const cookieOf = (r) => (r.headers.get('set-cookie') || '').split(';')[0];

test('closed until configured; nothing is served without a verified purchase', async () => {
  const c = await startCourse({ sales: false });
  try {
    let r = await c.call('/status'); const st = await r.json();
    assert.equal(st.salesEnabled, false); assert.equal(st.paidAccess, false); assert.equal(st.setup.videos, false);
    r = await c.call('/checkout', { method: 'POST', body: { email: 'a@example.com', fullName: 'A Learner' } }); assert.equal(r.status, 503);
    r = await c.call('/video/1'); assert.equal(r.status, 401);
    r = await c.call('/certificate'); assert.equal(r.status, 401);
    r = await c.call('/assessment', { method: 'POST', body: { section: 'final', answers: Array(10).fill(0) } }); assert.equal(r.status, 401);
    // Questions are paid content: none are sent without a verified purchase.
    for (const section of ['check-1', 'check-2', 'final']) {
      r = await c.call(`/questions?section=${section}`); assert.equal(r.status, 401, `${section} questions refused without purchase`);
      assert.equal(JSON.stringify(await r.json()).includes('question'), false);
    }
    r = await c.call('/video/1', { cookie: 'athlyrax_cpd02=eyJjb3Vyc2UiOiJjcGQwMS1tb2R1bGUwMiJ9.forged' }); assert.equal(r.status, 401, 'forged cookie refused');
  } finally { await c.stop(); }
});

test('CPD logout clears the path-scoped private learner cookie without deleting a purchase', async () => {
  const c = await startCourse();
  try {
    const r = await c.call('/logout', { method: 'POST' });
    assert.equal(r.status, 200);
    assert.equal((await r.json()).ok, true);
    const header = r.headers.get('set-cookie') || '';
    assert.match(header, /athlyrax_cpd02=/);
    assert.match(header, /Path=\\/api\\/cpd\\/module-02/);
    assert.match(header, /HttpOnly/i);
    assert.match(header, /Max-Age=0|Expires=Thu, 01 Jan 1970/i);
    const status = await c.call('/status');
    assert.equal((await status.json()).paidAccess, false);
  } finally { await c.stop(); }
});

test('owner uploads private videos in chunks; only MP4 files, in order, owner only', async () => {
  const c = await startCourse();
  try {
    const data = mp4(200 * 1024);
    let r = await c.call('/admin/video/1?offset=0&total=204800', { method: 'PUT', body: new Uint8Array(data.subarray(0, 1000)), headers: { 'content-type': 'application/octet-stream' } });
    assert.equal(r.status, 401, 'not the owner');
    r = await c.call('/admin/video/1?offset=0&total=204800', { method: 'PUT', body: new Uint8Array(Buffer.alloc(2000, 1)), headers: { 'x-test-owner': 'yes', 'content-type': 'application/octet-stream' } });
    assert.equal(r.status, 400, 'not an MP4');
    r = await c.call('/admin/video/1?offset=0&total=204800', { method: 'PUT', body: new Uint8Array(data.subarray(0, 1000)), headers: { 'x-test-owner': 'yes', 'content-type': 'application/octet-stream' } });
    r = await c.call('/admin/video/1?offset=5000&total=204800', { method: 'PUT', body: new Uint8Array(data.subarray(5000, 6000)), headers: { 'x-test-owner': 'yes', 'content-type': 'application/octet-stream' } });
    assert.equal(r.status, 409, 'out-of-order chunk refused'); assert.equal((await r.json()).expectedOffset, 1000);
    const done = await upload(c.call, 1, data); assert.equal(done.done, true);
    assert.ok(fs.readFileSync(path.join(c.root, 'cpd/module-02/lesson-1.mp4')).equals(data), 'file stored exactly');
    r = await c.call('/admin/videos', { headers: { 'x-test-owner': 'yes' } }); const v = await r.json();
    assert.equal(v.lessons[0].bytes, data.length); assert.equal(v.lessons[1].bytes, 0); assert.equal(v.salesOpen, false, 'not open until all three videos exist');
  } finally { await c.stop(); }
});

test('full learner journey: pay, watch, checks, 7/10 fails, 8/10 passes, certificate, verification', async () => {
  const mails = [];
  const c = await startCourse({ mail: async (m) => mails.push(m) });
  try {
    const sizes = { 1: 5 * 1024 * 1024 + 123, 2: 300 * 1024, 3: 300 * 1024 };
    for (const n of [1, 2, 3]) await upload(c.call, n, mp4(sizes[n]), 2 * 1024 * 1024);
    let r = await c.call('/status'); assert.equal((await r.json()).salesEnabled, true);

    r = await c.call('/checkout', { method: 'POST', body: { email: 'bad', fullName: 'X' } }); assert.equal(r.status, 400);
    r = await c.call('/checkout', { method: 'POST', body: { email: 'Alex@Example.com', fullName: '  Alex   Learner ' } }); assert.equal(r.status, 200);
    const params = c.stripe.created[0];
    assert.equal(params.mode, 'payment', 'one-time payment, not a subscription');
    assert.deepEqual(params.line_items, [{ price: 'price_test_module02', quantity: 1 }]);
    assert.equal(params.metadata.course, 'cpd01-module02'); assert.equal(params.metadata.learner_name, 'Alex Learner');
    assert.equal(params.client_reference_id, undefined, 'never looks like a subscription checkout');
    assert.match(params.success_url, /module-02\.html\?session_id=\{CHECKOUT_SESSION_ID\}$/);

    // Fabricated or unsuitable sessions never unlock anything.
    c.stripe.add('cs_test_unpaid0000000001', { payment_status: 'unpaid' });
    c.stripe.add('cs_test_wrongamount00001', { amount_total: 100 });
    c.stripe.add('cs_test_othercourse00001', { metadata: { course: 'software' } });
    c.stripe.add('cs_test_subscription0001', { mode: 'subscription' });
    for (const id of ['cs_test_unpaid0000000001', 'cs_test_wrongamount00001', 'cs_test_othercourse00001', 'cs_test_subscription0001', 'cs_test_doesnotexist00001']) {
      r = await c.call('/claim', { method: 'POST', body: { session_id: id } }); assert.ok([403, 502].includes(r.status), id + ' refused'); assert.equal(cookieOf(r), '');
    }
    r = await c.call('/claim', { method: 'POST', body: { session_id: 'not-a-session' } }); assert.equal(r.status, 400);

    c.stripe.add('cs_test_alexpaid000000001');
    r = await c.call('/claim', { method: 'POST', body: { session_id: 'cs_test_alexpaid000000001' } }); assert.equal(r.status, 200);
    const cookie = cookieOf(r); assert.match(cookie, /^athlyrax_cpd02=/);
    assert.match(r.headers.get('set-cookie'), /HttpOnly/i); assert.match(r.headers.get('set-cookie'), /Path=\/api\/cpd\/module-02/);

    // Video: byte ranges, seeking, bounded responses, private headers.
    r = await c.call('/video/1', { cookie, headers: { Range: 'bytes=0-' } });
    assert.equal(r.status, 206); assert.equal(r.headers.get('content-range'), `bytes 0-${4 * 1024 * 1024 - 1}/${sizes[1]}`, 'open range capped at 4 MB');
    assert.equal(r.headers.get('cache-control'), 'private, no-store'); await r.arrayBuffer();
    r = await c.call('/video/1', { cookie, headers: { Range: 'bytes=3000000-3000099' } });
    assert.equal(r.status, 206); assert.equal((await r.arrayBuffer()).byteLength, 100, 'seek to the middle');
    r = await c.call('/video/1', { cookie, headers: { Range: 'bytes=999999999-' } }); assert.equal(r.status, 416);

    // Order: watch the lesson before its check; checks before the next lesson.
    r = await c.call('/questions?section=check-1', { cookie }); assert.equal(r.status, 409, 'check 1 questions locked until lesson 1 is watched');
    r = await c.call('/questions?section=final', { cookie }); assert.equal(r.status, 409, 'final questions locked for a new purchaser');
    r = await c.call('/assessment', { method: 'POST', cookie, body: { section: 'check-1', answers: key('check-1') } }); assert.equal(r.status, 409, 'lesson 1 not completed yet');
    r = await c.call('/lesson-complete', { method: 'POST', cookie, body: { lesson: 1 } }); assert.equal(r.status, 409, 'not fully watched');
    await watchAll(c.call, cookie, 1, sizes[1]);
    r = await c.call('/lesson-complete', { method: 'POST', cookie, body: { lesson: 1 } }); assert.equal(r.status, 200);
    r = await c.call('/questions?section=check-1', { cookie }); assert.equal(r.status, 200);
    const q1 = await r.json(); assert.equal(q1.questions.length, 4);
    assert.ok(q1.questions.every((x) => !('correct_option_index' in x) && !('explanation' in x)), 'no answer key before submission');
    r = await c.call('/questions?section=final', { cookie }); assert.equal(r.status, 409, 'final still locked after lesson 1');
    r = await c.call('/assessment', { method: 'POST', cookie, body: { section: 'check-1', answers: key('check-1').map((a, i) => (i === 0 ? wrong(a) : a)) } });
    let res = await r.json(); assert.equal(res.score, 3); assert.equal(res.feedback[0].correct, false); assert.equal(typeof res.feedback[0].explanation, 'string');
    await watchAll(c.call, cookie, 2, sizes[2]);
    r = await c.call('/lesson-complete', { method: 'POST', cookie, body: { lesson: 2 } }); assert.equal(r.status, 200);
    r = await c.call('/assessment', { method: 'POST', cookie, body: { section: 'final', answers: key('final') } }); assert.equal(r.status, 409, 'final locked before lesson 3');
    r = await c.call('/assessment', { method: 'POST', cookie, body: { section: 'check-2', answers: key('check-2') } }); assert.equal(r.status, 200);
    await watchAll(c.call, cookie, 3, sizes[3]);
    r = await c.call('/lesson-complete', { method: 'POST', cookie, body: { lesson: 3 } }); assert.equal(r.status, 200);
    r = await c.call('/questions?section=final', { cookie }); assert.equal(r.status, 200, 'final questions open after all lessons and checks');
    const qf = await r.json(); assert.equal(qf.questions.length, 10);
    assert.ok(qf.questions.every((x) => !('correct_option_index' in x) && !('explanation' in x)), 'no final answer key');

    // 7/10 fails, answers are not revealed, no certificate.
    const final = key('final');
    r = await c.call('/assessment', { method: 'POST', cookie, body: { section: 'final', answers: final.map((a, i) => (i < 3 ? wrong(a) : a)) } });
    res = await r.json(); assert.equal(res.score, 7); assert.equal(res.pass, false); assert.equal(res.certificate, null);
    assert.equal(JSON.stringify(res).includes('correctAnswerIndex'), false, 'final answer key never revealed');
    r = await c.call('/certificate', { cookie }); assert.equal(r.status, 403);
    r = await c.call('/assessment', { method: 'POST', cookie, body: { section: 'final', answers: [1, 2] } }); assert.equal(r.status, 400, 'every question must be answered');

    // Retry: 8/10 passes.
    r = await c.call('/assessment', { method: 'POST', cookie, body: { section: 'final', answers: final.map((a, i) => (i < 2 ? wrong(a) : a)) } });
    res = await r.json(); assert.equal(res.score, 8); assert.equal(res.pass, true); assert.match(res.certificate.id, /^AXE-M02-[0-9A-F]{10}$/);
    const certId = res.certificate.id;
    r = await c.call('/assessment', { method: 'POST', cookie, body: { section: 'final', answers: final } });
    assert.equal((await r.json()).certificate.id, certId, 'one certificate per purchase');
    r = await c.call('/certificate', { cookie }); assert.equal(r.status, 200);
    assert.equal(r.headers.get('content-type'), 'application/pdf'); assert.equal(r.headers.get('cache-control'), 'private, no-store');
    const pdf = Buffer.from(await r.arrayBuffer()).toString('latin1');
    assert.ok(pdf.startsWith('%PDF-1.4')); assert.ok(pdf.includes('(Alex Learner)')); assert.ok(pdf.includes(certId)); assert.ok(pdf.includes('Certificate of Completion'));
    assert.ok(pdf.includes('8/10'), 'first passing score recorded'); assert.ok(pdf.includes('/DCTDecode'), 'AthlyraX logo embedded');
    assert.ok(pdf.includes('/Mask [0 70 0 70 0 85]'), 'logo matte is transparent rather than a rectangular block');
    assert.ok(pdf.includes('Completed:'), 'completion date is included');
    assert.ok(pdf.includes('Verify:'), 'certificate verification URL is included');
    assert.ok(pdf.includes('21 min 54 s'), 'video duration agrees with the three lessons');
    r = await c.call('/verify/' + certId); res = await r.json(); assert.equal(res.valid, true); assert.equal(res.learnerName, 'Alex Learner');
    r = await c.call('/verify/AXE-M02-0000000000'); assert.equal((await r.json()).valid, false);

    // Another buyer cannot see Alex's certificate; a tampered cookie gets nothing.
    c.stripe.add('cs_test_otherbuyer0000001', { customer_details: { email: 'sam@example.com' }, metadata: { course: 'cpd01-module02', learner_name: 'Sam Other' } });
    r = await c.call('/claim', { method: 'POST', body: { session_id: 'cs_test_otherbuyer0000001' } }); const samCookie = cookieOf(r);
    r = await c.call('/certificate', { cookie: samCookie }); assert.equal(r.status, 403);
    r = await c.call('/certificate', { cookie: cookie.slice(0, -3) + 'abc' }); assert.equal(r.status, 401);

    // Returning learner on a new device: single-use emailed link.
    r = await c.call('/recover', { method: 'POST', body: { email: 'nobody@example.com' } }); assert.equal(r.status, 200); assert.equal(mails.length, 0, 'no email for unknown address, same answer');
    r = await c.call('/recover', { method: 'POST', body: { email: 'ALEX@example.com' } }); assert.equal(r.status, 200); assert.equal(mails.length, 1);
    assert.equal(mails[0].to, 'alex@example.com');
    const token = /access=([A-Za-z0-9_-]+)/.exec(mails[0].text)[1];
    r = await c.call('/redeem', { method: 'POST', body: { token } }); assert.equal(r.status, 200); const newDevice = cookieOf(r);
    r = await c.call('/status', { cookie: newDevice }); res = await r.json(); assert.equal(res.paidAccess, true); assert.equal(res.certificate.id, certId); assert.deepEqual(res.progress.lessons, [1, 2, 3]);
    r = await c.call('/redeem', { method: 'POST', body: { token } }); assert.equal(r.status, 403, 'link works once');

    // Refund: the webhook only names the payment; Stripe confirms the refund; access ends everywhere.
    c.stripe.sessions.get('cs_test_alexpaid000000001').payment_intent.latest_charge.refunded = true;
    await c.hooks.onRefundOrDispute({ payment_intent: 'pi_' + 'cs_test_alexpaid000000001'.slice(-8) });
    for (const ck of [cookie, newDevice]) { r = await c.call('/video/1', { cookie: ck, headers: { Range: 'bytes=0-10' } }); assert.equal(r.status, 401); }
    r = await c.call('/status', { cookie }); res = await r.json(); assert.equal(res.paidAccess, false); assert.equal(res.accessRevoked, 'refunded');
    r = await c.call('/claim', { method: 'POST', body: { session_id: 'cs_test_alexpaid000000001' } }); assert.equal(r.status, 403, 'refunded purchase cannot be re-claimed');
    r = await c.call('/verify/' + certId); assert.equal((await r.json()).revoked, true);

    // Dispute (chargeback) also ends access; an unrelated payment changes nothing.
    assert.equal(await c.hooks.onRefundOrDispute({ payment_intent: 'pi_unrelated' }), false);
    c.stripe.sessions.get('cs_test_otherbuyer0000001').payment_intent.latest_charge.disputed = true;
    await c.hooks.onRefundOrDispute({ payment_intent: { id: 'pi_' + 'cs_test_otherbuyer0000001'.slice(-8) } });
    r = await c.call('/video/1', { cookie: samCookie, headers: { Range: 'bytes=0-10' } }); assert.equal(r.status, 401);
  } finally { await c.stop(); }
});

test('Stripe test mode: only the signed-in owner can start a checkout', async () => {
  const c = await startCourse({ mode: 'test' });
  try {
    for (const n of [1, 2, 3]) await upload(c.call, n, mp4(4096));
    let r = await c.call('/status'); assert.equal((await r.json()).testMode, true);
    r = await c.call('/checkout', { method: 'POST', body: { email: 'a@example.com', fullName: 'A Learner' } }); assert.equal(r.status, 503, 'public cannot buy with test cards');
    r = await c.call('/checkout', { method: 'POST', body: { email: 'a@example.com', fullName: 'A Learner' }, headers: { 'x-test-owner': 'yes' } }); assert.equal(r.status, 200);
  } finally { await c.stop(); }
});

test('recovery by email says so plainly when no email service is configured', async () => {
  const c = await startCourse({ mail: null });
  try {
    const r = await c.call('/recover', { method: 'POST', body: { email: 'a@example.com' } }); assert.equal(r.status, 503);
    assert.match((await r.json()).error, /athlyrax@outlook\.com/);
  } finally { await c.stop(); }
});

test('course purchases never reach the software-subscription billing code', () => {
  const src = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8');
  const hook = src.indexOf("case 'checkout.session.completed'");
  const branch = src.indexOf("session?.metadata?.course === 'cpd01-module02'", hook);
  const upsert = src.indexOf('upsertUserBillingByUsername(username', hook);
  assert.ok(hook > 0 && branch > hook && branch < upsert, 'course branch runs before subscription billing');
  assert.match(src.slice(branch, upsert), /break;/);
});

test('the course reports which Stripe key it uses and refuses a key from another account', async () => {
  const c = await startCourse({ mode: 'test', expectedAccount: 'acct_1UXqgPPGSvfRRDt1' });
  try {
    for (const n of [1, 2, 3]) await upload(c.call, n, mp4(4096));
    let r = await c.call('/status'); let st = await r.json();
    assert.equal(st.stripeConfig.keySource, 'injected');
    assert.equal(st.stripeConfig.priceInKeyAccount, true);
    assert.equal(st.stripeConfig.priceValidForSale, true);
    assert.equal(st.stripeConfig.expectedAccountMatches, true);
    assert.match(st.stripeConfig.serverStartedAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(JSON.stringify(st).includes('acct_'), false, 'no account ID on the public status');
    assert.equal(st.salesEnabled, true);
    r = await c.call('/checkout', { method: 'POST', body: { email: 'a@example.com', fullName: 'A Learner' }, headers: { 'x-test-owner': 'yes' } });
    assert.equal(r.status, 200, 'owner test checkout on the expected sandbox account');
    // The key now belongs to another account (e.g. the live account's own test mode).
    c.stripe.accountId = 'acct_1UY3W3AROMWHD0h9';
    r = await c.call('/checkout', { method: 'POST', body: { email: 'a@example.com', fullName: 'A Learner' }, headers: { 'x-test-owner': 'yes' } });
    assert.equal(r.status, 503); assert.match((await r.json()).error, /different Stripe account/);
    r = await c.call('/admin/videos', { headers: { 'x-test-owner': 'yes' } }); const admin = await r.json();
    assert.equal(admin.stripeAccount.id, 'acct_1UY3W3AROMWHD0h9'); assert.equal(admin.expectedAccountMatches, false); assert.equal(admin.setup.stripe, false);
    r = await c.call('/status'); st = await r.json();
    assert.equal(st.salesEnabled, false, 'course closed while the key is on the wrong account');
  } finally { await c.stop(); }
});
