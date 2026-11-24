// Demonstration statistics, aggregate only (owner decision 24-11-2026; replaces per-session demo activity records).
//
// What is kept: counts per day (sessions, estimated active seconds, engaged sessions) and per week (sections opened
// and their estimated active seconds, approximate country/region, city counts) for the two public demonstration
// accounts, split into three classes:
//   human_likely  - no verified test marker, no automation signal, and some real interaction (active time > 0).
//                   Not proof of a person.
//   verified_test - the session was marked by authorised test infrastructure with a server-held secret.
//   unclassified  - an automation signal (navigator.webdriver) without a verified marker, or no interaction at all;
//                   also every record from before this change (legacy), for which no reliable evidence exists.
// What is never kept: identifiers of browsers, devices or people, IP addresses, per-session timelines. A session's
// counters exist only in memory while it is open (needed to classify it), and are added to the aggregates and
// discarded when the session ends, after 30 minutes without activity, or when the server stops.
// City is shown only where at least CITY_MIN_SESSIONS sessions share it in the period; otherwise only country/region.
// Retention: 90 days for the aggregate files.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DEMO_ACTIVITY_ACCOUNTS, DEMO_SECTIONS, sessionRefOf } from './demo-activity.mjs';

export const DEMO_STATS_RETENTION_DAYS = 90;
export const DEMO_STATS_CLASSES = Object.freeze(['human_likely', 'verified_test', 'unclassified']);
export const CITY_MIN_SESSIONS = 5;
const IDLE_MS = 30 * 60000;
const MAX_EVENTS = 20;
const TEST_MARK_TTL_MS = 12 * 3600000;
const EVENT_TYPES = new Set(['enter', 'active', 'end']);

const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10);
const mondayOf = (day) => { const d = new Date(`${day}T12:00:00Z`); d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7)); return d.toISOString().slice(0, 10); };
const emptyAccount = () => ({ sessions: 0, activeSeconds: 0, engagedSessions: 0, sectionsOpened: 0 });
const emptyWeekClass = () => ({ sections: {}, geo: {}, cities: {}, unknownLocation: 0 });
export const demoStatsDir = (storageRoot) => path.join(storageRoot, 'demo-stats');

// Constant-time comparison of the test marker with the server-held secret (never logged, never sent anywhere).
export function testMarkerValid(given, secret) {
  const key = String(secret || '');
  const value = String(given || '');
  if (key.length < 32 || !value) return false;
  const a = crypto.createHash('sha256').update(value).digest();
  const b = crypto.createHash('sha256').update(key).digest();
  return crypto.timingSafeEqual(a, b);
}

export function classifySession(s) {
  if (s.testVerified) return 'verified_test';
  if (s.automation || !(s.activeSeconds > 0)) return 'unclassified';
  return 'human_likely';
}

function readJson(fsModule, file, fallback) {
  try { return JSON.parse(fsModule.readFileSync(file, 'utf8')); } catch { return fallback; }
}
function writeJsonAtomic(fsModule, file, value) {
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fsModule.writeFileSync(tmp, JSON.stringify(value), 'utf8');
  fsModule.renameSync(tmp, file);
}

