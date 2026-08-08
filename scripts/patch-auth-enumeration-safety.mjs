import fs from 'node:fs';
import path from 'node:path';

const indexPath = path.resolve('index.js');
let source = fs.readFileSync(indexPath, 'utf8').replace(/\r\n/g, '\n');

const marker = '// ATHLYRAX_PASSWORD_RESET_ENUMERATION_SAFE';
const productionDefaultsMarker = '// ATHLYRAX_PRODUCTION_DEFAULT_AUTH_USERS_DISABLED';
const legacyResolverRemovedMarker = '// ATHLYRAX_FIRST_MATCH_IDENTIFIER_HELPER_REMOVED';
const resetAttemptMarker = '// ATHLYRAX_PASSWORD_RESET_ACCOUNT_ATTEMPT_LIMIT';

function routeBounds(routeStartText) {
  const start = source.indexOf(routeStartText);
  if (start < 0) throw new Error(`Password-reset route anchor missing: ${routeStartText}`);
  const next = source.indexOf('\napp.', start + routeStartText.length);
  return { start, end: next >= 0 ? next : source.length };
}

function replaceRoute(routeStartText, transform) {
  const { start, end } = routeBounds(routeStartText);
  const before = source.slice(start, end);
  const after = transform(before);
  if (after === before) throw new Error(`Auth identity hardening made no change for route: ${routeStartText}`);
  source = source.slice(0, start) + after + source.slice(end);
}

if (!source.includes(productionDefaultsMarker)) {
  const seedAnchor = `const DEFAULT_AUTH_USERS = [`;
  const safeSeedAnchor = `const DEFAULT_AUTH_USERS = IS_PRODUCTION ? [] : [\n\t${productionDefaultsMarker}`;
  if (!source.includes(seedAnchor)) throw new Error('Default authentication-user seed anchor missing.');
  source = source.replace(seedAnchor, safeSeedAnchor);
}

if (!source.includes(marker)) {
  replaceRoute("app.post('/auth/password-reset/request'", (route) => {
    let next = route;
    const resolver = `\tconst user = findAuthUserByIdentifier(identifier);`;
    if (!next.includes(resolver)) throw new Error('Primary password-reset request resolver anchor missing.');
    next = next.replace(resolver, `\t// ATHLYRAX_AUTH_IDENTIFIER_AMBIGUITY_SAFE\n\tconst { user } = resolveLoginUserByIdentifier(identifier);`);
    const failure = "res.status(500).json({ error: 'Could not issue reset code. Please contact your administrator.' });";
    if (!next.includes(failure)) throw new Error('Primary password-reset request delivery-failure response anchor missing.');
    return next.replace(failure, "// ATHLYRAX_PASSWORD_RESET_REQUEST_GENERIC_FAILURE_RESPONSE\n\t\tres.status(200).json({ ok: true, message: 'If an account exists, a reset code has been issued.' });");
  });

  replaceRoute("app.post('/snapshot/account/password-reset/request'", (route) => {
    let next = route;
    const resolver = `\tconst user = findAuthUserByIdentifier(identifier);`;
    if (!next.includes(resolver)) throw new Error('Snapshot password-reset request resolver anchor missing.');
    next = next.replace(resolver, `\t// ATHLYRAX_SNAPSHOT_AUTH_IDENTIFIER_AMBIGUITY_SAFE\n\tconst { user } = resolveLoginUserByIdentifier(identifier);`);
    const failure = `\t\tres.status(500).json({\n\t\t\terror: 'Could not issue reset code. Please try again.',\n\t\t\tdetails: error instanceof Error ? error.message : 'Unknown error',\n\t\t});`;
    const safeFailure = `\t\t// ATHLYRAX_SNAPSHOT_PASSWORD_RESET_REQUEST_GENERIC_FAILURE_RESPONSE\n\t\tappendAuthAuditEvent({\n\t\t\taction: 'password_reset_delivery_failed',\n\t\t\treq,\n\t\t\tstatus: 'error',\n\t\t\ttarget: String(user?.username || '').trim(),\n\t\t\treason: 'delivery_failed',\n\t\t\tdetails: { message: error instanceof Error ? error.message : 'Unknown delivery error' },\n\t\t});\n\t\tres.status(200).json({ ok: true, message: 'If an account exists, a reset code has been issued.' });`;
    if (!next.includes(failure)) throw new Error('Snapshot password-reset request delivery-failure response anchor missing.');
    return next.replace(failure, safeFailure);
  });

  replaceRoute("app.post('/snapshot/account/auth'", (route) => {
    const resolver = `\tconst user = findAuthUserByIdentifier(identifier);`;
    if (!route.includes(resolver)) throw new Error('Snapshot account login resolver anchor missing.');
    return route.replace(resolver, `\t// ATHLYRAX_SNAPSHOT_LOGIN_IDENTIFIER_AMBIGUITY_SAFE\n\tconst { user } = resolveLoginUserByIdentifier(identifier);`);
  });

  for (const routeStartText of ["app.post('/auth/password-reset/confirm'", "app.post('/snapshot/account/password-reset/confirm'"]) {
    replaceRoute(routeStartText, (route) => {
      let next = route;
      if (routeStartText.includes('/snapshot/account/')) {
        const resolver = `\tconst user = findAuthUserByIdentifier(identifier);`;
        if (!next.includes(resolver)) throw new Error('Snapshot password-reset confirm resolver anchor missing.');
        next = next.replace(resolver, `\t// ATHLYRAX_SNAPSHOT_RESET_CONFIRM_IDENTIFIER_AMBIGUITY_SAFE\n\tconst { user } = resolveLoginUserByIdentifier(identifier);`);
      }
      const unknown = "res.status(404).json({ error: 'User not found.' });";
      if (!next.includes(unknown)) throw new Error(`Password-reset confirm user-enumeration anchor missing: ${routeStartText}`);
      return next.replaceAll(unknown, "// ATHLYRAX_PASSWORD_RESET_CONFIRM_GENERIC_UNKNOWN_ACCOUNT\n\t\tres.status(400).json({ error: 'Reset code is invalid or expired.' });");
    });
  }

  source = `${marker}\n${source}`;
}

