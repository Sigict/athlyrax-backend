const API_BASE = process.env.ATHLYRAX_API_BASE || 'https://athlyrax-backend.onrender.com';

const CREDENTIALS = {
  owner: {
    username: process.env.ATHLYRAX_OWNER_USER || 'softwareowner',
    password: process.env.ATHLYRAX_OWNER_PASS || '',
  },
  demoCoach: {
    username: process.env.ATHLYRAX_DEMO_USER || 'demo.coach',
    password: process.env.ATHLYRAX_DEMO_PASS || '',
  },
};

async function requestJson(url, init) {
  const res = await fetch(url, init);
  const text = await res.text();
  let body;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText} -> ${url} :: ${JSON.stringify(body)}`);
  return { res, body };
}

function extractSessionCookie(response) {
  const raw = String(response.headers.get('set-cookie') || '');
  const match = raw.match(/(?:^|[,;]\s*)(athlyrax_session=[^;,\s]+)/i);
  if (!match) throw new Error('Login did not return athlyrax_session cookie.');
  return match[1];
}

async function login({ username, password }) {
  if (!username || !password) throw new Error(`Missing smoke-test credentials for ${username || 'account'}.`);
  const { res, body } = await requestJson(`${API_BASE}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password, audience: 'coach' }),
  });
  return { payload: body, cookie: extractSessionCookie(res) };
}

async function fetchDb(cookie) {
  const { body } = await requestJson(`${API_BASE}/db`, {
    method: 'GET',
    headers: { cookie },
  });
  return body;
}

function count(list) {
  return Array.isArray(list) ? list.length : 0;
}

function meaningfulCount(db) {
  return ['swimmers', 'squads', 'trainingSessions', 'tests', 'attendance']
    .reduce((sum, key) => sum + count(db?.[key]), 0);
}

function fail(message) {
  console.error(`FAIL: ${message}`);
  process.exitCode = 1;
}

async function main() {
  console.log(`CHECK:API ${API_BASE}`);
  const owner = await login(CREDENTIALS.owner);
  const demo = await login(CREDENTIALS.demoCoach);

  const ownerTenant = String(owner.payload?.user?.tenantId || '');
  const demoTenant = String(demo.payload?.user?.tenantId || '');
  console.log(`CHECK:TENANTS owner=${ownerTenant} demo=${demoTenant}`);

  if (!ownerTenant || !demoTenant) fail('Missing tenantId in login response.');
  if (ownerTenant === demoTenant) fail('Owner and demo tenants must be different.');
  if (demoTenant !== 'demo-company') fail(`demo.coach must resolve to demo-company, got ${demoTenant || 'empty'}.`);

  const [ownerDb, demoDb] = await Promise.all([fetchDb(owner.cookie), fetchDb(demo.cookie)]);
  const ownerMeaningful = meaningfulCount(ownerDb);
  const demoMeaningful = meaningfulCount(demoDb);
  console.log(`CHECK:DATA owner=${ownerMeaningful} demo=${demoMeaningful}`);

  if (ownerMeaningful < 1) fail('Owner data unexpectedly empty.');
  if (demoMeaningful < 1) fail('Demo tenant unexpectedly empty; canonical demo data is required.');

  if (!process.exitCode) console.log('PASS: canonical tenant routing and non-empty demo data verified');
}

main().catch((error) => {
  console.error(`FAIL: ${error?.message || error}`);
  process.exit(1);
});