/** Adds one finished session to the day and week aggregates (no session identity is written). */
export function addSessionToAggregates(storageRoot, s, cls, { fsModule = fs } = {}) {
  const dir = demoStatsDir(storageRoot); fsModule.mkdirSync(dir, { recursive: true });
  const day = dayOf(s.startedAt); const week = mondayOf(day);
  const dayFile = path.join(dir, `day-${day}.json`);
  const d = readJson(fsModule, dayFile, { v: 1, day, classes: {} });
  const acc = ((d.classes[cls] ||= {})[s.app] ||= emptyAccount());
  acc.sessions += 1; acc.activeSeconds += Math.round(s.activeSeconds); acc.sectionsOpened += Object.keys(s.sections).length;
  if (s.activeSeconds >= 60) acc.engagedSessions += 1;
  writeJsonAtomic(fsModule, dayFile, d);
  const weekFile = path.join(dir, `week-${week}.json`);
  const w = readJson(fsModule, weekFile, { v: 1, weekStart: week, classes: {} });
  const wc = (w.classes[cls] ||= emptyWeekClass());
  for (const [section, v] of Object.entries(s.sections)) {
    const k = `${s.app}:${section}`; const row = (wc.sections[k] ||= { visits: 0, seconds: 0 });
    row.visits += v.visits; row.seconds += Math.round(v.seconds);
  }
  if (s.geo) {
    const g = `${s.geo.countryCode}|${s.geo.country}|${s.geo.region}`; wc.geo[g] = (wc.geo[g] || 0) + 1;
    if (s.geo.city) { const c = `${s.geo.countryCode}|${s.geo.region}|${s.geo.city}`; wc.cities[c] = (wc.cities[c] || 0) + 1; }
  } else wc.unknownLocation += 1;
  writeJsonAtomic(fsModule, weekFile, w);
}

export function pruneDemoStats(storageRoot, { now = Date.now(), fsModule = fs, retentionDays = DEMO_STATS_RETENTION_DAYS } = {}) {
  const dir = demoStatsDir(storageRoot); if (!fsModule.existsSync(dir)) return 0;
  const oldest = dayOf(now - retentionDays * 86400000); let removed = 0;
  for (const name of fsModule.readdirSync(dir)) {
    const m = name.match(/^(day|week)-(\d{4}-\d{2}-\d{2})\.json$/); if (!m) continue;
    const lastDay = m[1] === 'week' ? dayOf(Date.parse(`${m[2]}T12:00:00Z`) + 6 * 86400000) : m[2];
    if (lastDay < oldest) { fsModule.rmSync(path.join(dir, name), { force: true }); removed += 1; }
  }
  return removed;
}

export function createDemoStatsCollector({ storageRoot, now = () => Date.now(), activeBudget = null, fsModule = fs, onError = () => {} } = {}) {
  const open = new Map(); // session ref -> counters, in memory only
  const testMarks = new Map(); // session ref -> expiry (verified test sessions)
  const flush = (ref) => {
    const s = open.get(ref); if (!s) return; open.delete(ref);
    const mark = testMarks.get(ref); if (mark && mark > now()) s.testVerified = true;
    try { addSessionToAggregates(storageRoot, s, classifySession(s), { fsModule }); } catch (error) { onError(error); }
  };
  return {
    accept({ account, csrf, body = {}, geo = null }) {
      const app = DEMO_ACTIVITY_ACCOUNTS[String(account || '').toLowerCase()];
      if (!app) return { ok: false, error: 'Not a demonstration account.' };
      const events = Array.isArray(body?.events) ? body.events : null;
      if (!events || events.length > MAX_EVENTS) return { ok: false, error: 'Invalid activity batch.' };
      const ref = sessionRefOf(csrf); const t = now();
      // Objection: the open session is discarded; nothing of it is counted.
      if (body.optOut === true) { open.delete(ref); return { ok: true, discarded: true }; }
      const s = open.get(ref) || { app, startedAt: t, lastAt: t, activeSeconds: 0, sections: {}, geo: null, automation: false, testVerified: false };
      if (body.automation === true) s.automation = true;
      if (geo && !s.geo) s.geo = { countryCode: geo.countryCode, country: geo.country, region: geo.region, city: geo.city };
      let ended = false;
      for (const raw of events) {
        const type = String(raw?.type || ''); const section = String(raw?.section || '');
        if (!EVENT_TYPES.has(type) || !DEMO_SECTIONS[app].has(section)) continue;
        const row = (s.sections[section] ||= { visits: 0, seconds: 0 });
        if (type === 'enter') row.visits += 1;
        if (type === 'active') {
          let seconds = Math.max(0, Math.min(60, Math.round(Number(raw?.seconds) || 0)));
          if (activeBudget) seconds = activeBudget.take(ref, seconds, t);
          row.seconds += seconds; s.activeSeconds += seconds;
        }
        if (type === 'end') ended = true;
      }
      s.lastAt = t; open.set(ref, s);
      if (ended) flush(ref);
      return { ok: true, locationVerified: Boolean(geo) };
    },
    markTest(csrf) {
      const ref = sessionRefOf(csrf); testMarks.set(ref, now() + TEST_MARK_TTL_MS);
      const s = open.get(ref); if (s) s.testVerified = true;
    },
    sweep() {
      const t = now();
      for (const [ref, s] of open) if (t - s.lastAt > IDLE_MS) flush(ref);
      for (const [ref, exp] of testMarks) if (exp <= t) testMarks.delete(ref);
    },
    flushAll() { for (const ref of [...open.keys()]) flush(ref); },
    openSessions: () => open.size,
  };
}

