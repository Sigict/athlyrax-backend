// AthlyraX investor & strategic partner presentation.
//
// Viewing is open to anyone with the public /investor link; owner-only upload is unchanged.
// Legacy individual invitations remain for backward compatibility, but are not required to view.
// Previous invitation implementation:
// - The software owner creates a personal invitation; its secret is shown once (only a SHA-256 hash
//   is stored) and can be revoked at any time.
// - The recipient opens /investor#t=<secret>. The secret travels in the URL fragment (never in server
//   logs), is POSTed once to /investor/session and exchanged for an HttpOnly, signed cookie bound to
//   that invitation.
// - Every request for the page or the video re-checks the invitation: a revoked or expired invitation
//   stops working immediately, even for a browser that already opened it.
// - No search indexing (X-Robots-Tag), no caching, nothing linked from public navigation.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';

export const INVESTOR_COOKIE = 'athlyrax_investor';
const UPLOAD_CHUNK_MAX = 8 * 1024 * 1024;
const UPLOAD_TOTAL_MAX = 400 * 1024 * 1024;
const DEFAULT_TTL_DAYS = 30;
const MAX_INVITES = 500;
const text = (v) => String(v ?? '').trim();
const sha256 = (v) => crypto.createHash('sha256').update(String(v)).digest('hex');
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function inviteState(inv, now = Date.now()) {
  if (!inv) return 'missing';
  if (inv.revokedAt) return 'revoked';
  if (inv.expiresAt && Date.parse(inv.expiresAt) <= now) return 'expired';
  return 'active';
}

