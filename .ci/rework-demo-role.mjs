import fs from 'node:fs';

const path = 'index.js';
let source = fs.readFileSync(path, 'utf8');

const mutatedCanonical = `\tconst canonicalUsername = String(user?.username || '').trim().toLowerCase();
\tconst canonicalTenantId = CANONICAL_TENANT_BY_USERNAME[canonicalUsername];
\tconst canonicalRole = canonicalUsername === 'demo.coach' ? 'head-coach' : '';
\tconst canonicalProfileDrifted = Boolean(canonicalTenantId) && (
\t\tnormalizeTenantId(user?.tenantId) !== canonicalTenantId
\t\t|| (canonicalRole && String(user?.role || '').trim().toLowerCase() !== canonicalRole)
\t);
\tif (canonicalProfileDrifted) {
\t\tconst userIndex = authUsers.findIndex((row) => String(row?.username || '').trim().toLowerCase() === canonicalUsername);
\t\tif (userIndex >= 0) {
\t\t\tauthUsers[userIndex] = {
\t\t\t\t...authUsers[userIndex],
\t\t\t\ttenantId: canonicalTenantId,
\t\t\t\t...(canonicalRole ? { role: canonicalRole } : {}),
\t\t\t};`;

const originalCanonical = `\tconst canonicalTenantId = CANONICAL_TENANT_BY_USERNAME[String(user?.username || '').trim().toLowerCase()];
\tif (canonicalTenantId && normalizeTenantId(user?.tenantId) !== canonicalTenantId) {
\t\tconst userIndex = authUsers.findIndex((row) => String(row?.username || '').trim().toLowerCase() === String(user?.username || '').trim().toLowerCase());
\t\tif (userIndex >= 0) {
\t\t\tauthUsers[userIndex] = {
\t\t\t\t...authUsers[userIndex],
\t\t\t\ttenantId: canonicalTenantId,
\t\t\t};`;

if (!source.includes(mutatedCanonical)) throw new Error('mutated canonical block not found');
source = source.replace(mutatedCanonical, originalCanonical);

const oldSession = `\tconst session = issueAuthToken(user);
\tsetAuthCookies(res, { token: session.token, csrfToken: session.csrf });
\tappendAuthAuditEvent({
\t\taction: 'login_success',
\t\treq,
\t\tstatus: 'success',
\t\tactor: user.username,
\t\tactorRole: String(user?.role || 'unknown'),
\t\ttarget: user.username,
\t\tdetails: {
\t\t\trole: user.role,
\t\t\tswimClub: String(user?.swimClub || '').trim(),
\t\t\tteamName: String(user?.teamName || '').trim(),
\t\t\temail: String(user?.email || '').trim(),
\t\t},
\t});
\tres.status(200).json({
\t\ttoken: session.token,
\t\tcsrfToken: session.csrf,
\t\tcsrfHeaderName: AUTH_CSRF_HEADER_NAME,
\t\tuser: buildAuthUserPayload(user),
\t});`;

const newSession = `\tconst canonicalLoginUsername = String(user?.username || '').trim().toLowerCase();
\tconst effectiveLoginUser = canonicalLoginUsername === 'demo.coach'
\t\t? { ...user, role: 'head-coach' }
\t\t: user;
\tconst session = issueAuthToken(effectiveLoginUser);
\tsetAuthCookies(res, { token: session.token, csrfToken: session.csrf });
\tappendAuthAuditEvent({
\t\taction: 'login_success',
\t\treq,
\t\tstatus: 'success',
\t\tactor: effectiveLoginUser.username,
\t\tactorRole: String(effectiveLoginUser?.role || 'unknown'),
\t\ttarget: effectiveLoginUser.username,
\t\tdetails: {
\t\t\trole: effectiveLoginUser.role,
\t\t\tswimClub: String(effectiveLoginUser?.swimClub || '').trim(),
\t\t\tteamName: String(effectiveLoginUser?.teamName || '').trim(),
\t\t\temail: String(effectiveLoginUser?.email || '').trim(),
\t\t},
\t});
\tres.status(200).json({
\t\ttoken: session.token,
\t\tcsrfToken: session.csrf,
\t\tcsrfHeaderName: AUTH_CSRF_HEADER_NAME,
\t\tuser: buildAuthUserPayload(effectiveLoginUser),
\t});`;

if (!source.includes(oldSession)) throw new Error('login session block not found');
source = source.replace(oldSession, newSession);
fs.writeFileSync(path, source);

fs.writeFileSync('tests/demo-coach-canonical-role.test.mjs', `import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync('index.js', 'utf8');

test('demo.coach receives canonical head-coach authority without mutating its stored auth row', () => {
  assert.match(source, /const canonicalLoginUsername = String\\(user\\?\\.username \\|\\| ''\\)\\.trim\\(\\)\\.toLowerCase\\(\\);/);
  assert.match(source, /canonicalLoginUsername === 'demo\\.coach'[\\s\\S]{0,80}role: 'head-coach'/);
  assert.match(source, /const session = issueAuthToken\\(effectiveLoginUser\\);/);
  assert.match(source, /user: buildAuthUserPayload\\(effectiveLoginUser\\)/);
  const start = source.indexOf("const canonicalLoginUsername = String(user?.username || '').trim().toLowerCase();");
  const end = source.indexOf("app.post('/auth/password-reset/request'", start);
  assert.doesNotMatch(source.slice(start, end), /persistAuthUsers\\(\\)/);
});
`);