const addInto = (target, source) => { for (const [k, v] of Object.entries(source || {})) target[k] = (target[k] || 0) + v; };

/** Legacy per-session records (before 24-11-2026) as unclassified aggregates: no evidence exists to classify them. */
export function legacyAggregates(records = []) {
  const sessions = new Map();
  for (const r of records) {
    if (r.kind === 'withdrawn' || !r.session) continue;
    const app = DEMO_ACTIVITY_ACCOUNTS[String(r.account || '').toLowerCase()]; if (!app) continue;
    const s = sessions.get(r.session) || { app, startedAt: Date.parse(r.at), activeSeconds: 0, sections: {}, geo: null };
    if (r.section && (r.kind === 'enter' || r.kind === 'active')) {
      const row = (s.sections[r.section] ||= { visits: 0, seconds: 0 });
      if (r.kind === 'enter') row.visits += 1; else { row.seconds += r.seconds || 0; s.activeSeconds += r.seconds || 0; }
    }
    if (r.geo && !s.geo) s.geo = r.geo;
    sessions.set(r.session, s);
  }
  return [...sessions.values()];
}

/** Owner report from the aggregate files (and legacy records, all unclassified). */
export function buildDemoStatsReport({ storageRoot, days = 30, now = Date.now(), legacyRecords = [], openSessions = 0, fsModule = fs } = {}) {
  const period = [7, 30, 90].includes(Number(days)) ? Number(days) : 30;
  const from = dayOf(now - (period - 1) * 86400000); const to = dayOf(now);
  const out = {};
  for (const cls of DEMO_STATS_CLASSES) out[cls] = { sessions: 0, byAccount: { coach: emptyAccount(), athlete: emptyAccount() }, activeSeconds: 0, engagedSessions: 0, sections: {}, geo: {}, cities: {}, unknownLocation: 0, daily: {}, weekly: {}, legacySessions: 0 };
  const dir = demoStatsDir(storageRoot);
  const files = fsModule.existsSync(dir) ? fsModule.readdirSync(dir) : [];
  for (const name of files) {
    const m = name.match(/^day-(\d{4}-\d{2}-\d{2})\.json$/); if (!m || m[1] < from || m[1] > to) continue;
    const d = readJson(fsModule, path.join(dir, name), null); if (!d) continue;
    for (const [cls, apps] of Object.entries(d.classes || {})) {
      const o = out[cls]; if (!o) continue;
      for (const [app, a] of Object.entries(apps)) {
        addInto(o.byAccount[app] ||= emptyAccount(), a);
        o.sessions += a.sessions; o.activeSeconds += a.activeSeconds; o.engagedSessions += a.engagedSessions;
        const day = (o.daily[m[1]] ||= { sessions: 0, activeSeconds: 0 }); day.sessions += a.sessions; day.activeSeconds += a.activeSeconds;
        const wk = (o.weekly[mondayOf(m[1])] ||= { sessions: 0, activeSeconds: 0 }); wk.sessions += a.sessions; wk.activeSeconds += a.activeSeconds;
      }
    }
  }
  for (const name of files) {
    const m = name.match(/^week-(\d{4}-\d{2}-\d{2})\.json$/); if (!m || m[1] > to || dayOf(Date.parse(`${m[1]}T12:00:00Z`) + 6 * 86400000) < from) continue;
    const w = readJson(fsModule, path.join(dir, name), null); if (!w) continue;
    for (const [cls, c] of Object.entries(w.classes || {})) {
      const o = out[cls]; if (!o) continue;
      for (const [k, v] of Object.entries(c.sections || {})) { const row = (o.sections[k] ||= { visits: 0, seconds: 0 }); row.visits += v.visits; row.seconds += v.seconds; }
      addInto(o.geo, c.geo); addInto(o.cities, c.cities); o.unknownLocation += c.unknownLocation || 0;
    }
  }
  // Legacy records: unclassified, counted in the same way.
  const u = out.unclassified;
  for (const s of legacyAggregates(legacyRecords)) {
    const day = dayOf(s.startedAt); if (day < from || day > to) continue;
    const a = (u.byAccount[s.app] ||= emptyAccount());
    a.sessions += 1; a.activeSeconds += s.activeSeconds; a.sectionsOpened += Object.keys(s.sections).length; if (s.activeSeconds >= 60) a.engagedSessions += 1;
    u.sessions += 1; u.legacySessions += 1; u.activeSeconds += s.activeSeconds; if (s.activeSeconds >= 60) u.engagedSessions += 1;
    const dd = (u.daily[day] ||= { sessions: 0, activeSeconds: 0 }); dd.sessions += 1; dd.activeSeconds += s.activeSeconds;
    const wk = (u.weekly[mondayOf(day)] ||= { sessions: 0, activeSeconds: 0 }); wk.sessions += 1; wk.activeSeconds += s.activeSeconds;
    for (const [sec, v] of Object.entries(s.sections)) { const row = (u.sections[`${s.app}:${sec}`] ||= { visits: 0, seconds: 0 }); row.visits += v.visits; row.seconds += v.seconds; }
    if (s.geo) { const g = `${s.geo.countryCode}|${s.geo.country}|${s.geo.region}`; u.geo[g] = (u.geo[g] || 0) + 1; if (s.geo.city) { const c = `${s.geo.countryCode}|${s.geo.region}|${s.geo.city}`; u.cities[c] = (u.cities[c] || 0) + 1; } } else u.unknownLocation += 1;
  }
  const shape = (o) => ({
    sessions: o.sessions, byAccount: o.byAccount, activeSeconds: o.activeSeconds, engagedSessions: o.engagedSessions,
    averageActiveSeconds: o.sessions ? Math.round(o.activeSeconds / o.sessions) : 0, legacySessions: o.legacySessions,
    sections: Object.entries(o.sections).map(([k, v]) => ({ app: k.split(':')[0], section: k.slice(k.indexOf(':') + 1), visits: v.visits, seconds: v.seconds })).sort((a, b) => b.seconds - a.seconds || b.visits - a.visits),
    geography: Object.entries(o.geo).map(([k, n]) => { const [countryCode, country, region] = k.split('|'); return { countryCode, country, region, sessions: n }; }).sort((a, b) => b.sessions - a.sessions),
    // Cities only where enough sessions share them; the rest stay at country/region level.
    cities: Object.entries(o.cities).filter(([, n]) => n >= CITY_MIN_SESSIONS).map(([k, n]) => { const [countryCode, region, city] = k.split('|'); return { countryCode, region, city, sessions: n }; }).sort((a, b) => b.sessions - a.sessions),
    unknownLocationSessions: o.unknownLocation,
    daily: Object.entries(o.daily).map(([day, v]) => ({ day, ...v })).sort((a, b) => a.day.localeCompare(b.day)),
    weekly: Object.entries(o.weekly).map(([weekStart, v]) => ({ weekStart, ...v })).sort((a, b) => a.weekStart.localeCompare(b.weekStart)),
  });
  return {
    periodDays: period, from, to, retentionDays: DEMO_STATS_RETENTION_DAYS, cityMinSessions: CITY_MIN_SESSIONS,
    openSessionsNotYetCounted: openSessions,
    classes: Object.fromEntries(DEMO_STATS_CLASSES.map((cls) => [cls, shape(out[cls])])),
  };
}
