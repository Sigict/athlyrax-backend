import fs from 'node:fs';
import path from 'node:path';

const indexPath = path.resolve('index.js');
let source = fs.readFileSync(indexPath, 'utf8').replace(/\r\n/g, '\n');

const marker = '// ATHLYRAX_PRODUCTION_AUTH_TOKEN_RESPONSE_REDACTED';

if (!source.includes(marker)) {
  const registerNeedle = `\t\tres.status(201).json({\n\t\t\tok: true,\n\t\t\ttoken: session.token,\n\t\t\tcsrfToken: session.csrf,`;
  const registerSafe = `\t\tres.status(201).json({\n\t\t\tok: true,\n\t\t\t// ${marker}\n\t\t\t...(IS_PRODUCTION ? {} : { token: session.token }),\n\t\t\tcsrfToken: session.csrf,`;
  if (!source.includes(registerNeedle)) throw new Error('Primary registration token response anchor missing.');
  source = source.replace(registerNeedle, registerSafe);

  const loginNeedle = `\tres.status(200).json({\n\t\ttoken: session.token,\n\t\tcsrfToken: session.csrf,`;
  const loginSafe = `\tres.status(200).json({\n\t\t...(IS_PRODUCTION ? {} : { token: session.token }),\n\t\tcsrfToken: session.csrf,`;
  if (!source.includes(loginNeedle)) throw new Error('Primary login token response anchor missing.');
  source = source.replace(loginNeedle, loginSafe);
}

for (const required of [
  'ATHLYRAX_PRODUCTION_AUTH_TOKEN_RESPONSE_REDACTED',
  '...(IS_PRODUCTION ? {} : { token: session.token })',
  'csrfToken: session.csrf',
  'setAuthCookies(res, { token: session.token, csrfToken: session.csrf });',
]) if (!source.includes(required)) throw new Error(`Production auth token redaction missing: ${required}`);

const rawPrimaryTokenResponse = '\n\t\ttoken: session.token,';
const rawLoginTokenResponse = '\n\t\ttoken: session.token,';
for (const routeStartText of ["app.post('/auth/register'", "app.post('/auth/login'"]) {
  const start = source.indexOf(routeStartText);
  if (start < 0) throw new Error(`Auth route missing: ${routeStartText}`);
  const end = source.indexOf('\napp.', start + routeStartText.length);
  const route = source.slice(start, end >= 0 ? end : source.length);
  if (route.includes(rawPrimaryTokenResponse) || route.includes(rawLoginTokenResponse)) {
    throw new Error(`Unconditional bearer token remains in production auth route: ${routeStartText}`);
  }
}

fs.writeFileSync(indexPath, source, 'utf8');
console.log('PRODUCTION_AUTH_TOKEN_REDACTION_OK');
