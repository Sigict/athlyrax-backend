import fs from 'node:fs';
import path from 'node:path';

const indexPath = path.resolve('index.js');
let source = fs.readFileSync(indexPath, 'utf8').replace(/\r\n/g, '\n');

const marker = '// ATHLYRAX_LAYERED_AUTH_RATE_LIMIT';
if (!source.includes(marker)) {
  const constantAnchor = `const AUTH_LOGIN_RATE_MAX_ATTEMPTS = Math.max(1, Number.parseInt(process.env.AUTH_LOGIN_RATE_MAX_ATTEMPTS || '8', 10) || 8);`;
  const constantReplacement = `${constantAnchor}\nconst AUTH_LOGIN_RATE_IP_MAX_ATTEMPTS = Math.max(AUTH_LOGIN_RATE_MAX_ATTEMPTS, Number.parseInt(process.env.AUTH_LOGIN_RATE_IP_MAX_ATTEMPTS || '40', 10) || 40);`;
  if (!source.includes(constantAnchor)) throw new Error('Login rate-limit constant anchor was not found.');
  source = source.replace(constantAnchor, constantReplacement);

  const oldFunction = `function requireLoginRateLimit(req, res, next) {\n\tconst clientKey = resolveClientKey(req);\n\tconst username = String(req.body?.username || '').trim().toLowerCase();\n\tconst key = username ? \`${'${clientKey}'}:${'${username}'}\` : clientKey;\n\tconst result = checkRateLimit({\n\t\tstore: loginRateBuckets,\n\t\tkey,\n\t\twindowMs: AUTH_LOGIN_RATE_WINDOW_MS,\n\t\tmaxAttempts: AUTH_LOGIN_RATE_MAX_ATTEMPTS,\n\t});\n\tapplyRateLimitHeaders(res, {\n\t\tmaxAttempts: AUTH_LOGIN_RATE_MAX_ATTEMPTS,\n\t\tremaining: result.remaining,\n\t\tresetSeconds: result.resetSeconds,\n\t});\n\tif (!result.allowed) {\n\t\tappendAuthAuditEvent({\n\t\t\taction: 'rate_limit_blocked',\n\t\t\treq,\n\t\t\tstatus: 'blocked',\n\t\t\treason: 'login_rate_limit',\n\t\t\tdetails: { limit: AUTH_LOGIN_RATE_MAX_ATTEMPTS, windowMs: AUTH_LOGIN_RATE_WINDOW_MS },\n\t\t});\n\t\tres.setHeader('Retry-After', String(result.resetSeconds));\n\t\tres.status(429).json({ error: 'Too many login attempts. Please wait and retry.' });\n\t\treturn;\n\t}\n\tnext();\n}`;

  const safeFunction = `function requireLoginRateLimit(req, res, next) {\n\t${marker}\n\tconst clientKey = resolveClientKey(req);\n\tconst identifier = String(req.body?.username || req.body?.identifier || req.body?.email || '').trim().toLowerCase();\n\tconst ipResult = checkRateLimit({\n\t\tstore: loginRateBuckets,\n\t\tkey: \`ip:${'${clientKey}'}\`,\n\t\twindowMs: AUTH_LOGIN_RATE_WINDOW_MS,\n\t\tmaxAttempts: AUTH_LOGIN_RATE_IP_MAX_ATTEMPTS,\n\t});\n\tconst identityResult = identifier ? checkRateLimit({\n\t\tstore: loginRateBuckets,\n\t\tkey: \`identity:${'${clientKey}'}:${'${identifier}'}\`,\n\t\twindowMs: AUTH_LOGIN_RATE_WINDOW_MS,\n\t\tmaxAttempts: AUTH_LOGIN_RATE_MAX_ATTEMPTS,\n\t}) : null;\n\tconst blockedByIp = !ipResult.allowed;\n\tconst blockedByIdentity = Boolean(identityResult && !identityResult.allowed);\n\tconst effective = identityResult || ipResult;\n\tapplyRateLimitHeaders(res, {\n\t\tmaxAttempts: identityResult ? AUTH_LOGIN_RATE_MAX_ATTEMPTS : AUTH_LOGIN_RATE_IP_MAX_ATTEMPTS,\n\t\tremaining: Math.min(ipResult.remaining, identityResult ? identityResult.remaining : ipResult.remaining),\n\t\tresetSeconds: Math.max(ipResult.resetSeconds, identityResult ? identityResult.resetSeconds : 0),\n\t});\n\tif (blockedByIp || blockedByIdentity) {\n\t\tappendAuthAuditEvent({\n\t\t\taction: 'rate_limit_blocked',\n\t\t\treq,\n\t\t\tstatus: 'blocked',\n\t\t\treason: blockedByIp ? 'login_ip_rate_limit' : 'login_identity_rate_limit',\n\t\t\tdetails: {\n\t\t\t\tipLimit: AUTH_LOGIN_RATE_IP_MAX_ATTEMPTS,\n\t\t\t\tidentityLimit: AUTH_LOGIN_RATE_MAX_ATTEMPTS,\n\t\t\t\twindowMs: AUTH_LOGIN_RATE_WINDOW_MS,\n\t\t\t},\n\t\t});\n\t\tres.setHeader('Retry-After', String(Math.max(ipResult.resetSeconds, identityResult ? identityResult.resetSeconds : 0)));\n\t\tres.status(429).json({ error: 'Too many authentication requests. Please wait and retry.' });\n\t\treturn;\n\t}\n\tvoid effective;\n\tnext();\n}`;
  if (!source.includes(oldFunction)) throw new Error('Login rate-limit function anchor was not found.');
  source = source.replace(oldFunction, safeFunction);
}

for (const token of [
  'ATHLYRAX_LAYERED_AUTH_RATE_LIMIT',
  'AUTH_LOGIN_RATE_IP_MAX_ATTEMPTS',
  "req.body?.username || req.body?.identifier || req.body?.email",
  '`ip:${clientKey}`',
  '`identity:${clientKey}:${identifier}`',
  "'login_ip_rate_limit'",
  "'login_identity_rate_limit'",
]) if (!source.includes(token)) throw new Error(`Layered auth rate limiting missing: ${token}`);

fs.writeFileSync(indexPath, source, 'utf8');
console.log('RATE_LIMIT_INTEGRITY_OK');
