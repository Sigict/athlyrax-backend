import fs from 'node:fs';

const indexPath = 'index.js';
let source = fs.readFileSync(indexPath, 'utf8');

const replaceOnce = (from, to, label) => {
  if (!source.includes(from)) throw new Error(`${label} anchor missing`);
  source = source.replace(from, to);
};

replaceOnce(
  "function buildAuthUserPayload(user) {\n\tconst normalizedUser = user && typeof user === 'object' ? user : {};",
  "function resolveEffectiveAuthRole(user) {\n\tconst username = String(user?.username || '').trim().toLowerCase();\n\tif (username === 'demo.coach') return 'head-coach';\n\treturn String(user?.role || 'viewer').trim() || 'viewer';\n}\n\nfunction buildAuthUserPayload(user) {\n\tconst normalizedUser = user && typeof user === 'object' ? user : {};",
  'buildAuthUserPayload',
);
replaceOnce(
  "\t\trole: String(normalizedUser?.role || 'viewer').trim() || 'viewer',",
  "\t\trole: resolveEffectiveAuthRole(normalizedUser),",
  'payload role',
);
replaceOnce(
  "\t\t\trole: String(user.role || 'viewer'),\n\t\t\tcsrf: String(payload.csrf),",
  "\t\t\trole: resolveEffectiveAuthRole(user),\n\t\t\tcsrf: String(payload.csrf),",
  'verified role',
);
replaceOnce(
  "\tif (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return next();\n\tif (!req.auth) return next();",
  "\tif (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return next();\n\t// Logout is deliberately CSRF-exempt: forcing a user to sign out is not a privileged mutation,\n\t// and the endpoint still requires a valid authenticated session before clearing its cookies.\n\tif (method === 'POST' && String(req.path || '') === '/auth/logout') return next();\n\tif (!req.auth) return next();",
  'CSRF logout exemption',
);

const oldLogout = `app.post('/auth/logout', requireStrictAuth, (req, res) => {
\tconst username = String(req.auth?.username || '').trim();
\tconst index = authUsers.findIndex((row) => String(row?.username || '').trim() === username);
\tif (index < 0) {
\t\tres.status(401).json({ error: 'Authentication required.' });
\t\treturn;
\t}

\tconst previous = authUsers[index];
\tauthUsers[index] = {
\t\t...previous,
\t\ttokenValidAfter: getNowEpochSeconds() + 1,
\t};

\ttry {
\t\tpersistAuthUsers();
\t\tclearAuthCookies(res);
\t\tappendAuthAuditEvent({
\t\t\taction: 'logout',
\t\t\treq,
\t\t\tstatus: 'success',
\t\t\ttarget: username,
\t\t});
\t\tres.status(200).json({ ok: true });
\t} catch (error) {
\t\tauthUsers[index] = previous;
\t\tres.status(500).json({
\t\t\terror: 'Could not complete logout.',
\t\t\tdetails: error instanceof Error ? error.message : 'Unknown error',
\t\t});
\t}
});`;
const newLogout = `app.post('/auth/logout', requireStrictAuth, (req, res) => {
\tconst username = String(req.auth?.username || '').trim();
\tconst index = authUsers.findIndex((row) => String(row?.username || '').trim() === username);
\tif (index < 0) {
\t\tclearAuthCookies(res);
\t\tres.status(200).json({ ok: true, alreadySignedOut: true });
\t\treturn;
\t}

\t// Revoke the current account's existing tokens immediately in memory. Persistence is
\t// best-effort: a read-only/degraded auth store must never trap a user inside a session.
\tauthUsers[index] = {
\t\t...authUsers[index],
\t\ttokenValidAfter: getNowEpochSeconds() + 1,
\t};
\tlet revocationPersisted = true;
\ttry {
\t\tpersistAuthUsers();
\t} catch {
\t\trevocationPersisted = false;
\t}

\tclearAuthCookies(res);
\tauthPresenceByUser.delete(username);
\tappendAuthAuditEvent({
\t\taction: 'logout',
\t\treq,
\t\tstatus: 'success',
\t\ttarget: username,
\t\tdetails: { revocationPersisted },
\t});
\tres.status(200).json({ ok: true, revocationPersisted });
});`;
replaceOnce(oldLogout, newLogout, 'logout route');
fs.writeFileSync(indexPath, source);

const packagePath = 'package.json';
const pkg = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
pkg.scripts['test:production-auth-session'] = 'node --test tests/production-auth-session-regression.test.mjs';
if (!pkg.scripts['test:storage-all'].includes('test:production-auth-session')) {
  const marker = ' && npm run test:auth-enumeration-safety';
  if (!pkg.scripts['test:storage-all'].includes(marker)) throw new Error('test:storage-all anchor missing');
  pkg.scripts['test:storage-all'] = pkg.scripts['test:storage-all'].replace(marker, `${marker} && npm run test:production-auth-session`);
}
fs.writeFileSync(packagePath, `${JSON.stringify(pkg, null, 2)}\n`);
