import fs from 'node:fs';
import path from 'node:path';

const indexPath = path.resolve('index.js');
let source = fs.readFileSync(indexPath, 'utf8').replace(/\r\n/g, '\n');

const marker = '// ATHLYRAX_SNAPSHOT_COOKIE_SESSION_V1';
const signupMarker = '// ATHLYRAX_SNAPSHOT_SIGNUP_NO_BEARER_TOKEN';

function routeBounds(routeStartText) {
  const start = source.indexOf(routeStartText);
  if (start < 0) throw new Error(`Snapshot auth route anchor missing: ${routeStartText}`);
  const next = source.indexOf('\napp.', start + routeStartText.length);
  return { start, end: next >= 0 ? next : source.length };
}

if (!source.includes(marker)) {
  const { start, end } = routeBounds("app.post('/snapshot/account/auth'");
  let route = source.slice(start, end);

  const loginBoundaryCandidates = [
    route.indexOf('ATHLYRAX_SNAPSHOT_LOGIN_IDENTIFIER_AMBIGUITY_SAFE'),
    route.indexOf('const { user } = resolveLoginUserByIdentifier(identifier);'),
    route.indexOf('const user = findAuthUserByIdentifier(identifier);'),
  ].filter((value) => value >= 0);
  const loginBoundary = loginBoundaryCandidates.length ? Math.min(...loginBoundaryCandidates) : -1;
  if (loginBoundary < 0) throw new Error('Snapshot login boundary was not found.');

  let signupPart = route.slice(0, loginBoundary);
  let loginPart = route.slice(loginBoundary);

  // Signup already receives the secure cookie + CSRF session from an earlier production transform.
  // Remove only the JavaScript-readable bearer token from its JSON response.
  const signupTokenLine = `\t\t\t\ttoken: session.token,\n`;
  if (!signupPart.includes(signupTokenLine)) throw new Error('Snapshot signup token response anchor missing.');
  signupPart = signupPart.replace(signupTokenLine, `\t\t\t\t${signupMarker}\n`);

  // Login also already has setAuthCookies installed. Preserve it and redact only the token field.
  if (!loginPart.includes('setAuthCookies(res, { token: session.token, csrfToken: session.csrf });')) {
    throw new Error('Snapshot login cookie-session anchor missing.');
  }
  const loginTokenFieldPattern = /(\tres\.status\(200\)\.json\(\{\s*)token:\s*session\.token,\s*/;
  if (!loginTokenFieldPattern.test(loginPart)) throw new Error('Snapshot login bearer token field anchor missing.');
  loginPart = loginPart.replace(loginTokenFieldPattern, `\t${marker}\n$1`);

  route = signupPart + loginPart;
  source = `${source.slice(0, start)}${route}${source.slice(end)}`;
}

const { start, end } = routeBounds("app.post('/snapshot/account/auth'");
const route = source.slice(start, end);
for (const required of [
  'ATHLYRAX_SNAPSHOT_COOKIE_SESSION_V1',
  'ATHLYRAX_SNAPSHOT_SIGNUP_NO_BEARER_TOKEN',
  'setAuthCookies(res, { token: session.token, csrfToken: session.csrf });',
  'csrfToken: session.csrf',
  'csrfHeaderName: AUTH_CSRF_HEADER_NAME',
]) if (!route.includes(required)) throw new Error(`Snapshot cookie-session hardening missing: ${required}`);

if (/res\.status\((?:200|201)\)\.json\(\{[^}]*token:\s*session\.token/s.test(route)) {
  throw new Error('Snapshot auth response still exposes a bearer session token.');
}

fs.writeFileSync(indexPath, source, 'utf8');
console.log('SNAPSHOT_COOKIE_SESSION_PATCH_OK');
