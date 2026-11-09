// Private investor page: invitation-only on the server for the page and the video; revocable.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { registerInvestorAccess, investorPageHtml } from '../investor-access.mjs';

async function server({ owner = true } = {}) {
  const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ax-investor-'));
  const app = express(); app.use((req, res, next) => { req.cookies = Object.fromEntries(String(req.headers.cookie || '').split(';').map((x) => x.trim()).filter(Boolean).map((x) => [x.slice(0, x.indexOf('=')), decodeURIComponent(x.slice(x.indexOf('=') + 1))])); next(); }); app.use(express.json());
  const requireStrictAuth = (req, res, next) => { if (req.get('x-test-user')) { req.auth = { username: req.get('x-test-user'), role: req.get('x-test-role') }; next(); } else res.status(401).json({ error: 'auth' }); };
  const requireSoftwareOwnerRole = (req, res, next) => (req.auth?.role === 'software-owner' ? next() : res.status(403).json({ error: 'owner only' }));
  registerInvestorAccess(app, { storageRoot, secret: 'test-secret-0123456789abcdef0123456789', requireStrictAuth, requireSoftwareOwnerRole, requireLoginRateLimit: (q, s, n) => n(), siteUrl: 'https://athlyrax.com' });
  const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const base = `http://127.0.0.1:${srv.address().port}`;
  const ownerH = { 'x-test-user': 'owner', 'x-test-role': owner ? 'software-owner' : 'head-coach' };
  return { base, storageRoot, ownerH, stop: () => new Promise((r) => srv.close(r)) };
}
const j = (r) => r.json();

test('page and video require a valid, non-revoked invitation; owner-only management; video served with ranges', async () => {
  const s = await server();
  try {
    // Without an invitation nothing is served.
    let r = await fetch(`${s.base}/investor/page`);
    assert.equal(r.status, 401); assert.match(r.headers.get('x-robots-tag'), /noindex/);
    assert.ok(!(await r.text()).includes('Eight capability axes'));
    assert.equal((await fetch(`${s.base}/investor/video`)).status, 401);
    // Only the software owner manages invitations and the video.
    assert.equal((await fetch(`${s.base}/owner/investor/invites`)).status, 401);
    assert.equal((await fetch(`${s.base}/owner/investor/invites`, { headers: { 'x-test-user': 'coach', 'x-test-role': 'head-coach' } })).status, 403);
    assert.equal((await fetch(`${s.base}/owner/investor/video?offset=0&total=2000`, { method: 'PUT', headers: { 'x-test-user': 'coach', 'x-test-role': 'head-coach', 'Content-Type': 'application/octet-stream' }, body: Buffer.alloc(2000) })).status, 403);
    const created = await j(await fetch(`${s.base}/owner/investor/invites`, { method: 'POST', headers: { ...s.ownerH, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Pat Investor', email: 'pat@example.com' }) }));
    assert.match(created.link, /^https:\/\/athlyrax\.com\/investor#t=AXI1\.inv_[a-f0-9]{24}\./);
    const token = decodeURIComponent(created.link.split('#t=')[1]);
    const stored = fs.readFileSync(path.join(s.storageRoot, 'investor', 'invites.json'), 'utf8');
    assert.ok(!stored.includes(token.split('.').pop()), 'only a hash of the secret is stored');
    // Wrong or tampered tokens are refused.
    assert.equal((await fetch(`${s.base}/investor/session`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: token.slice(0, -2) + 'AA' }) })).status, 404);
    // A forged cookie is refused.
    assert.equal((await fetch(`${s.base}/investor/page`, { headers: { cookie: `athlyrax_investor=${created.invite.id}.1700000000000.${'A'.repeat(43)}` } })).status, 401);
    r = await fetch(`${s.base}/investor/session`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }) });
    assert.equal(r.status, 200);
    const set = r.headers.get('set-cookie'); assert.match(set, /athlyrax_investor=/); assert.match(set, /HttpOnly/i);
    const cookie = set.split(';')[0];
    r = await fetch(`${s.base}/investor/page`, { headers: { cookie } });
    assert.equal(r.status, 200);
    const html = await r.text();
    assert.ok(html.includes('Eight capability axes') && html.includes('Pat Investor') && html.includes('mailto:athlyrax@outlook.com'));
    assert.ok(html.includes('investor-video-missing'), 'no video yet');
    assert.equal((await fetch(`${s.base}/investor/video`, { headers: { cookie } })).status, 404);
    // Owner uploads the MP4 in chunks; non-MP4 refused.
    assert.equal((await fetch(`${s.base}/owner/investor/video?offset=0&total=2000`, { method: 'PUT', headers: { ...s.ownerH, 'Content-Type': 'application/octet-stream' }, body: Buffer.alloc(2000) })).status, 400);
    const mp4 = Buffer.alloc(3000, 7); mp4.write('ftypisom', 4, 'ascii');
    assert.equal((await j(await fetch(`${s.base}/owner/investor/video?offset=0&total=3000`, { method: 'PUT', headers: { ...s.ownerH, 'Content-Type': 'application/octet-stream' }, body: mp4.subarray(0, 2000) }))).done, false);
    assert.equal((await j(await fetch(`${s.base}/owner/investor/video?offset=2000&total=3000`, { method: 'PUT', headers: { ...s.ownerH, 'Content-Type': 'application/octet-stream' }, body: mp4.subarray(2000) }))).done, true);
    assert.ok((await (await fetch(`${s.base}/investor/page`, { headers: { cookie } })).text()).includes('src="/api/investor/video"'));
    r = await fetch(`${s.base}/investor/video`, { headers: { cookie, range: 'bytes=0-99' } });
    assert.equal(r.status, 206); assert.equal(r.headers.get('content-range'), 'bytes 0-99/3000'); assert.equal((await r.arrayBuffer()).byteLength, 100);
    assert.equal((await fetch(`${s.base}/investor/video`)).status, 401, 'video still needs the invitation');
    // The owner sees who opened it; revoking stops the page and video at once for that browser.
    const list = await j(await fetch(`${s.base}/owner/investor/invites`, { headers: s.ownerH }));
    assert.equal(list.invites[0].opens, 1); assert.equal(list.video.bytes, 3000); assert.ok(!JSON.stringify(list).includes('tokenHash'));
    assert.equal((await fetch(`${s.base}/owner/investor/invites/${created.invite.id}/revoke`, { method: 'POST', headers: s.ownerH })).status, 200);
    assert.equal((await fetch(`${s.base}/investor/page`, { headers: { cookie } })).status, 401);
    assert.equal((await fetch(`${s.base}/investor/video`, { headers: { cookie, range: 'bytes=0-9' } })).status, 401);
    assert.equal((await fetch(`${s.base}/investor/session`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }) })).status, 404);
  } finally { await s.stop(); }
});

test('page content marks planned items and invents no figures', () => {
  const html = investorPageHtml({ name: '<b>x</b>', hasVideo: true });
  assert.ok(!html.includes('<b>x</b>'), 'recipient name is escaped');
  for (const t of ['Technical Control', 'Durability', 'Coaching Software', 'Athlete App', 'Video Analysis', 'Athlyra Education', 'Wearable integration', 'Other sports', 'Investment', 'Strategic partnership', 'Sergio Catania']) assert.ok(html.includes(t), t);
  assert.match(html, /tag plan">Planned<\/div><h3>Parent Portal/);
  assert.doesNotMatch(html, /\b\d{2,}\s*(clubs|customers|users)\b|revenue of|forecast of/i);
});
