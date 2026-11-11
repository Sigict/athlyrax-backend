import fs from 'node:fs';
import path from 'node:path';

const indexPath = path.resolve('index.js');
let source = fs.readFileSync(indexPath, 'utf8').replace(/\r\n/g, '\n');

const oldCsrfBlock = `function requireCsrf(req, res, next) {
\tconst method = String(req.method || '').toUpperCase();
\tif (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return next();`;

const newCsrfBlock = `function requireCsrf(req, res, next) {
\tconst method = String(req.method || '').toUpperCase();
\tif (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return next();
\tconst requestPath = String(req.path || req.originalUrl || '').split('?')[0];
\t// Logout only destroys the authenticated session. Do not let a stale/missing
\t// CSRF token trap a user inside the application when the session cookie is valid.
\tif (requestPath === '/auth/logout') return next();`;

if (!source.includes(newCsrfBlock)) {
  if (!source.includes(oldCsrfBlock)) {
    throw new Error('requireCsrf block not found; refusing to patch logout behavior.');
  }
  source = source.replace(oldCsrfBlock, newCsrfBlock);
}

// The coach frontend intentionally reads the current CSRF token from /auth/me
// before authenticated write requests (including logout). The standalone backend
// previously omitted these fields, so /auth/me returned 200 but the frontend had
// no token and correctly refused to send /auth/logout.
const meRouteStart = source.indexOf("app.get('/auth/me', (req, res) => {");
if (meRouteStart < 0) {
  throw new Error('/auth/me route not found; refusing to patch CSRF handshake.');
}
const nextRouteStart = source.indexOf('\napp.', meRouteStart + 1);
if (nextRouteStart < 0) {
  throw new Error('Could not find end of /auth/me route.');
}
let meRoute = source.slice(meRouteStart, nextRouteStart);

// /auth/me can already return csrfToken (e.g. athlete activation branch).
// Patch only the missing response fields; don't depend on one exact block
// layout or double-insert tokens. The route remains authenticated-only.
if (!/\bauthRequired:\s*true,\s*authenticated:\s*true,/.test(meRoute)) {
  throw new Error('Authenticated /auth/me response block not found.');
}
const authenticatedAt = meRoute.indexOf('\tauthenticated: true,');
if (authenticatedAt < 0) {
  throw new Error('Authenticated /auth/me response marker not found.');
}
const insertAt = authenticatedAt + '\tauthenticated: true,'.length;
const authenticatedResponse = meRoute.slice(insertAt);
const missingFields = [
  ...(authenticatedResponse.includes('csrfToken:') ? [] : ["\n\t\tcsrfToken: String(req.auth?.csrf || ''),"]),
  ...(authenticatedResponse.includes('csrfHeaderName:') ? [] : ['\n\t\tcsrfHeaderName: AUTH_CSRF_HEADER_NAME,']),
];
if (missingFields.length) {
  meRoute = meRoute.slice(0, insertAt) + missingFields.join('') + meRoute.slice(insertAt);
  source = `${source.slice(0, meRouteStart)}${meRoute}${source.slice(nextRouteStart)}`;
}

for (const token of [
  `const requestPath = String(req.path || req.originalUrl || '').split('?')[0];`,
  `if (requestPath === '/auth/logout') return next();`,
  `app.post('/auth/logout', requireStrictAuth`,
  `app.get('/auth/me', (req, res) => {`,
  `csrfToken:`,
  `csrfHeaderName: AUTH_CSRF_HEADER_NAME`,
]) {
  if (!source.includes(token)) {
    throw new Error(`Logout/CSRF patch verification failed: ${token}`);
  }
}

fs.writeFileSync(indexPath, source, 'utf8');
console.log('LOGOUT_CSRF_PATCH_OK');
