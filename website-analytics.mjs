// Privacy-minimised, first-party public website analytics.
// Aggregates daily events; never persists IPs, cookies, user-agent strings or visitor identifiers.
import fs from 'node:fs';
import path from 'node:path';

const PAGES = new Set(['/', '/software', '/framework', '/snapshot', '/books', '/research', '/contact']);
const EVENTS = new Set(['page_view', 'session_start', 'enquiry_click']);
const KEEP_DAYS = 120;
const VALID_HOST = /^[a-z0-9.-]{1,100}$/;
const EMPTY = () => ({ pageViews: 0, estimatedSessions: 0, enquiryClicks: 0, pages: {}, sources: {} });

export function normalizeWebsitePath(raw) {
  if (typeof raw !== 'string' || raw.length > 160) return '';
  let p = raw.split(/[?#]/, 1)[0].replace(/\/+$/, '') || '/';
  if (p.endsWith('.html')) p = p.slice(0, -5);
  if (PAGES.has(p)) return p;
  if (/^\/books\/[a-z0-9-]{1,65}$/.test(p)) return p;
  return '';
}

export function normalizeSource(value) {
  if (typeof value !== 'string') return 'Direct / unknown';
  const host = value.trim().toLowerCase();
  if (!host) return 'Direct / unknown';
  if (!VALID_HOST.test(host) || host.startsWith('.') || host.endsWith('.')) return 'Other / unknown';
  if (host === 'athlyrax.com' || host === 'www.athlyrax.com') return 'Internal';
  return host;
}

export function applyWebsiteEvent(data, input, day) {
  const pathName = normalizeWebsitePath(input.path);
  if (!pathName || !EVENTS.has(input.event)) return false;
  const row = data.days[day] || (data.days[day] = EMPTY());
  if (input.event === 'page_view') {
    row.pageViews += 1;
    row.pages[pathName] = (row.pages[pathName] || 0) + 1;
  } else if (input.event === 'session_start') {
    row.estimatedSessions += 1;
    const source = normalizeSource(input.source);
    row.sources[source] = (row.sources[source] || 0) + 1;
  } else if (pathName === '/contact') {
    row.enquiryClicks += 1;
  } else {
    return false;
  }
  return true;
}

export function websiteSummary(data, days = 30, today = new Date()) {
  const windowDays = [7, 30, 90].includes(Number(days)) ? Number(days) : 30;
  const totals = EMPTY();
  const trend = [];
  for (let i = windowDays - 1; i >= 0; i -= 1) {
    const date = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - i)).toISOString().slice(0, 10);
    const row = data.days?.[date] || EMPTY();
    totals.pageViews += Number(row.pageViews || 0);
    totals.estimatedSessions += Number(row.estimatedSessions || 0);
    totals.enquiryClicks += Number(row.enquiryClicks || 0);
    for (const [name, count] of Object.entries(row.pages || {})) totals.pages[name] = (totals.pages[name] || 0) + Number(count || 0);
    for (const [name, count] of Object.entries(row.sources || {})) totals.sources[name] = (totals.sources[name] || 0) + Number(count || 0);
    trend.push({ date, pageViews: Number(row.pageViews || 0), estimatedSessions: Number(row.estimatedSessions || 0), enquiryClicks: Number(row.enquiryClicks || 0) });
  }
  const sortCounts = (obj) => Object.entries(obj).sort((a,b) => b[1] - a[1]).slice(0, 12).map(([name, count]) => ({ name, count }));
  return { periodDays: windowDays, collectedFrom: data.startedAt || null, totals: { pageViews: totals.pageViews, estimatedSessions: totals.estimatedSessions, enquiryClicks: totals.enquiryClicks }, topPages: sortCounts(totals.pages), sources: sortCounts(totals.sources), trend, methodology: 'Consented first-party events only. Estimated sessions are browser-session starts, not unique people. Enquiry clicks are not completed enquiries. Bots, blockers and disabled consent affect counts. Not comparable directly to Netlify CDN analytics.' };
}

export function registerWebsiteAnalytics(app, { storageRoot, requireStrictAuth, requireSoftwareOwnerRole, resolveClientKey }) {
  const storePath = path.join(storageRoot, 'website-analytics-aggregate.json');
  const rate = new Map();
  let snapshot = null;
  const read = () => {
    if (snapshot) return snapshot;
    try {
      const v = JSON.parse(fs.readFileSync(storePath, 'utf8'));
      snapshot = v && typeof v === 'object' && v.days && typeof v.days === 'object' ? v : { startedAt: new Date().toISOString(), days: {} };
    } catch {
      snapshot = { startedAt: new Date().toISOString(), days: {} };
    }
    return snapshot;
  };
  const persist = (data) => {
    const cutoff = new Date(Date.now() - KEEP_DAYS * 86400000).toISOString().slice(0,10);
    for (const key of Object.keys(data.days)) if (key < cutoff) delete data.days[key];
    fs.mkdirSync(path.dirname(storePath), { recursive: true });
    const temp = storePath + '.' + process.pid + '.tmp';
    try {
      fs.writeFileSync(temp, JSON.stringify(data), { encoding: 'utf8', mode: 0o600 });
      fs.renameSync(temp, storePath);
    } catch (err) {
      try { fs.unlinkSync(temp); } catch {}
      throw err;
    }
  };
  app.post('/website-analytics/collect', (req, res) => {
    // For production, accept only submissions originating on the real AthlyraX website.
    const origin = String(req.headers.origin || '');
    const allowed = origin === 'https://athlyrax.com' || origin === 'https://www.athlyrax.com'
      || (process.env.NODE_ENV !== 'production' && /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin));
    if (!allowed) return res.status(403).json({ error: 'Website origin required.' });
    if (Number(req.headers['content-length'] || 0) > 900) return res.status(413).end();
    const data = req.body;
    if (!data || typeof data !== 'object' || Array.isArray(data) || Object.keys(data).length > 4 ||
        data.consent !== true || !EVENTS.has(data.event)) return res.status(400).json({ error: 'Invalid analytics event.' });
    const ip = String(resolveClientKey(req) || 'unknown');
    const now = Date.now();
    const item = rate.get(ip);
    const bucket = !item || now > item.until ? { count: 0, until: now + 60000 } : item;
    bucket.count += 1;
    rate.set(ip, bucket);
    if (rate.size > 2000) for (const [key, b] of rate) if (now > b.until) rate.delete(key);
    if (bucket.count > 35) return res.status(429).end();
    const day = new Date().toISOString().slice(0, 10);
    const store = read();
    if (!applyWebsiteEvent(store, data, day)) return res.status(400).json({ error: 'Invalid page or event.' });
    try { persist(store); } catch { return res.status(503).json({ error: 'Analytics storage unavailable.' }); }
    return res.status(204).end();
  });
  app.get('/website-analytics/owner-summary', requireStrictAuth, requireSoftwareOwnerRole, (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json(websiteSummary(read(), req.query.days));
  });
}
