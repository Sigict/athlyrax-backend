import fs from 'node:fs';
import path from 'node:path';

const indexPath = path.resolve('index.js');
let source = fs.readFileSync(indexPath, 'utf8').replace(/\r\n/g, '\n');

const marker = '// ATHLYRAX_SNAPSHOT_COOKIE_SESSION_V1';

function routeBounds(routeStartText) {
  const start = source.indexOf(routeStartText);
  if (start < 0) throw new Error(`Snapshot auth route anchor missing: ${routeStartText}`);
  const next = source.indexOf('\napp.', start + routeStartText.length);
  return { start, end: next >= 0 ? next : source.length };
}

if (!source.includes(marker)) {
  const { start, end } = routeBounds("app.post('/snapshot/account/auth'");
  let route = source.slice(start, end);

  const signupOld = `\t\t\tconst session = issueAuthToken({ username, role: 'swimmer' });\n\t\t\tres.status(201).json({\n\t\t\t\tok: true,\n\t\t\t\ttoken: session.token,\n\t\t\t\tuser: buildAuthUserPayload(findAuthUser(username)),\n\t\t\t});`;
  const signupSafe = `\t\t\t// ATHLYRAX_SNAPSHOT_SIGNUP_NO_BEARER_TOKEN\n\t\t\tres.status(201).json({\n\t\t\t\tok: true,\n\t\t\t\tuser: buildAuthUserPayload(findAuthUser(username)),\n\t\t\t});`;
  if (!route.includes(signupOld)) throw new Error('Snapshot signup token response anchor missing.');
  route = route.replace(signupOld, signupSafe);

  const loginOld = `\tconst session = issueAuthToken(user);\n\tres.status(200).json({ token: session.token, user: buildAuthUserPayload(user) });`;
  const loginSafe = `\tconst session = issueAuthToken(user);\n\t// ${marker}\n\tsetAuthCookies(res, { token: session.token, csrfToken: session.csrf });\n\tres.status(200).json({\n\t\tcsrfToken: session.csrf,\n\t\tcsrfHeaderName: AUTH_CSRF_HEADER_NAME,\n\t\tuser: buildAuthUserPayload(user),\n\t});`;
  if (!route.includes(loginOld)) throw new Error('Snapshot login bearer response anchor missing.');
  route = route.replace(loginOld, loginSafe);

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

for (const forbidden of [
  'res.status(200).json({ token: session.token, user: buildAuthUserPayload(user) });',
  '\ttoken: session.token,',
]) if (route.includes(forbidden)) throw new Error(`Snapshot auth still exposes bearer token: ${forbidden}`);

fs.writeFileSync(indexPath, source, 'utf8');
console.log('SNAPSHOT_COOKIE_SESSION_PATCH_OK');