export function registerInvestorAccess(app, { storageRoot, secret, requireStrictAuth, requireSoftwareOwnerRole, requireLoginRateLimit, isProduction = false, siteUrl = 'https://athlyrax.com', now = () => Date.now() }) {
  const root = path.join(storageRoot, 'investor');
  const invitesPath = path.join(root, 'invites.json');
  const videoPath = path.join(root, 'partner-video.mp4');
  const key = crypto.createHmac('sha256', String(secret)).update('athlyrax-investor-session-v1').digest();
  const sign = (v) => crypto.createHmac('sha256', key).update(v).digest('base64url');

  const readInvites = () => { try { const j = JSON.parse(fs.readFileSync(invitesPath, 'utf8')); return Array.isArray(j) ? j : []; } catch { return []; } };
  const writeInvites = (rows) => {
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    const tmp = `${invitesPath}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(rows, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, invitesPath);
  };
  const publicRow = (i) => ({ id: i.id, name: i.name, email: i.email, note: i.note, createdAt: i.createdAt, createdBy: i.createdBy, expiresAt: i.expiresAt, revokedAt: i.revokedAt || '', revokedBy: i.revokedBy || '', firstOpenedAt: i.firstOpenedAt || '', lastOpenedAt: i.lastOpenedAt || '', opens: Number(i.opens || 0), state: inviteState(i, now()) });
  const videoBytes = () => { try { return fs.statSync(videoPath).size; } catch { return 0; } };
  const noStore = (res) => res.set({ 'Cache-Control': 'private, no-store, max-age=0', Pragma: 'no-cache', 'X-Robots-Tag': 'noindex, nofollow, noarchive', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff' });

  // Cookie value: <inviteId>.<issuedAtMs>.<hmac>. The invitation itself is re-checked on every request.
  const sessionInvite = (req) => {
    const raw = text(req.cookies?.[INVESTOR_COOKIE]);
    const m = /^(inv_[a-f0-9]{24})\.(\d{10,16})\.([A-Za-z0-9_-]{43})$/.exec(raw);
    if (!m) return null;
    const expected = sign(`${m[1]}.${m[2]}`);
    if (expected.length !== m[3].length || !crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(m[3]))) return null;
    const inv = readInvites().find((i) => i.id === m[1]);
    return inviteState(inv, now()) === 'active' ? inv : null;
  };
  const cookieOptions = (maxAgeMs) => ({ httpOnly: true, secure: isProduction, sameSite: 'lax', path: '/', maxAge: maxAgeMs });

  // ---------- recipient ----------
  app.post('/investor/session', requireLoginRateLimit, (req, res) => {
    noStore(res);
    const token = text(req.body?.token);
    const m = /^AXI1\.(inv_[a-f0-9]{24})\.([A-Za-z0-9_-]{43})$/.exec(token);
    const rows = readInvites();
    const inv = m ? rows.find((i) => i.id === m[1]) : null;
    const ok = inv && inviteState(inv, now()) === 'active' && inv.tokenHash.length === 64 && crypto.timingSafeEqual(Buffer.from(inv.tokenHash), Buffer.from(sha256(m[2])));
    if (!ok) { res.status(404).json({ error: 'This invitation link is not valid, has expired or has been withdrawn.' }); return; }
    const at = new Date(now()).toISOString();
    inv.opens = Number(inv.opens || 0) + 1; inv.lastOpenedAt = at; if (!inv.firstOpenedAt) inv.firstOpenedAt = at;
    try { writeInvites(rows); } catch {}
    const issued = String(now());
    const remaining = Math.max(60000, Math.min(Date.parse(inv.expiresAt) - now(), 30 * 86400000));
    res.cookie(INVESTOR_COOKIE, `${inv.id}.${issued}.${sign(`${inv.id}.${issued}`)}`, cookieOptions(remaining));
    res.status(200).json({ ok: true, name: inv.name });
  });

  app.post('/investor/leave', (req, res) => { noStore(res); res.clearCookie(INVESTOR_COOKIE, { path: '/' }); res.status(200).json({ ok: true }); });

  const denied = (res) => noStore(res).status(401).type('html').send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>AthlyraX · Private</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#031525;color:#d8ecf7;font:16px/1.6 Inter,Segoe UI,Arial,sans-serif}main{max-width:520px;padding:24px;text-align:center}img{width:190px}a{color:#65d5ef}</style></head><body><main><img src="/images/site/brand-lockup.png" alt="AthlyraX"><h1 style="font-size:22px">This private page needs a personal invitation</h1><p>Open the invitation link you received by email. If it no longer works, it may have expired or been withdrawn.</p><p><a href="mailto:athlyrax@outlook.com?subject=AthlyraX%20investor%20page%20access">Contact AthlyraX</a></p></main></body></html>`);

  // One reusable investor URL, openable directly from Outlook. Upload remains owner-only.
  // No visitor account, personal invitation, expiry date or password is required.
  app.get('/investor/page', (req, res) => {
    noStore(res).set('Content-Security-Policy', "default-src 'self'; img-src 'self' data:; media-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'").type('html').send(investorPageHtml({ hasVideo: videoBytes() > 0 }));
  });

  app.get('/investor/video', (req, res) => {
    const size = videoBytes();
    if (!size) { noStore(res).status(404).json({ error: 'The video is not available yet.' }); return; }
    noStore(res).set({ 'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes', 'Content-Disposition': 'inline' });
    let start = 0; let end = size - 1; let partial = false;
    const range = text(req.headers.range);
    if (range) {
      const m = /^bytes=(\d*)-(\d*)$/.exec(range);
      if (!m || (m[1] === '' && m[2] === '')) { res.set('Content-Range', `bytes */${size}`).status(416).end(); return; }
      if (m[1] === '') { start = Math.max(0, size - Number(m[2])); } else { start = Number(m[1]); if (m[2] !== '') end = Math.min(Number(m[2]), size - 1); }
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= size || start > end) { res.set('Content-Range', `bytes */${size}`).status(416).end(); return; }
      partial = true;
    }
    if (partial) res.status(206).set('Content-Range', `bytes ${start}-${end}/${size}`);
    res.set('Content-Length', String(end - start + 1));
    if (req.method === 'HEAD') { res.end(); return; }
    fs.createReadStream(videoPath, { start, end }).on('error', () => res.destroy()).pipe(res);
  });

  // ---------- software owner ----------
  app.get('/owner/investor/invites', requireStrictAuth, requireSoftwareOwnerRole, (req, res) => {
    noStore(res).json({ invites: readInvites().map(publicRow).reverse(), video: { bytes: videoBytes() }, pageUrl: `${siteUrl}/investor` });
  });
  app.post('/owner/investor/invites', requireStrictAuth, requireSoftwareOwnerRole, (req, res) => {
    noStore(res);
    const name = text(req.body?.name).replace(/[\r\n\t]+/g, ' ').slice(0, 120);
    const email = text(req.body?.email).toLowerCase().slice(0, 254);
    const note = text(req.body?.note).replace(/[\r\n\t]+/g, ' ').slice(0, 200);
    const days = Math.min(365, Math.max(1, Number(req.body?.days) || DEFAULT_TTL_DAYS));
    if (name.length < 2) { res.status(400).json({ error: 'Enter the recipient\'s name.' }); return; }
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { res.status(400).json({ error: 'Enter a valid email address or leave it empty.' }); return; }
    const rows = readInvites();
    if (rows.length >= MAX_INVITES) { res.status(409).json({ error: 'Too many invitations stored.' }); return; }
    const id = `inv_${crypto.randomBytes(12).toString('hex')}`; const s = crypto.randomBytes(32).toString('base64url');
    const at = new Date(now());
    rows.push({ id, name, email, note, tokenHash: sha256(s), createdAt: at.toISOString(), createdBy: text(req.auth?.username), expiresAt: new Date(at.getTime() + days * 86400000).toISOString(), revokedAt: '', revokedBy: '', opens: 0 });
    try { writeInvites(rows); } catch { res.status(503).json({ error: 'The invitation could not be saved.' }); return; }
    res.status(201).json({ ok: true, invite: publicRow(rows[rows.length - 1]), link: `${siteUrl}/investor#t=${encodeURIComponent(`AXI1.${id}.${s}`)}` });
  });
  app.post('/owner/investor/invites/:id/revoke', requireStrictAuth, requireSoftwareOwnerRole, (req, res) => {
    noStore(res);
    const rows = readInvites(); const inv = rows.find((i) => i.id === text(req.params.id));
    if (!inv) { res.status(404).json({ error: 'Invitation not found.' }); return; }
    if (!inv.revokedAt) { inv.revokedAt = new Date(now()).toISOString(); inv.revokedBy = text(req.auth?.username); }
    try { writeInvites(rows); } catch { res.status(503).json({ error: 'The invitation could not be withdrawn.' }); return; }
    res.status(200).json({ ok: true, invite: publicRow(inv) });
  });
  // Chunked MP4 upload through the site proxy (same approach as the CPD course videos).
  app.put('/owner/investor/video', requireStrictAuth, requireSoftwareOwnerRole, express.raw({ type: 'application/octet-stream', limit: UPLOAD_CHUNK_MAX }), (req, res) => {
    noStore(res);
    const offset = Number(req.query.offset); const total = Number(req.query.total);
    const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(total) || total < 1024 || total > UPLOAD_TOTAL_MAX || offset < 0 || !body.length || offset + body.length > total) { res.status(400).json({ error: 'Invalid upload chunk.' }); return; }
    const tmp = `${videoPath}.upload`;
    try {
      fs.mkdirSync(root, { recursive: true, mode: 0o700 });
      if (offset === 0) {
        if (body.length < 12 || body.toString('ascii', 4, 8) !== 'ftyp') { res.status(400).json({ error: 'This is not an MP4 video file.' }); return; }
        fs.writeFileSync(tmp, body, { mode: 0o600 });
      } else {
        let have = 0; try { have = fs.statSync(tmp).size; } catch { res.status(409).json({ error: 'Upload not started. Start again.', expectedOffset: 0 }); return; }
        if (have !== offset) { res.status(409).json({ error: 'Upload out of order.', expectedOffset: have }); return; }
        fs.appendFileSync(tmp, body);
      }
      const got = fs.statSync(tmp).size;
      if (got < total) { res.json({ received: got, total, done: false }); return; }
      fs.renameSync(tmp, videoPath);
      res.json({ received: got, total, done: true });
    } catch { res.status(500).json({ error: 'The video could not be saved.' }); }
  });

  return { readInvites, videoPath };
}

