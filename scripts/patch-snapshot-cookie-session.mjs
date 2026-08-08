import fs from 'node:fs';
import path from 'node:path';

const indexPath = path.resolve('index.js');
let source = fs.readFileSync(indexPath, 'utf8').replace(/\r\n/g, '\n');

const marker = '// ATHLYRAX_SNAPSHOT_COOKIE_SESSION_V1';
const signupMarker = '// ATHLYRAX_SNAPSHOT_SIGNUP_NO_BEARER_TOKEN';
const loginBearerResponsePattern = /res\.status\(200\)\.json\(\{\s*token:\s*session\.token,\s*user:\s*buildAuthUserPayload\(user\)\s*\}\);/;

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
  const signupSessionLine = `\t\t\tconst session = issueAuthToken({ username, role: 'swimmer' });\n`;
  if (!signupPart.includes(signupSessionLine)) throw new Error('Snapshot signup session issuance anchor missing.');
  signupPart = signupPart.replace(signupSessionLine, `\t\t\t${signupMarker}\n`);

  const signupTokenLine = `\t\t\t\ttoken: session.token,\n`;
  if (!signupPart.includes(signupTokenLine)) throw new Error('Snapshot signup token response anchor missing.');
  signupPart = signupPart.replace(signupTokenLine, '');

  if (!loginPart.includes('const session = issueAuthToken(user);')) {
    throw new Error('Snapshot login session issuance anchor missing.');
  }
  const loginResponseSafe = `// ${marker}\n\tsetAuthCookies(res, { token: session.token, csrfToken: session.csrf });\n\tres.status(200).json({\n\t\tcsrfToken: session.csrf,\n\t\tcsrfHeaderName: AUTH_CSRF_HEADER_NAME,\n\t\tuser: buildAuthUserPayload(user),\n\t});`;
  if (!loginBearerResponsePattern.test(loginPart)) throw new Error('Snapshot login bearer response anchor missing.');
  loginPart = loginPart.replace(loginBearerResponsePattern, loginResponseSafe);

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

if (loginBearerResponsePattern.test(route)) throw new Error('Snapshot auth still exposes bearer token response.');
for (const forbidden of [
  `const session = issueAuthToken({ username, role: 'swimmer' });`,
  '\ttoken: session.token,',
]) if (route.includes(forbidden)) throw new Error(`Snapshot auth still exposes bearer token: ${forbidden}`);

fs.writeFileSync(indexPath, source, 'utf8');
console.log('SNAPSHOT_COOKIE_SESSION_PATCH_OK');
