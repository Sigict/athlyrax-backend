function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function text(value) {
  return String(value ?? '').trim();
}

function mutationTime(row) {
  for (const value of [row?.updatedAt, row?.modifiedAt, row?.savedAt, row?.createdAt]) {
    const parsed = Date.parse(text(value));
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

function normalizedSetField(row, ...keys) {
  for (const key of keys) {
    const value = row?.[key];
    if (value !== undefined && value !== null && String(value).trim() !== '') return value;
  }
  return '';
}

function canonicalSetSemantics(row) {
  return {
    order: Number(normalizedSetField(row, 'order', 'setOrder', 'sequence') || 0) || 0,
    phase: text(normalizedSetField(row, 'phase', 'setPhase')).toLowerCase(),
    rounds: Number(normalizedSetField(row, 'rounds', 'roundCount') || 0) || 0,
    reps: Number(normalizedSetField(row, 'reps', 'repetitions') || 0) || 0,
    distance: Number(normalizedSetField(row, 'distance', 'distancePerRep', 'repDistance') || 0) || 0,
    stroke: text(normalizedSetField(row, 'stroke', 'strokeType')).toLowerCase(),
    description: text(normalizedSetField(row, 'description', 'actualSet', 'setName', 'name')).toLowerCase(),
    rest: text(normalizedSetField(row, 'rest', 'restInterval')).toLowerCase(),
    sendOff: text(normalizedSetField(row, 'sendOff', 'sendoff', 'interval')).toLowerCase(),
    energy: text(normalizedSetField(row, 'energy', 'energySystem', 'zone')).toLowerCase(),
    modality: text(normalizedSetField(row, 'modality', 'mode')).toLowerCase(),
    groupTag: text(normalizedSetField(row, 'groupTag', 'group', 'setGroup')).toLowerCase(),
  };
}

export function isTemplateLibraryTrainingSet(row) {
  const sessionId = text(row?.sessionId || row?.trainingSessionId).toLowerCase();
  const scheduleId = text(row?.scheduleId || row?.trainingScheduleId).toLowerCase();
  return sessionId === 'template-library' || scheduleId === 'template-library';
}

export function trainingSessionSetLogicalSignature(row) {
  return JSON.stringify({
    sessionId: text(row?.sessionId || row?.trainingSessionId),
    scheduleId: text(row?.scheduleId || row?.trainingScheduleId),
    semantic: canonicalSetSemantics(row),
  });
}

export function normalizeTemplateDetailLine(row, index = 0) {
  return {
    order: Math.max(1, Number(row?.order || index + 1) || index + 1),
    phase: text(row?.phase || 'Pre'),
    rounds: Math.max(0, Number(row?.rounds ?? 1) || 0),
    reps: Math.max(0, Number(row?.reps ?? 1) || 0),
    distance: Math.max(0, Number(row?.distance || 0) || 0),
    stroke: text(row?.stroke || 'free'),
    description: text(row?.description),
    rest: text(row?.rest),
    sendOff: text(row?.sendOff),
    energy: text(row?.energy || row?.energySystem || 'EN1'),
    modality: text(row?.modality || 'Swim'),
    groupTag: text(row?.groupTag),
  };
}

function dedupeTemplateDetailLines(rows) {
  const seen = new Set();
  const result = [];
  for (const row of asArray(rows)) {
    const normalized = normalizeTemplateDetailLine(row, result.length);
    const signature = JSON.stringify(normalized);
    if (seen.has(signature)) continue;
    seen.add(signature);
    result.push(normalized);
  }
  return result.sort((a, b) => Number(a?.order || 0) - Number(b?.order || 0));
}

function migrateTemplateLibraryTrainingSets(db, templateRows, nowIso) {
  const next = db && typeof db === 'object' ? { ...db } : {};
  const groups = new Map();
  for (const row of templateRows) {
    const kind = text(row?.templateKind).toLowerCase() === 'test' || row?.isTestSet === true ? 'test' : 'set';
    const fallbackName = text(row?.setName || row?.name || row?.title || 'Migrated Template') || 'Migrated Template';
    const slug = fallbackName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'row';
    const templateId = text(row?.templateId) || `migrated-template-${kind}-${slug}`;
    const key = `${kind}:${templateId}`;
    if (!groups.has(key)) groups.set(key, { kind, templateId, rows: [] });
    groups.get(key).rows.push(row);
  }

  let migratedTemplates = 0;
  for (const { kind, templateId, rows } of groups.values()) {
    const collectionKey = kind === 'test' ? 'templateTests' : 'templateSets';
    const current = [...asArray(next?.[collectionKey])];
    const detailRows = dedupeTemplateDetailLines(rows);
    const first = rows[0] || {};
    const foundIndex = current.findIndex((row) => text(row?.id) === templateId);
    if (foundIndex >= 0) {
      const existing = current[foundIndex] || {};
      const existingRows = asArray(existing?.rows).length > 0 ? existing.rows : detailRows;
      const canonicalRows = dedupeTemplateDetailLines(existingRows);
      current[foundIndex] = {
        ...existing,
        rows: canonicalRows,
        lineCount: canonicalRows.length,
      };
    } else {
      current.push({
        id: templateId,
        name: text(first?.setName || first?.name || first?.title || 'Migrated Template') || 'Migrated Template',
        actualSet: text(first?.actualSet || first?.description || first?.setName),
        order: Math.max(1, Number(first?.order || 1) || 1),
        phase: text(first?.phase || 'Pre'),
        rounds: Math.max(0, Number(first?.rounds ?? 1) || 0),
        reps: Math.max(0, Number(first?.reps ?? 1) || 0),
        distance: Math.max(0, Number(first?.distance || 0) || 0),
        stroke: text(first?.stroke || 'free'),
        description: text(first?.description),
        rest: text(first?.rest),
        sendOff: text(first?.sendOff),
        energy: text(first?.energy || first?.energySystem || 'EN1'),
        modality: text(first?.modality || 'Swim'),
        notes: text(first?.notes),
        setType: kind === 'test' ? 'test' : text(first?.setType || 'normal'),
        isTestSet: kind === 'test' || first?.isTestSet === true,
        rows: detailRows,
        lineCount: detailRows.length,
        createdAt: text(first?.createdAt) || nowIso,
        updatedAt: text(first?.updatedAt || first?.createdAt) || nowIso,
      });
    }
    next[collectionKey] = current;
    migratedTemplates += 1;
  }
  return { db: next, migratedTemplates };
}

function remapSetReferences(db, duplicateIdMap) {
  if (!(duplicateIdMap instanceof Map) || duplicateIdMap.size === 0) return db;
  const remapId = (value) => duplicateIdMap.get(text(value)) || value;
  const remapRow = (row) => {
    if (!row || typeof row !== 'object') return row;
    const next = { ...row };
    for (const key of ['setId', 'linkedSetId', 'trainingSetId', 'parentSetId', 'groupMainSetId']) {
      if (text(next[key])) next[key] = remapId(next[key]);
    }
    if (Array.isArray(next.setIds)) next.setIds = Array.from(new Set(next.setIds.map(remapId).filter(Boolean)));
    return next;
  };

  const next = { ...db };
  for (const key of ['trainingSetBlocks', 'tests', 'testRepResults', 'trainingSessions', 'schedule']) {
    if (Array.isArray(next?.[key])) next[key] = next[key].map(remapRow);
  }
  return next;
}

export function sanitizeTrainingSessionSetState(db, { nowIso = new Date().toISOString() } = {}) {
  const source = db && typeof db === 'object' ? db : {};
  const rawRows = asArray(source?.trainingSessionSets);
  const templateRows = rawRows.filter(isTemplateLibraryTrainingSet);
  const liveRows = rawRows.filter((row) => !isTemplateLibraryTrainingSet(row));

  const newestById = new Map();
  liveRows.forEach((row, index) => {
    const id = text(row?.id);
    const key = id || `__idless__${index}`;
    const candidate = { row, index, time: mutationTime(row) };
    const current = newestById.get(key);
    if (!current || candidate.time > current.time || (candidate.time === current.time && candidate.index > current.index)) {
      newestById.set(key, candidate);
    }
  });
  const idCanonical = [...newestById.values()].sort((a, b) => a.index - b.index).map((entry) => entry.row);
  const duplicatePersistedIdsRemoved = liveRows.length - idCanonical.length;

  const winnerBySignature = new Map();
  idCanonical.forEach((row, index) => {
    const signature = trainingSessionSetLogicalSignature(row);
    const candidate = { row, index, time: mutationTime(row) };
    const current = winnerBySignature.get(signature);
    if (!current || candidate.time > current.time || (candidate.time === current.time && candidate.index > current.index)) {
      winnerBySignature.set(signature, candidate);
    }
  });

  const winners = [...winnerBySignature.values()].sort((a, b) => a.index - b.index);
  const winnerIdBySignature = new Map(winners.map((entry) => [
    trainingSessionSetLogicalSignature(entry.row),
    text(entry.row?.id),
  ]));

  const duplicateIdMap = new Map();
  for (const row of idCanonical) {
    const winnerId = winnerIdBySignature.get(trainingSessionSetLogicalSignature(row)) || '';
    const rowId = text(row?.id);
    if (rowId && winnerId && rowId !== winnerId) duplicateIdMap.set(rowId, winnerId);
  }

  const canonicalRows = winners.map((entry) => entry.row);
  const logicalDuplicatesRemoved = idCanonical.length - canonicalRows.length;
  const migrated = migrateTemplateLibraryTrainingSets({ ...source, trainingSessionSets: canonicalRows }, templateRows, nowIso);
  let next = remapSetReferences(migrated.db, duplicateIdMap);

  const stats = {
    rawCount: rawRows.length,
    canonicalCount: canonicalRows.length,
    templateRowsMigrated: templateRows.length,
    migratedTemplates: migrated.migratedTemplates,
    duplicatePersistedIdsRemoved,
    logicalDuplicatesRemoved,
  };
  const changed = templateRows.length > 0 || duplicatePersistedIdsRemoved > 0 || logicalDuplicatesRemoved > 0;

  if (changed) {
    next = {
      ...next,
      __meta: {
        ...(next?.__meta || {}),
        trainingSessionSetCleanup: {
          ...stats,
          cleanedAt: nowIso,
        },
      },
    };
  }

  return { db: next, changed, stats, duplicateIdMap };
}

function normalizedAttendanceStatus(row) {
  const value = text(row?.status || row?.attendanceStatus || row?.state).toLowerCase();
  if (value) return value;
  if (row?.present === true || row?.attended === true) return 'present';
  if (row?.present === false || row?.attended === false) return 'absent';
  return '';
}

function attendanceLogicalKey(row, index) {
  const swimmerId = text(row?.swimmerId || row?.athleteId);
  const scheduleId = text(row?.scheduleId || row?.trainingScheduleId);
  const sessionId = text(row?.sessionId || row?.trainingSessionId);
  const date = text(row?.date || row?.scheduleDate).slice(0, 10);
  if (swimmerId && (scheduleId || sessionId || date)) {
    return [swimmerId, scheduleId || sessionId || date].join('|');
  }
  const id = text(row?.id);
  return id ? `id:${id}` : `row:${index}`;
}

function attendanceRank(row, index) {
  return {
    row,
    index,
    hasStatus: normalizedAttendanceStatus(row) ? 1 : 0,
    time: mutationTime(row),
  };
}

function compareAttendanceRank(a, b) {
  if (a.time !== b.time) return a.time - b.time;
  if (a.hasStatus !== b.hasStatus) return a.hasStatus - b.hasStatus;
  return a.index - b.index;
}

export function sanitizeAttendanceState(db, { nowIso = new Date().toISOString() } = {}) {
  const source = db && typeof db === 'object' ? db : {};
  const rows = asArray(source?.attendance);

  const winnerById = new Map();
  rows.forEach((row, index) => {
    const id = text(row?.id);
    const key = id || `__idless__${index}`;
    const candidate = attendanceRank(row, index);
    const current = winnerById.get(key);
    if (!current || compareAttendanceRank(current, candidate) < 0) winnerById.set(key, candidate);
  });

  const idCanonical = [...winnerById.values()]
    .sort((a, b) => a.index - b.index)
    .map((entry) => entry.row);
  const duplicatePersistedIdsRemoved = rows.length - idCanonical.length;

  const winnerByLogicalKey = new Map();
  idCanonical.forEach((row, index) => {
    const key = attendanceLogicalKey(row, index);
    const candidate = attendanceRank(row, index);
    const current = winnerByLogicalKey.get(key);
    if (!current || compareAttendanceRank(current, candidate) < 0) winnerByLogicalKey.set(key, candidate);
  });

  const canonicalRows = [...winnerByLogicalKey.values()]
    .sort((a, b) => a.index - b.index)
    .map((entry) => entry.row);
  const logicalDuplicatesRemoved = idCanonical.length - canonicalRows.length;

  const blankRowsRemovedBecauseMarkedRowExists = idCanonical.reduce((count, row, index) => {
    const key = attendanceLogicalKey(row, index);
    const winner = winnerByLogicalKey.get(key)?.row;
    if (!winner || winner === row) return count;
    return !normalizedAttendanceStatus(row) && Boolean(normalizedAttendanceStatus(winner)) ? count + 1 : count;
  }, 0);

  const stats = {
    rawCount: rows.length,
    canonicalCount: canonicalRows.length,
    duplicatePersistedIdsRemoved,
    logicalDuplicatesRemoved,
    blankRowsRemovedBecauseMarkedRowExists,
  };
  const changed = duplicatePersistedIdsRemoved > 0 || logicalDuplicatesRemoved > 0;

  if (!changed) return { db: source, changed: false, stats };

  return {
    db: {
      ...source,
      attendance: canonicalRows,
      __meta: {
        ...(source?.__meta || {}),
        attendanceCleanup: {
          ...stats,
          cleanedAt: nowIso,
        },
      },
    },
    changed: true,
    stats,
  };
}