// The page itself. Facts only: products marked as available or planned exactly as on the public site;
// no invented customer numbers, revenues or forecasts.
export function investorPageHtml({ name = '', hasVideo = false } = {}) {
  const card = (t, b, tag) => `<div class="card"><div class="tag ${tag === 'Available' ? 'ok' : 'plan'}">${tag}</div><h3>${t}</h3><p>${b}</p></div>`;
  const axes = ['Technical Control', 'Efficiency', 'Robustness of Efficiency', 'Aerobic Capacity', 'Anaerobic Capacity', 'Power &amp; Speed Expression', 'Adaptability', 'Durability'];
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow,noarchive"><meta name="referrer" content="no-referrer">
<title>AthlyraX · Investor &amp; partner introduction</title><link rel="icon" href="/favicon.ico">
<style>:root{color-scheme:dark}*{box-sizing:border-box}body{margin:0;background:#031525;color:#edf8ff;font:16px/1.6 Inter,Segoe UI,Arial,sans-serif}a{color:#65d5ef}header,main,footer{max-width:1080px;margin:auto;padding:20px 24px}header{display:flex;justify-content:space-between;align-items:center;gap:12px;border-bottom:1px solid #214e65}header img{width:190px;height:auto}.private{font-size:12px;letter-spacing:.12em;color:#67d6f4;font-weight:800;text-transform:uppercase}h1{font-size:clamp(30px,5vw,54px);line-height:1.1;margin:18px 0}h2{font-size:clamp(22px,3vw,28px);margin:44px 0 10px}p{color:#c4dce9}.lead{font-size:clamp(17px,2.2vw,20px);max-width:820px}.video{border:1px solid #34718a;background:#082b42;border-radius:15px;padding:10px;margin-top:26px}video{width:100%;aspect-ratio:16/9;display:block;background:#000;border-radius:9px}.novideo{padding:40px 16px;text-align:center;color:#a9c7d8}.grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:14px}.grid.two{grid-template-columns:repeat(2,minmax(0,1fr))}.grid.four{grid-template-columns:repeat(4,minmax(0,1fr))}.card{border:1px solid #265b76;background:#09293d;border-radius:12px;padding:16px}.card h3{margin:4px 0 6px;font-size:17px;color:#fff}.card p{margin:0;font-size:14px}.tag{display:inline-block;font-size:11px;font-weight:800;letter-spacing:.06em;text-transform:uppercase;padding:2px 8px;border-radius:6px}.tag.ok{background:#0f3d2e;color:#7ef0b8}.tag.plan{background:#3b3413;color:#ffd970}.axis{border:1px solid #265b76;border-radius:10px;padding:10px 12px;background:#072236;font-weight:700;font-size:14px}.axis span{display:block;color:#65d5ef;font-size:12px}.action{display:inline-block;background:#4ed4f2;color:#032131;text-decoration:none;padding:13px 22px;border-radius:9px;font-weight:800;margin-top:8px}.note{font-size:13px;color:#9bbccc}footer{border-top:1px solid #285671;font-size:12px;color:#9bbccc;margin-top:40px}button.leave{background:none;border:1px solid #34718a;color:#c4dce9;border-radius:8px;padding:6px 10px;cursor:pointer}@media(max-width:820px){.grid,.grid.four{grid-template-columns:repeat(2,minmax(0,1fr))}}@media(max-width:560px){.grid,.grid.two,.grid.four{grid-template-columns:1fr}header img{width:150px}}</style></head>
<body><header><img src="/images/site/brand-lockup.png" alt="AthlyraX"><span class="private">Investor &amp; partner presentation</span></header>
<main>
<div class="private">For investors &amp; strategic partners</div>
<h1>Effortless data collection. One coherent picture of the athlete.</h1>
<p class="lead">AthlyraX connects training, testing and competition into one evidence-based view of athlete development. It starts in swimming, with a coaching platform, poolside tools, an athlete app, video analysis and coach education already in use.</p>
<div class="video" id="video">${hasVideo ? '<video controls playsinline preload="metadata" controlslist="nodownload" src="/api/investor/video" data-testid="investor-video">Your browser cannot play this video.</video>' : '<div class="novideo" data-testid="investor-video-missing">The introduction video is being prepared and will appear here.</div>'}</div>

<h2>The framework</h2>
<p>AthlyraX separates the work a swimmer performs (training stimulus) from what they can demonstrate (testing capacity) and how they race (competition expression), then connects the three over time in an integrated profile. Coaching decisions remain human-led.</p>
<div class="grid four">${['Training|What was planned, completed and recorded.', 'Testing|What targeted measurements show about capability.', 'Competition|What a swimmer expresses under racing demands.', 'Integrated|The relationship between all three over time.'].map((x) => { const [t, b] = x.split('|'); return `<div class="card"><h3>${t}</h3><p>${b}</p></div>`; }).join('')}</div>

<h2>Eight capability axes</h2>
<p>Every source of evidence is evaluated on the same eight axes, so training, testing and racing can be compared directly.</p>
<div class="grid four">${axes.map((a, i) => `<div class="axis"><span>0${i + 1}</span>${a}</div>`).join('')}</div>

<h2>Products</h2>
<div class="grid">
${card('Coaching Software', 'The coach workspace: session planning, attendance and results, swimmer records and training, testing, competition and integrated capability profiles.', 'Available')}
${card('Stopwatch &amp; Coach Pool Console', 'Poolside timing with lanes, splits, stroke counts and send-offs, saved to the planned session. Assistants can run lanes and send results to the head coach.', 'Available')}
${card('Athlete App', 'Athletes see their club sessions and progress, keep a personal training diary, and can link a login to their existing club record through an emailed invitation, with parent/guardian consent for under-18s.', 'Available')}
${card('Video Analysis', 'Starts, turns, stroke measurements and race footage, connected to the swimmer\'s training and competition evidence.', 'Available')}
${card('Athlyra Education &amp; CPD', 'Coach education with video lessons, assessments and certificates, including a free introduction and paid CPD modules.', 'Available')}
${card('Parent Portal', 'An authorised family view of swimmer development.', 'Planned')}
</div>

<h2>Business model</h2>
<p>Clubs subscribe to the Coaching Software in tiers by club size: £15, £35 and £90 for up to 24, 100 and 200 swimmers, with optional additional swimmer capacity. Education and CPD courses are sold separately as one-time purchases. Figures on usage, customers and revenue are shared in a direct conversation rather than on this page.</p>

<h2>Where AthlyraX is going</h2>
<div class="grid two">
${card('Wearable integration', 'Today, Garmin FIT and TritonWear exports can be imported. The plan is to connect suitable watches, sensors and poolside devices so laps, splits and stroke counts reach the right athlete record automatically.', 'Planned')}
${card('Other sports', 'The training–testing–competition method and the capability approach are designed to extend beyond swimming to other endurance sports.', 'Planned')}
</div>

<h2>Opportunities</h2>
<div class="grid two">
<div class="card"><h3>Investment</h3><p>Funding to accelerate product development, wearable integration and market expansion.</p></div>
<div class="card"><h3>Strategic partnership</h3><p>Technology and device partners, national and club networks, education providers and international distribution.</p></div>
</div>

<h2>Founder</h2>
<p><strong>Sergio Catania</strong>, founder of AthlyraX, has coached swimmers for nearly 30 years in athlete development and competitive coaching. He holds the UK Level 3 coaching qualification and the Italian FIN Allenatore qualification. AthlyraX turns that practical experience into a connected software platform.</p>
<a class="action" href="mailto:athlyrax@outlook.com?subject=AthlyraX%20investment%20and%20partnership" data-testid="investor-contact">Contact AthlyraX</a>
<p class="note">Product descriptions reflect what is available today; items marked Planned are not yet available.</p>
</main>
<footer><div style="display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap"><span>AthlyraX investor and partnership introduction. © AthlyraX.</span></div></footer>
</body></html>`;
}
