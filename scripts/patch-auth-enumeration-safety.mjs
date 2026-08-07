import fs from 'node:fs';
import path from 'node:path';

const indexPath = path.resolve('index.js');
let source = fs.readFileSync(indexPath, 'utf8').replace(/\r\n/g, '\n');

const marker = '// ATHLYRAX_PASSWORD_RESET_ENUMERATION_SAFE';

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
  if (after === before) throw new Error(`Password-reset hardening made no change for route: ${routeStartText}`);
  source = source.slice(0, start) + after + source.slice(end);
}

if (!source.includes(marker)) {
  replaceRoute("app.post('/auth/password-reset/request'", (route) => {
    const failure = "res.status(500).json({ error: 'Could not issue reset code. Please contact your administrator.' });";
    if (!route.includes(failure)) throw new Error('Primary password-reset request delivery-failure response anchor missing.');
    return route.replace(
      failure,
      "// ATHLYRAX_PASSWORD_RESET_REQUEST_GENERIC_FAILURE_RESPONSE\n\t\tres.status(200).json({ ok: true, message: 'If an account exists, a reset code has been issued.' });",
    );
  });

  replaceRoute("app.post('/snapshot/account/password-reset/request'", (route) => {
    const failure = `\t\tres.status(500).json({\n\t\t\terror: 'Could not issue reset code. Please try again.',\n\t\t\tdetails: error instanceof Error ? error.message : 'Unknown error',\n\t\t});`;
    const safeFailure = `\t\t// ATHLYRAX_SNAPSHOT_PASSWORD_RESET_REQUEST_GENERIC_FAILURE_RESPONSE\n\t\tappendAuthAuditEvent({\n\t\t\taction: 'password_reset_delivery_failed',\n\t\t\treq,\n\t\t\tstatus: 'error',\n\t\t\ttarget: String(user?.username || '').trim(),\n\t\t\treason: 'delivery_failed',\n\t\t\tdetails: { message: error instanceof Error ? error.message : 'Unknown delivery error' },\n\t\t});\n\t\tres.status(200).json({ ok: true, message: 'If an account exists, a reset code has been issued.' });`;
    if (!route.includes(failure)) throw new Error('Snapshot password-reset request delivery-failure response anchor missing.');
    return route.replace(failure, safeFailure);
  });

  for (const routeStartText of [
    "app.post('/auth/password-reset/confirm'",
    "app.post('/snapshot/account/password-reset/confirm'",
  ]) {
    replaceRoute(routeStartText, (route) => {
      const unknown = "res.status(404).json({ error: 'User not found.' });";
      const count = route.split(unknown).length - 1;
      if (count < 1) throw new Error(`Password-reset confirm user-enumeration anchor missing: ${routeStartText}`);
      return route.replaceAll(
        unknown,
        "// ATHLYRAX_PASSWORD_RESET_CONFIRM_GENERIC_UNKNOWN_ACCOUNT\n\t\tres.status(400).json({ error: 'Reset code is invalid or expired.' });",
      );
    });
  }

  source = `${marker}\n${source}`;
}

for (const required of [
  'ATHLYRAX_PASSWORD_RESET_ENUMERATION_SAFE',
  'ATHLYRAX_PASSWORD_RESET_REQUEST_GENERIC_FAILURE_RESPONSE',
  'ATHLYRAX_SNAPSHOT_PASSWORD_RESET_REQUEST_GENERIC_FAILURE_RESPONSE',
  'ATHLYRAX_PASSWORD_RESET_CONFIRM_GENERIC_UNKNOWN_ACCOUNT',
]) if (!source.includes(required)) throw new Error(`Password-reset enumeration hardening missing: ${required}`);

for (const routeStartText of [
  "app.post('/auth/password-reset/confirm'",
  "app.post('/snapshot/account/password-reset/confirm'",
]) {
  const { start, end } = routeBounds(routeStartText);
  const route = source.slice(start, end);
  if (route.includes("res.status(404).json({ error: 'User not found.' });")) {
    throw new Error(`Password-reset confirm still reveals unknown accounts: ${routeStartText}`);
  }
}

for (const routeStartText of [
  "app.post('/auth/password-reset/request'",
  "app.post('/snapshot/account/password-reset/request'",
]) {
  const { start, end } = routeBounds(routeStartText);
  const route = source.slice(start, end);
  if (route.includes('Could not issue reset code. Please contact your administrator.') || route.includes('Could not issue reset code. Please try again.')) {
    throw new Error(`Password-reset request still exposes delivery outcome: ${routeStartText}`);
  }
}

fs.writeFileSync(indexPath, source, 'utf8');
console.log('AUTH_ENUMERATION_SAFETY_OK');