if (!source.includes(resetAttemptMarker)) {
  for (const routeStartText of ["app.post('/auth/password-reset/confirm'", "app.post('/snapshot/account/password-reset/confirm'"]) {
    replaceRoute(routeStartText, (route) => {
      const comparison = `\tif (!safeEqualText(hashPasswordResetCode(resetCode), String(resetEntry.codeHash || ''))) {`;
      if (!route.includes(comparison)) throw new Error(`Password-reset constant-time compare anchor missing: ${routeStartText}`);
      const replacement = `\t${resetAttemptMarker}\n\tif (Math.max(0, Number(resetEntry.failedAttempts || 0)) >= 5) {\n\t\tauthPasswordResetByUser.delete(userKey);\n\t\tres.status(400).json({ error: 'Reset code is invalid or expired.' });\n\t\treturn;\n\t}\n\n\tif (!safeEqualText(hashPasswordResetCode(resetCode), String(resetEntry.codeHash || ''))) {\n\t\tresetEntry.failedAttempts = Math.max(0, Number(resetEntry.failedAttempts || 0)) + 1;\n\t\tif (resetEntry.failedAttempts >= 5) authPasswordResetByUser.delete(userKey);`;
      return route.replace(comparison, replacement);
    });
  }
}

if (!source.includes(legacyResolverRemovedMarker)) {
  const legacyStart = source.indexOf('function findAuthUserByIdentifier(identifier) {');
  const legacyEnd = source.indexOf('\nfunction resolveLoginUserByIdentifier(', legacyStart);
  if (legacyStart < 0 || legacyEnd < 0) throw new Error('Legacy first-match identifier helper bounds missing.');
  source = `${source.slice(0, legacyStart)}${legacyResolverRemovedMarker}\n${source.slice(legacyEnd + 1)}`;
}

for (const required of [
  'ATHLYRAX_PASSWORD_RESET_ENUMERATION_SAFE',
  'ATHLYRAX_PASSWORD_RESET_REQUEST_GENERIC_FAILURE_RESPONSE',
  'ATHLYRAX_SNAPSHOT_PASSWORD_RESET_REQUEST_GENERIC_FAILURE_RESPONSE',
  'ATHLYRAX_PASSWORD_RESET_CONFIRM_GENERIC_UNKNOWN_ACCOUNT',
  'ATHLYRAX_AUTH_IDENTIFIER_AMBIGUITY_SAFE',
  'ATHLYRAX_SNAPSHOT_AUTH_IDENTIFIER_AMBIGUITY_SAFE',
  'ATHLYRAX_SNAPSHOT_LOGIN_IDENTIFIER_AMBIGUITY_SAFE',
  'ATHLYRAX_SNAPSHOT_RESET_CONFIRM_IDENTIFIER_AMBIGUITY_SAFE',
  'ATHLYRAX_PRODUCTION_DEFAULT_AUTH_USERS_DISABLED',
  'const DEFAULT_AUTH_USERS = IS_PRODUCTION ? [] : [',
  'ATHLYRAX_FIRST_MATCH_IDENTIFIER_HELPER_REMOVED',
  'ATHLYRAX_PASSWORD_RESET_ACCOUNT_ATTEMPT_LIMIT',
  'resetEntry.failedAttempts >= 5',
]) if (!source.includes(required)) throw new Error(`Auth identity/enumeration hardening missing: ${required}`);

if (!source.includes('ATHLYRAX_ONBOARDING_EMAIL_UNIQUE')) throw new Error('Onboarding email uniqueness must be installed by the earlier runtime-retention transform.');
if (source.includes('ATHLYRAX_ONBOARDING_EMAIL_UNIQUENESS')) throw new Error('Duplicate onboarding email-uniqueness guard remains.');
if (source.includes('function findAuthUserByIdentifier(') || source.includes('findAuthUserByIdentifier(identifier)')) {
  throw new Error('Legacy first-match identifier helper or call remains in transformed backend.');
}

for (const routeStartText of ["app.post('/auth/password-reset/confirm'", "app.post('/snapshot/account/password-reset/confirm'"]) {
  const { start, end } = routeBounds(routeStartText);
  const route = source.slice(start, end);
  if (route.includes("res.status(404).json({ error: 'User not found.' });")) throw new Error(`Password-reset confirm still reveals unknown accounts: ${routeStartText}`);
  if (!route.includes('ATHLYRAX_PASSWORD_RESET_ACCOUNT_ATTEMPT_LIMIT') || !route.includes('resetEntry.failedAttempts >= 5')) {
    throw new Error(`Password-reset account-level attempt limit missing: ${routeStartText}`);
  }
}
for (const routeStartText of ["app.post('/auth/password-reset/request'", "app.post('/snapshot/account/password-reset/request'", "app.post('/snapshot/account/auth'", "app.post('/snapshot/account/password-reset/confirm'"]) {
  const { start, end } = routeBounds(routeStartText);
  const route = source.slice(start, end);
  if (route.includes('findAuthUserByIdentifier(identifier)')) throw new Error(`Auth route still uses first-match identifier resolution: ${routeStartText}`);
}

fs.writeFileSync(indexPath, source, 'utf8');
console.log('AUTH_ENUMERATION_SAFETY_OK');
