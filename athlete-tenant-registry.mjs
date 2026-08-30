const text = (value) => String(value ?? '').trim();
const asArray = (value) => Array.isArray(value) ? value : [];

function normalizeTenantId(value) {
  return text(value).toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
}

export function normalizeAthleteTenantConnection(row = {}) {
  const tenantId = normalizeTenantId(row.tenantId || row.targetTenantId || row.clubTenantId);
  if (!tenantId || tenantId === 'global-owner') return null;
  return {
    tenantId,
    connectionId: text(row.connectionId || row.id || `tenant:${tenantId}`),
    clubId: text(row.clubId || row.clubCode),
    clubName: text(row.clubName || row.swimClub || row.teamName),
    squadId: text(row.squadId || row.squadCode),
    squadName: text(row.squadName || row.squad),
    status: text(row.status || 'active').toLowerCase() || 'active',
    source: text(row.source || 'coach-link'),
    coachUsername: text(row.coachUsername),
    coachEmail: text(row.coachEmail),
    approvedAt: text(row.approvedAt || row.connectedAt),
    disconnectedAt: text(row.disconnectedAt),
    dataScopes: asArray(row.dataScopes).map(text).filter(Boolean),
  };
}

export function normalizeAthleteTenantRegistry(rows = []) {
  const byTenant = new Map();
  for (const raw of asArray(rows)) {
    const row = normalizeAthleteTenantConnection(raw);
    if (!row) continue;
    const prior = byTenant.get(row.tenantId);
    byTenant.set(row.tenantId, prior ? { ...prior, ...row, dataScopes: row.dataScopes.length ? row.dataScopes : prior.dataScopes } : row);
  }
  return [...byTenant.values()];
}

export function upsertAthleteTenantConnection(rows = [], connection = {}) {
  const next = normalizeAthleteTenantRegistry(rows);
  const normalized = normalizeAthleteTenantConnection(connection);
  if (!normalized) return next;
  const index = next.findIndex((row) => row.tenantId === normalized.tenantId);
  const active = { ...normalized, status: 'active', disconnectedAt: '' };
  if (index < 0) next.push(active);
  else next[index] = { ...next[index], ...active, dataScopes: active.dataScopes.length ? active.dataScopes : next[index].dataScopes };
  return next;
}

export function deactivateAthleteTenantConnection(rows = [], tenantId, disconnectedAt = new Date().toISOString()) {
  const normalizedTenantId = normalizeTenantId(tenantId);
  return normalizeAthleteTenantRegistry(rows).map((row) => row.tenantId === normalizedTenantId
    ? { ...row, status: 'disconnected', disconnectedAt: text(disconnectedAt) }
    : row);
}

export function activeAthleteTenantConnections(authUser = {}, primaryTenantId = '') {
  const registry = normalizeAthleteTenantRegistry(authUser.athleteTenantConnections);
  const primary = normalizeTenantId(primaryTenantId || authUser.tenantId);
  const byTenant = new Map();
  if (primary && primary !== 'global-owner') {
    byTenant.set(primary, normalizeAthleteTenantConnection({ tenantId: primary, status: 'active', source: 'primary-auth-tenant' }));
  }
  for (const row of registry) {
    if (row.status !== 'active' && row.status !== 'approved') continue;
    byTenant.set(row.tenantId, { ...(byTenant.get(row.tenantId) || {}), ...row, status: 'active' });
  }
  return [...byTenant.values()].filter(Boolean);
}

export function mergeAthleteHomeProjections(projections = []) {
  const valid = asArray(projections).filter((row) => row && typeof row === 'object' && row.athlete);
  if (!valid.length) return null;
  const athleteId = text(valid[0]?.athlete?.id);
  if (!athleteId) return null;
  if (valid.some((row) => text(row?.athlete?.id) !== athleteId)) {
    throw new Error('Cross-tenant athlete projection identity mismatch.');
  }

  const byConnection = new Map();
  const bySession = new Map();
  const byDiscipline = new Map();
  for (const projection of valid) {
    for (const connection of asArray(projection.clubConnections)) {
      const key = text(connection.connectionId || connection.id || connection.clubId || connection.clubName);
      if (!key) continue;
      byConnection.set(key, { ...(byConnection.get(key) || {}), ...connection });
    }
    for (const session of asArray(projection.sessions)) {
      const key = text(session.id);
      if (!key) continue;
      if (!bySession.has(key)) {
        bySession.set(key, session);
        continue;
      }
      const previous = bySession.get(key);
      const sets = new Map();
      for (const set of [...asArray(previous.sets), ...asArray(session.sets)]) {
        const setId = text(set?.id);
        if (setId && !sets.has(setId)) sets.set(setId, set);
      }
      bySession.set(key, { ...previous, ...session, sets: [...sets.values()] });
    }
    for (const discipline of asArray(projection.disciplines)) {
      const key = text(discipline.id || discipline.disciplineId || discipline.name).toLowerCase();
      if (key && !byDiscipline.has(key)) byDiscipline.set(key, discipline);
    }
  }

  const first = valid[0];
  const latest = valid[valid.length - 1];
  return {
    athlete: first.athlete,
    clubConnections: [...byConnection.values()],
    sessions: [...bySession.values()],
    disciplines: [...byDiscipline.values()],
    integratedProfile: latest.integratedProfile || first.integratedProfile || null,
    readiness: latest.readiness || first.readiness || null,
    latestCoachFeedback: latest.latestCoachFeedback || first.latestCoachFeedback || null,
    nextTarget: latest.nextTarget || first.nextTarget || null,
  };
}
