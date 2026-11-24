// Demo visitor activity (owner decision 23-11-2026). Only the public demonstration accounts are recorded.
// Three separate things, never mixed up:
//   session  - one sign-in (a hash of that session's CSRF value; never the session token itself)
//   browser  - an optional random ID the visitor's browser keeps ONLY after the visitor agrees; it links that
//              browser's sessions (it is not a person: one person may use several browsers, and one browser
//              may be shared)
//   person   - never recorded or inferred.
// Recorded per session: which existing sections were opened, when, and an ESTIMATED active time (the app counts
// only seconds while it is visible, focused and used in the last 60 s; at most 60 s per minute). Approximate
// location is taken only from Netlify's own geolocation, forwarded with a signature the browser cannot forge;
// otherwise it is Unknown. No IP address, token, form content or athlete data is ever stored here.
// Retention: 90 days, enforced by deleting whole day files.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const DEMO_ACTIVITY_RETENTION_DAYS = 90;
export const DEMO_ACTIVITY_ACCOUNTS = Object.freeze({ 'demo.coach': 'coach', marco: 'athlete' });
// The applications' own section identifiers (coaching app activeSection keys; Athlete App data-page values).
export const DEMO_SECTIONS = Object.freeze({
  coach: new Set(['overview', 'data-health', 'training-planner', 'calendar', 'timetables', 'fixtures', 'swimmers', 'coaches', 'squads',
    'attendance', 'tests', 'squad-transfers', 'snapshot-bulk-upload', 'analysis-isp', 'training-analysis', 'capability-analysis',
    'analysis-supporting-evidence', 'analysis-technical', 'analysis-development-characteristics', 'reports-home', 'plan-report',
    'attendance-report', 'capability-report', 'longitudinal-development-report', 'isp-report', 'venues', 'validation', 'storage',
    'getting-started', 'coach-knowledge-check', 'pool-console']),
  athlete: new Set(['home', 'timetable', 'daily', 'tests', 'fixtures', 'integrated', 'development', 'progress', 'coach', 'account']),
});
const EVENT_TYPES = new Set(['enter', 'active', 'end']);
const CONSENT = new Set(['granted', 'declined', 'withdrawn', 'unset']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MAX_EVENTS = 20;
const GEO_MAX_AGE_MS = 2 * 60 * 1000;

export const sessionRefOf = (csrf) => crypto.createHash('sha256').update(String(csrf || '')).digest('hex').slice(0, 12);
const clean = (value, max = 80) => String(value ?? '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, max);

// Netlify geolocation forwarded by our Edge Function: base64url JSON + HMAC-SHA256 with a shared secret that exists
// only on Netlify and on the backend. Anything unsigned, wrongly signed or older than two minutes is ignored.
export function verifiedGeoFrom(headers = {}, secret = '', now = Date.now()) {
  const key = String(secret || '');
  const payload = String(headers['x-athlyrax-geo'] || '');
  const signature = String(headers['x-athlyrax-geo-sig'] || '');
  if (key.length < 32 || !payload || !/^[0-9a-f]{64}$/.test(signature) || payload.length > 600) return null;
  const expected = crypto.createHmac('sha256', key).update(payload).digest();
  const given = Buffer.from(signature, 'hex');
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null;
  let geo;
  try { geo = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')); } catch { return null; }
  if (!Number.isFinite(Number(geo?.t)) || Math.abs(now - Number(geo.t)) > GEO_MAX_AGE_MS) return null;
  const out = { countryCode: clean(geo.cc, 2).toUpperCase(), country: clean(geo.c), region: clean(geo.r), city: clean(geo.ci) };
  return out.country || out.countryCode ? out : null;
}

/** Validates one batch from a demo browser. Returns { ok, records } or { ok: false, error }. */
export function acceptDemoActivity({ account, csrf, body, geo = null, now = Date.now(), activeBudget }) {
  const app = DEMO_ACTIVITY_ACCOUNTS[String(account || '').toLowerCase()];
  if (!app) return { ok: false, error: 'Not a demonstration account.' };
  const events = Array.isArray(body?.events) ? body.events : null;
  if (!events || events.length > MAX_EVENTS) return { ok: false, error: 'Invalid activity batch.' };
  const consent = CONSENT.has(body?.consent) ? body.consent : 'unset';
  const browserCandidate = String(body?.browserId || '').toLowerCase();
  const browser = (consent === 'granted' || consent === 'withdrawn') && UUID.test(browserCandidate) ? browserCandidate : null;
  const session = sessionRefOf(csrf);
  const records = [];
  // Withdrawal: the identifier is erased from every stored record (eraseBrowserFromDemoActivity); nothing new keeps it.
  const erase = consent === 'withdrawn' && browser ? browser : null;
  for (const raw of events) {
    const type = String(raw?.type || '');
    const section = String(raw?.section || '');
    if (!EVENT_TYPES.has(type) || !DEMO_SECTIONS[app].has(section)) continue;
    const t = Number(raw?.at);
    const at = Number.isFinite(t) && t <= now + 60000 && t >= now - 10 * 60000 ? t : now;
    let seconds = 0;
    if (type === 'active') {
      seconds = Math.max(0, Math.min(60, Math.round(Number(raw?.seconds) || 0)));
      // A session never gets more active time than the real time elapsed since it started (+60 s), whatever the tabs.
      if (activeBudget) seconds = activeBudget.take(session, seconds, now);
      if (!seconds) continue;
    }
    records.push({ v: 1, at: new Date(at).toISOString(), kind: type, account: String(account).toLowerCase(), session,
      browser: consent === 'granted' ? browser : null, section, ...(seconds ? { seconds } : {}), ...(geo ? { geo } : {}) });
  }
  return { ok: true, records, erase };
}

// A session's estimated active time can never exceed the real time elapsed since the server first saw it
// (plus one minute of grace): two tabs, replayed or inflated requests cannot add more. Server clock only.
export function createActiveTimeBudget(graceSeconds = 60) {
  const sessions = new Map();
  return {
    take(session, wanted, now = Date.now()) {
      if (sessions.size > 5000) { for (const k of [...sessions.keys()].slice(0, 2500)) sessions.delete(k); }
      const entry = sessions.get(session) || { first: now, granted: 0 };
      const allowed = Math.floor(Math.max(0, now - entry.first) / 1000) + graceSeconds - entry.granted;
      const grant = Math.max(0, Math.min(wanted, allowed));
      entry.granted += grant; sessions.set(session, entry); return grant;
    },
  };
}

// ---------- storage: one file per day; files older than the retention are deleted ----------
const dayOf = (iso) => String(iso).slice(0, 10);
export function demoActivityDir(storageRoot) { return path.join(storageRoot, 'demo-activity'); }
export function appendDemoActivity(storageRoot, records = [], { now = Date.now(), fsModule = fs } = {}) {
  if (!records.length) return 0;
  const dir = demoActivityDir(storageRoot); fsModule.mkdirSync(dir, { recursive: true });
  const byDay = new Map();
  for (const r of records) { const d = dayOf(r.at); byDay.set(d, `${byDay.get(d) || ''}${JSON.stringify(r)}\n`); }
  for (const [d, text] of byDay) fsModule.appendFileSync(path.join(dir, `${d}.jsonl`), text, 'utf8');
  pruneDemoActivity(storageRoot, { now, fsModule });
  return records.length;
}
// Removes a withdrawn browser identifier from every stored record (each day file rewritten atomically).
export function eraseBrowserFromDemoActivity(storageRoot, browserId, { fsModule = fs } = {}) {
  const id = String(browserId || '').toLowerCase();
  const dir = demoActivityDir(storageRoot);
  if (!UUID.test(id) || !fsModule.existsSync(dir)) return 0;
  let changed = 0;
  for (const name of fsModule.readdirSync(dir).filter((n) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(n))) {
    const file = path.join(dir, name);
    const text = fsModule.readFileSync(file, 'utf8');
    if (!text.includes(id)) continue;
    const next = text.split('\n').map((line) => {
      if (!line || !line.includes(id)) return line;
      try { const row = JSON.parse(line); if (row.browser === id) { changed += 1; return JSON.stringify({ ...row, browser: null }); } } catch { /* damaged line kept as is */ }
      return line;
    }).join('\n');
    const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
    fsModule.writeFileSync(tmp, next, 'utf8'); fsModule.renameSync(tmp, file);
  }
  return changed;
}

export function pruneDemoActivity(storageRoot, { now = Date.now(), fsModule = fs, retentionDays = DEMO_ACTIVITY_RETENTION_DAYS } = {}) {
  const dir = demoActivityDir(storageRoot); if (!fsModule.existsSync(dir)) return 0;
  const oldest = new Date(now - retentionDays * 86400000).toISOString().slice(0, 10);
  let removed = 0;
  for (const name of fsModule.readdirSync(dir)) {
    const m = name.match(/^(\d{4}-\d{2}-\d{2})\.jsonl$/);
    if (m && m[1] < oldest) { fsModule.rmSync(path.join(dir, name), { force: true }); removed += 1; }
  }
  return removed;
}
export function readDemoActivity(storageRoot, { now = Date.now(), fsModule = fs, retentionDays = DEMO_ACTIVITY_RETENTION_DAYS } = {}) {
  const dir = demoActivityDir(storageRoot); if (!fsModule.existsSync(dir)) return [];
  const oldest = new Date(now - retentionDays * 86400000).toISOString().slice(0, 10);
  const rows = [];
  for (const name of fsModule.readdirSync(dir).filter((n) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(n) && n.slice(0, 10) >= oldest).sort()) {
    for (const line of fsModule.readFileSync(path.join(dir, name), 'utf8').split('\n')) { if (!line) continue; try { rows.push(JSON.parse(line)); } catch { /* skip a damaged line */ } }
  }
  return rows;
}

// ---------- owner report ----------
const labelFor = (i) => { let s = ''; let n = i; do { s = String.fromCharCode(65 + (n % 26)) + s; n = Math.floor(n / 26) - 1; } while (n >= 0); return `Visitor ${s}`; };
const locationText = (g) => (g ? [g.city, g.region, g.country || g.countryCode].filter(Boolean).join(', ') : '') || 'Unknown';

export function buildDemoActivityReport(records = [], { logins = 0, now = Date.now(), incompleteAfterMs = 30 * 60000 } = {}) {
  const withdrawn = new Set(records.filter((r) => r.kind === 'withdrawn' && r.browser).map((r) => r.browser));
  const sessions = new Map();
  for (const r of records.filter((x) => x.kind !== 'withdrawn').sort((a, b) => a.at.localeCompare(b.at))) {
    const s = sessions.get(r.session) || { session: r.session, account: r.account, browser: null, firstAt: r.at, lastAt: r.at, activeSeconds: 0, ended: false, location: null, timeline: [] };
    if (r.browser && !withdrawn.has(r.browser)) s.browser = r.browser;
    s.lastAt = r.at; if (r.geo) s.location = r.geo;
    if (r.kind === 'enter' && s.timeline.at(-1)?.section !== r.section) s.timeline.push({ section: r.section, enteredAt: r.at, estimatedActiveSeconds: 0 });
    if (r.kind === 'active') {
      // Active time belongs to the most recent visit of that section (a section opened twice is counted per visit).
      s.activeSeconds += r.seconds || 0;
      let visit = s.timeline.findLast((t) => t.section === r.section);
      if (!visit) { visit = { section: r.section, enteredAt: r.at, estimatedActiveSeconds: 0 }; s.timeline.push(visit); }
      visit.estimatedActiveSeconds += r.seconds || 0;
    }
    if (r.kind === 'end') s.ended = true;
    sessions.set(r.session, s);
  }
  const sessionRows = [...sessions.values()].map((s) => ({
    session: s.session, account: s.account, browserLinked: Boolean(s.browser), signedInAt: s.firstAt, lastObservedAt: s.lastAt,
    connectedSeconds: Math.max(0, Math.round((Date.parse(s.lastAt) - Date.parse(s.firstAt)) / 1000)),
    estimatedActiveSeconds: s.activeSeconds, location: locationText(s.location), locationKnown: Boolean(s.location),
    incomplete: !s.ended && now - Date.parse(s.lastAt) > incompleteAfterMs, closedObserved: s.ended,
    sections: s.timeline.map((t) => ({ ...t })),
    _browser: s.browser,
  }));
  const browsers = new Map();
  for (const row of sessionRows.filter((r) => r._browser).sort((a, b) => a.signedInAt.localeCompare(b.signedInAt))) {
    if (!browsers.has(row._browser)) browsers.set(row._browser, []);
    browsers.get(row._browser).push(row);
  }
  const strip = ({ _browser, ...row }) => row;
  const summarise = (label, rows, linked) => {
    const last = rows.reduce((a, r) => (r.lastObservedAt > a ? r.lastObservedAt : a), '');
    const located = [...rows].reverse().find((r) => r.locationKnown);
    return { visitor: label, browserLinked: linked, returning: linked && rows.length > 1, accounts: [...new Set(rows.map((r) => r.account))],
      location: located ? located.location : 'Unknown', sessions: rows.length,
      sectionsViewed: [...new Set(rows.flatMap((r) => r.sections.map((s) => s.section)))],
      estimatedActiveSeconds: rows.reduce((n, r) => n + r.estimatedActiveSeconds, 0), connectedSeconds: rows.reduce((n, r) => n + r.connectedSeconds, 0),
      lastVisitAt: last, sessionDetails: rows.map(strip) };
  };
  const visitors = [...browsers.values()].map((rows, i) => summarise(labelFor(i), rows, true));
  const unlinked = sessionRows.filter((r) => !r._browser).map((r) => summarise('Unlinked session', [r], false));
  const all = [...visitors, ...unlinked].sort((a, b) => b.lastVisitAt.localeCompare(a.lastVisitAt));
  return {
    retentionDays: DEMO_ACTIVITY_RETENTION_DAYS,
    measures: {
      successfulLogins: logins, sessions: sessionRows.length, linkedBrowsers: browsers.size,
      returningBrowsers: [...browsers.values()].filter((rows) => rows.length > 1).length, unlinkedSessions: unlinked.length,
      connectedSeconds: sessionRows.reduce((n, r) => n + r.connectedSeconds, 0), estimatedActiveSeconds: sessionRows.reduce((n, r) => n + r.estimatedActiveSeconds, 0),
    },
    visitors: all,
  };
}
