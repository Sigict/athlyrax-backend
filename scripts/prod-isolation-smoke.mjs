const API_BASE = process.env.ATHLYRAX_API_BASE || 'https://athlyrax-backend.onrender.com';

const CREDENTIALS = {
  owner: {
    username: process.env.ATHLYRAX_OWNER_USER || 'softwareowner',
    password: process.env.ATHLYRAX_OWNER_PASS || 'softwareowner123',
  },
  demoCoach: {
    username: process.env.ATHLYRAX_DEMO_USER || 'demo.coach',
    password: process.env.ATHLYRAX_DEMO_PASS || 'DemoCoach123',
  },
  demoResearcher: {
    username: process.env.ATHLYRAX_RESEARCH_USER || 'demo.researcher',
    password: process.env.ATHLYRAX_RESEARCH_PASS || 'DemoResearcher123',
  },
};

async function requestJson(url, init) {
  const res = await fetch(url, init);
  const text = await res.text();
  let body;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${res.statusText} -> ${url} :: ${JSON.stringify(body)}`);
  }
  return body;
}

async function login({ username, password }) {
  const payload = { username, password, audience: 'coach' };
  return requestJson(`${API_BASE}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

async function fetchDb(token) {
  return requestJson(`${API_BASE}/db`, {
    method: 'GET',
    headers: { authorization: `Bearer ${token}` },
  });
}

function count(list) {
  return Array.isArray(list) ? list.length : 0;
}

function fail(msg) {
  console.error(`FAIL: ${msg}`);
  process.exitCode = 1;
}

async function main() {
  console.log(`CHECK:API ${API_BASE}`);

  const owner = await login(CREDENTIALS.owner);
  const demo = await login(CREDENTIALS.demoCoach);
  const research = await login(CREDENTIALS.demoResearcher);

  const ownerTenant = owner?.user?.tenantId;
  const demoTenant = demo?.user?.tenantId;
  const researchTenant = research?.user?.tenantId;

  console.log(`CHECK:TENANTS owner=${ownerTenant} demo=${demoTenant} research=${researchTenant}`);

  if (!ownerTenant || !demoTenant || !researchTenant) {
    fail('Missing tenantId in one or more login responses');
  }
  if (ownerTenant === demoTenant) {
    fail('Owner and demo tenants are the same');
  }
  if (demoTenant !== researchTenant) {
    fail('Demo coach and demo researcher are expected to share the same demo tenant');
  }

  const [ownerDb, demoDb, researchDb] = await Promise.all([
    fetchDb(owner.token),
    fetchDb(demo.token),
    fetchDb(research.token),
  ]);

  const ownerCounts = {
    swimmers: count(ownerDb.swimmers),
    squads: count(ownerDb.squads),
    coaches: count(ownerDb.coaches),
  };
  const demoCounts = {
    swimmers: count(demoDb.swimmers),
    squads: count(demoDb.squads),
    coaches: count(demoDb.coaches),
  };
  const researchCounts = {
    swimmers: count(researchDb.swimmers),
    squads: count(researchDb.squads),
    coaches: count(researchDb.coaches),
  };

  console.log(`CHECK:COUNTS owner swimmers=${ownerCounts.swimmers} squads=${ownerCounts.squads} coaches=${ownerCounts.coaches}`);
  console.log(`CHECK:COUNTS demo swimmers=${demoCounts.swimmers} squads=${demoCounts.squads} coaches=${demoCounts.coaches}`);
  console.log(`CHECK:COUNTS research swimmers=${researchCounts.swimmers} squads=${researchCounts.squads} coaches=${researchCounts.coaches}`);

  if (ownerCounts.swimmers === 0 && ownerCounts.squads === 0 && ownerCounts.coaches === 0) {
    fail('Owner data unexpectedly empty');
  }
  if (demoCounts.swimmers !== 0 || demoCounts.squads !== 0 || demoCounts.coaches !== 0) {
    fail('Demo tenant expected empty but contains data');
  }
  if (researchCounts.swimmers !== 0 || researchCounts.squads !== 0 || researchCounts.coaches !== 0) {
    fail('Research tenant view expected empty but contains data');
  }

  if (process.exitCode) {
    return;
  }

  console.log('PASS: tenant isolation, account access, and demo empty policy are valid');
}

main().catch((err) => {
  console.error(`FAIL: ${err.message || err}`);
  process.exit(1);
});