#!/usr/bin/env node
// Generates owner/system-map.data.json from the actual code (no data files are read).
// Usage: node scripts/generate-owner-system-map.mjs [--website <path to athlyrax-v6-private>] [--check]
// Storage is JSON documents per club (tenants/<club>/db.json) and auth-users.json: there are no
// database-enforced foreign keys. Relationships are reported as "field reference (inferred)" with the
// files that use them; only checks implemented in code are reported as "enforced in code".
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const args = process.argv.slice(2);
const websiteDir = args.includes('--website') ? path.resolve(args[args.indexOf('--website') + 1]) : '';
const check = args.includes('--check');
const OUT = path.join(ROOT, 'owner', 'system-map.data.json');

const SCAN = args.includes('--backend-dir') ? path.resolve(args[args.indexOf('--backend-dir') + 1]) : ROOT; // a production-built copy includes build-time routes
const backendFiles = fs.readdirSync(SCAN).filter((f) => /\.(m?js)$/.test(f) && !f.startsWith('.')).map((f) => path.join(SCAN, f));
const read = (f) => fs.readFileSync(f, 'utf8');
const rel = (f, base = SCAN) => path.relative(base, f).split(path.sep).join('/');

// ---- routes and their permission middleware ----
const AUTH_MW = /^(require[A-Za-z]+)$/;
const routes = [];
for (const file of backendFiles) {
  const src = read(file);
  const re = /app\.(get|post|put|patch|delete)\(\s*(?:base\s*\+\s*)?(['"`])([^'"`]+)\2\s*,([^\n]*)/g;
  let m;
  const base = (src.match(/const base = ['"]([^'"]+)['"]/) || [])[1] || '';
  while ((m = re.exec(src))) {
    const usesBase = /app\.\w+\(\s*base\s*\+/.test(m[0]);
    const routePath = (usesBase ? base : '') + m[3];
    const mws = m[4].split(',').map((s) => s.trim()).filter((s) => AUTH_MW.test(s));
    const line = src.slice(0, m.index).split('\n').length;
    routes.push({ method: m[1].toUpperCase(), path: routePath, guards: mws, file: rel(file), line, area: areaOf(routePath) });
  }
}
function areaOf(p) {
  const s = p.split('/').filter(Boolean)[0] || '';
  return { coach: 'Coaching Software / Pool Console', swimmer: 'Athlete App', 'athlete-invites': 'Athlete App invitations', auth: 'Accounts & login', db: 'Club data (whole-club load/save)', cpd: 'Education (CPD)', billing: 'Billing (Stripe)', webhooks: 'External webhooks', owner: 'Owner administration', admin: 'Administration', 'website-analytics': 'Website analytics' }[s] || s || 'root';
}
const permissionOf = (guards) => {
  if (guards.includes('requireSoftwareOwnerRole')) return 'Primary software owner only';
  if (guards.some((g) => /Manager|WriteRole|HeadCoach|Admin/.test(g))) return `Signed in + role check (${guards.filter((g) => g !== 'requireStrictAuth').join(', ')})`;
  if (guards.includes('requireStrictAuth')) return 'Signed in (scope checked inside the handler)';
  return guards.length ? guards.join(', ') : 'Public (token/secret or rate limit checked inside the handler where relevant)';
};
for (const r of routes) r.permission = permissionOf(r.guards);

// ---- club data collections used by the code ----
const collections = new Map();
const touch = (name, file, kind) => {
  if (!/^[a-z][A-Za-z0-9]{2,}$/.test(name) || ['length', 'map', 'filter', 'find', 'some', 'every', 'forEach', 'push', 'slice', 'concat', 'includes', 'keys', 'values', 'entries', 'then', 'catch', 'toString'].includes(name)) return;
  if (!collections.has(name)) collections.set(name, { name, files: new Set(), writes: new Set() });
  collections.get(name).files.add(rel(file));
  if (kind === 'write') collections.get(name).writes.add(rel(file));
};
for (const file of backendFiles) {
  const src = read(file);
  for (const m of src.matchAll(/\b(?:db|nextDb|current|existing|db0|out\.db|next)\.([a-zA-Z][A-Za-z0-9]+)\b/g)) touch(m[1], file, 'read');
  for (const m of src.matchAll(/\b(?:db|nextDb|db0)\[['"]([a-zA-Z][A-Za-z0-9]+)['"]\]/g)) touch(m[1], file, 'read');
  for (const m of src.matchAll(/\.\.\.(?:db|db0|nextDb),\s*\[?([a-zA-Z][A-Za-z0-9_]*)\]?\s*:/g)) touch(m[1], file, 'write');
  for (const m of src.matchAll(/\{\s*\.\.\.db,\s*([a-zA-Z][A-Za-z0-9]+)\s*[,}]/g)) touch(m[1], file, 'write');
}
// keep names that look like collections (used as arrays somewhere)
const allSrc = backendFiles.map(read).join('\n');
const recognized = (read(path.join(ROOT, 'scripts', 'tenant-db-integrity.mjs')).match(/RECOGNIZED_COLLECTIONS = Object\.freeze\(\[([\s\S]*?)\]\)/) || [, ''])[1].match(/'([^']+)'/g)?.map((x) => x.slice(1, -1)) || [];
for (const m of allSrc.matchAll(/([A-Z_]+_COLLECTION) = '([A-Za-z]+)'/g)) {
  recognized.push(m[2]);
  const users = backendFiles.filter((f) => read(f).includes(m[1])).map((f) => rel(f));
  if (!collections.has(m[2])) collections.set(m[2], { name: m[2], files: new Set(), writes: new Set() });
  users.forEach((u) => { collections.get(m[2]).files.add(u); collections.get(m[2]).writes.add(u); });
}
for (const name of recognized) if (!collections.has(name)) collections.set(name, { name, files: new Set(), writes: new Set() });
const collectionList = [...collections.values()].filter((c) => recognized.includes(c.name) || new RegExp(`list\\((?:db|db0)\\.${c.name}\\)|Array\\.isArray\\((?:db|db0|nextDb)\\.${c.name}\\)|\\[${c.name.replace(/^./, (x) => x.toUpperCase())}|COLLECTION = '${c.name}'`).test(allSrc) || new RegExp(`COLLECTION = '${c.name}'`).test(allSrc))
  .map((c) => ({ name: c.name, recognisedByIntegrityCheck: recognized.includes(c.name), usedIn: [...c.files].sort(), writtenIn: [...c.writes].sort() })).sort((a, b) => a.name.localeCompare(b.name));
const collectionNames = new Set(collectionList.map((c) => c.name));

// ---- field references between records (inferred from *Id fields) ----
const REF_TARGET = { swimmerId: 'swimmers', squadId: 'squads', currentSquadId: 'squads', scheduleId: 'schedule', trainingSessionId: 'trainingSessions', sessionId: 'trainingSessions', setId: 'trainingSessionSets', fixtureId: 'fixtures', competitionId: 'competitions', testId: 'tests', inviteId: 'athleteAccountInvites', coachId: 'coaches', tenantId: 'tenant (club)', laneId: 'lanes' };
const relationships = [];
for (const [field, target] of Object.entries(REF_TARGET)) {
  const files = backendFiles.filter((f) => new RegExp(`\\b${field}\\b`).test(read(f))).map((f) => rel(f));
  if (files.length) relationships.push({ field, references: target, kind: 'field reference (inferred, not database-enforced)', files });
}
relationships.push({ field: 'swimmerAccountUsername', references: 'auth-users.json username', kind: 'enforced in code (unique link, checked on invitation acceptance and every athlete request)', files: ['athlete-account-invites.mjs', 'index.js'] });
relationships.push({ field: 'tenantId', references: 'club storage folder tenants/<club>', kind: 'enforced in code (every request is scoped to the signed-in account\'s club)', files: ['index.js'] });

// ---- external integrations (environment variable NAMES only, never values) ----
const envNames = [...new Set([...allSrc.matchAll(/process\.env\.([A-Z0-9_]+)/g)].map((m) => m[1]))].sort();
const group = (re) => envNames.filter((n) => re.test(n));
const integrations = [
  { name: 'Stripe (payments, subscriptions, CPD purchases)', env: group(/STRIPE/) },
  { name: 'Email (SMTP / Brevo transactional)', env: group(/SMTP|BREVO|INVITE_FROM|EMAIL/) },
  { name: 'Wearables (Terra)', env: group(/TERRA/) },
  { name: 'Storage and backups (Render disk)', env: group(/STORAGE|BACKUP|SNAPSHOT/) },
  { name: 'Authentication', env: group(/^AUTH_/).filter((n) => !/SMTP/.test(n)) },
].map((i) => ({ ...i, env: i.env.slice(0, 40) }));

// ---- website / app callers ----
const callers = [];
if (websiteDir && fs.existsSync(websiteDir)) {
  const APPS = [
    ['src/', 'Coaching Software'], ['public/athlete-app/', 'Athlete App'], ['public/coach-app/', 'Coach Pool Console / Assistant'], ['public/stopwatch/', 'Stopwatch'],
    ['public/video', 'Video Analysis'], ['public/education', 'Education'], ['public/cpd', 'Education (CPD)'], ['public/athlete-invite.html', 'Athlete App invitations (public page)'], ['public/', 'Public website'],
  ];
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.name === 'node_modules' || e.name.startsWith('.') ? [] : e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
  const files = ['src', 'public'].flatMap((d) => (fs.existsSync(path.join(websiteDir, d)) ? walk(path.join(websiteDir, d)) : [])).filter((f) => /\.(jsx?|mjs|html)$/.test(f) && !/seed-data|db\.json/.test(f));
  const prefixes = [...new Set(routes.map((r) => r.path.split('/').filter(Boolean)[0]).filter(Boolean))];
  const re = new RegExp(`['"\`](?:\\$\\{[^}]+\\})?(?:/api)?(/(?:${prefixes.map((p) => p.replace(/[-]/g, '\\-')).join('|')})(?:/[A-Za-z0-9_\\-:.${'{'}}$]*)*)`, 'g');
  for (const f of files) {
    const r = rel(f, websiteDir);
    const app = (APPS.find(([p]) => r.startsWith(p)) || [, 'Other'])[1];
    const src = read(f);
    const paths = new Set([...src.matchAll(re)].map((m) => m[1].replace(/\$\{[^}]+\}/g, ':param')));
    for (const p of paths) callers.push({ app, file: r, path: p });
  }
}
// Which app files read or write each collection (frontends edit club data and save it through /db).
if (websiteDir && fs.existsSync(websiteDir)) {
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.name === 'node_modules' || e.name.startsWith('.') ? [] : e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
  const wfiles = ['src', 'public'].flatMap((d) => (fs.existsSync(path.join(websiteDir, d)) ? walk(path.join(websiteDir, d)) : [])).filter((f) => /\.(jsx?|mjs|html)$/.test(f) && !/seed-data|db\.json|\.test\./.test(f));
  const texts = wfiles.map((f) => [rel(f, websiteDir), read(f)]);
  for (const c of collectionList) {
    const re = new RegExp(`(?:\\.|\\[['"])${c.name}\\b`);
    c.websiteFiles = texts.filter(([, t]) => re.test(t)).map(([r]) => r).slice(0, 25);
  }
}
const appsByRoute = new Map();
const norm = (p) => p.replace(/:[A-Za-z]+/g, ':param').replace(/\/+$/, '');
for (const c of callers) {
  const r = routes.find((x) => norm(x.path) === norm(c.path)) || routes.find((x) => norm(c.path).startsWith(norm(x.path)) && x.path.length > 3);
  if (!r) continue;
  const key = `${r.method} ${r.path}`;
  if (!appsByRoute.has(key)) appsByRoute.set(key, new Set());
  appsByRoute.get(key).add(c.app);
}
for (const r of routes) r.calledBy = [...(appsByRoute.get(`${r.method} ${r.path}`) || [])].sort();

const data = {
  generatedFrom: { backend: 'athlyrax-backend (index.js and *.mjs modules)', website: websiteDir ? 'athlyrax-v6-private (src, public)' : 'not scanned' },
  note: 'Generated from code by scripts/generate-owner-system-map.mjs. Storage is JSON per club; relationships marked "inferred" are naming conventions, not database constraints.',
  storage: [
    { name: 'tenants/<club>/db.json', description: 'All club records (swimmers, squads, sessions, sets, results, tests, competitions, invitations ...). Written through serialised atomic writes with snapshots.' },
    { name: 'auth-users.json', description: 'Login accounts: role, club (tenantId), password hash, billing state, athlete club connections. Never sent to browsers.' },
    { name: 'CPD store (Education)', description: 'Course purchases, entitlements, progress, completions and certificates (cpd-module02.mjs).' },
    { name: 'Athlete personal store', description: 'Athlete-owned records (plans, days, tests, fixtures, diary, goals, profile, legacy) in the athlete\'s own space (athlete-personal-training.mjs).' },
  ],
  collections: collectionList,
  relationships,
  routes: routes.sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method)),
  integrations,
  roles: ['software-owner (primary owner)', 'head-coach', 'coach', 'assistant-coach', 'viewer', 'swimmer (athlete)'],
};
const json = `${JSON.stringify(data, null, 1)}\n`;
if (check) {
  const old = fs.existsSync(OUT) ? JSON.parse(read(OUT)) : null;
  const strip = (d) => JSON.stringify((d?.routes || []).map((r) => [r.method, r.path, r.guards.join(',')]));
  if (!old || strip(old) !== strip(data)) { console.error('owner/system-map.data.json is out of date: run node scripts/generate-owner-system-map.mjs --website <website>'); process.exit(1); }
  console.log('OWNER_SYSTEM_MAP_UP_TO_DATE'); process.exit(0);
}
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, json);
console.log(`routes=${routes.length} collections=${collectionList.length} relationships=${relationships.length} callers=${callers.length}`);
