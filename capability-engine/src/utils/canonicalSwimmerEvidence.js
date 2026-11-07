import { summarizeRecordedReps } from './recordedSetAverages.js';
import { buildSwimmerScheduleDeliveryRatios } from './swimmerTrainingDeliveryRatios.js';

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function toNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function normalizeText(value) {
  return String(value || '').trim();
}

function normalizeDateKey(value) {
  const text = normalizeText(value);
  if (!text) return '';
  const isoMatch = text.match(/^(\d{4}-\d{2}-\d{2})/);
  if (isoMatch) return isoMatch[1];
  const shortDateMatch = text.match(/^(\d{2})-(\d{2})-(\d{2})$/);
  if (shortDateMatch) return `20${shortDateMatch[3]}-${shortDateMatch[2]}-${shortDateMatch[1]}`;
  const longDateMatch = text.match(/^(\d{2})-(\d{2})-(\d{4})$/);
  if (longDateMatch) return `${longDateMatch[3]}-${longDateMatch[2]}-${longDateMatch[1]}`;
  const parsed = new Date(text);
  if (Number.isNaN(parsed.getTime())) return '';
  const year = parsed.getFullYear();
  const month = String(parsed.getMonth() + 1).padStart(2, '0');
  const day = String(parsed.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function isRecordedMeasurement(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return false;
  const token = normalizeText(value);
  if (!token) return false;
  // Form state and placeholders must never qualify as measured test/race evidence.
  return !/^(pending|planned|scheduled|not entered|not recorded|n\/a|na|tbd|none|--?|—)$/i.test(token);
}

function hasAnyTimeOrResultFields(row) {
  if (!row || typeof row !== 'object') return false;
  const valueFields = [
    'resultValue',
    'value',
    'result',
    'score',
    'time',
    'resultTime',
    'officialTime',
    'totalTime',
    'finalTime',
    'bestTime',
    'actualTime',
  ];
  for (const key of valueFields) {
    const value = row?.[key];
    if (isRecordedMeasurement(value)) return true;
  }
  if (row?.resultValues && typeof row.resultValues === 'object' && Object.values(row.resultValues).some(isRecordedMeasurement)) return true;
  // A placing or PB flag without a measured performance is not a result.
  // Competition forms store length splits directly on the swimmer's result.
  // Those are real measured records even when no overallTime was supplied.
  if (asArray(row?.splits).some((split) => isRecordedMeasurement(split?.time) || isRecordedMeasurement(split?.segmentTime) || isRecordedMeasurement(split?.lengthTime) || isRecordedMeasurement(split?.strokeCount))) return true;

  if (isRecordedMeasurement(row?.strokeCount) || isRecordedMeasurement(row?.overallStrokeCount)) return true;

  const repRows = asArray(row?.repResults);
  for (const rep of repRows) {
    if (normalizeText(rep?.overallTime) || normalizeText(rep?.overallStrokeCount)) return true;
    for (const split of asArray(rep?.splits)) {
      if (normalizeText(split?.time) || normalizeText(split?.strokeCount)) return true;
    }
  }

  const testRepRows = asArray(row?.testRepResults);
  for (const rep of testRepRows) {
    if (normalizeText(rep?.overallTime) || normalizeText(rep?.overallStrokeCount)) return true;
    for (const split of asArray(rep?.splits)) {
      if (normalizeText(split?.time) || normalizeText(split?.strokeCount)) return true;
    }
  }

  return false;
}

function hasCompletedTestMeasurement(row) {
  if (!hasAnyTimeOrResultFields(row)) return false;
  const reps = [...asArray(row?.repResults), ...asArray(row?.testRepResults)];
  if (!reps.length) return true;
  // Explicit official totals and measured summary fields remain authoritative.
  const scalarFields = [
    row?.resultValue, row?.resultTime, row?.officialTime, row?.totalTime,
    row?.finalTime, row?.bestTime, row?.actualTime, row?.time, row?.result,
  ];
  if (scalarFields.some(isRecordedMeasurement)) return true;
  if (row?.resultValues && Object.values(row.resultValues).some(isRecordedMeasurement)) return true;
  if (reps.some((rep) => isRecordedMeasurement(rep?.overallTime)
    || isRecordedMeasurement(rep?.recordedOverallTime)
    || isRecordedMeasurement(rep?.overallStrokeCount))) return true;
  const match = normalizeText(row?.testName || row?.test || row?.testType || '')
    .match(/\b(?:[0-9]+\s*[xX]\s*)?([0-9]{2,4})\s*m?\b/);
  const expectedDistance = toNumber(row?.distance, 0) || toNumber(match?.[1], 0);
  if (!(expectedDistance > 0)) return true; // preserve unspecified legacy test protocols
  return reps.some((rep) => {
    const splits = asArray(rep?.splits);
    const distance = Math.max(0, ...splits.map((split) =>
      toNumber(split?.distance, 0)));
    return distance === expectedDistance && splits.some((split) =>
      isRecordedMeasurement(split?.time) || isRecordedMeasurement(split?.strokeCount));
  });
}

function resolveResultValue(row) {
  if (!row || typeof row !== 'object') return '';
  const scalarCandidates = [
    row?.resultValue,
    row?.resultTime,
    row?.officialTime,
    row?.totalTime,
    row?.finalTime,
    row?.bestTime,
    row?.actualTime,
    row?.time,
    row?.value,
    row?.result,
    row?.score,
  ];
  for (const candidate of scalarCandidates) {
    if (typeof candidate !== 'string' && typeof candidate !== 'number') continue;
    const text = normalizeText(candidate);
    if (text) return text;
  }
  if (row?.resultValues && typeof row.resultValues === 'object') {
    const summary = Object.entries(row.resultValues)
      .filter(([, value]) => normalizeText(value))
      .map(([key, value]) => `${key}: ${normalizeText(value)}`)
      .join(' / ');
    if (summary) return summary;
  }
  const firstRep = asArray(row?.repResults).find((rep) => rep && typeof rep === 'object') || null;
  if (firstRep) {
    const repTime = normalizeText(firstRep?.overallTime || firstRep?.time);
    if (repTime) return repTime;
    // One 25m split is never an official 100m Test result.
    // Only completed measured repetitions can produce a scalar display value.
    const namedDistance = normalizeText(row?.testName || row?.test || row?.testType || '')
      .match(/\b(?:[0-9]+\s*[xX]\s*)?([0-9]{2,4})\s*m?\b/)?.[1] || '';
    const expectedDistance = toNumber(row?.distance, 0) || toNumber(namedDistance, 0);
    if (expectedDistance > 0) {
      const measured = summarizeRecordedReps(row?.repResults, { expectedDistance });
      if (measured.timeRecordedCount > 0) return measured.averageTime;
    }
  }
  if (Number.isFinite(Number(row?.rank))) return `Rank ${row.rank}`;
  if (Boolean(row?.pb) || Boolean(row?.personalBest)) return 'PB';
  return '';
}

function resolveOwnershipToken(row) {
  if (!row || typeof row !== 'object') return { accountId: '', tenantId: '' };
  return {
    accountId: normalizeText(row?.accountId || row?.ownerAccountId || row?.meta?.accountId || row?.metadata?.accountId).toLowerCase(),
    tenantId: normalizeText(row?.tenantId || row?.tenantScope || row?.ownerTenantId || row?.meta?.tenantId || row?.metadata?.tenantId).toLowerCase(),
  };
}

function matchesOwnership(row, activeAccountId, activeTenantId) {
  const expectedAccount = normalizeText(activeAccountId).toLowerCase();
  const expectedTenant = normalizeText(activeTenantId).toLowerCase();
  const actual = resolveOwnershipToken(row);
  // Account context can be the authenticated username while persisted records use
  // tenant-qualified account IDs. Compare the same canonical identity instead of
  // dropping legitimate test and race results because of representation alone.
  const tenant = expectedTenant || actual.tenantId;
  const qualify = (account) => account && tenant && !account.includes(':')
    ? `${tenant}:${account}`
    : account;
  if (expectedAccount && actual.accountId && qualify(actual.accountId) !== qualify(expectedAccount)) return false;
  if (expectedTenant && actual.tenantId && actual.tenantId !== expectedTenant) return false;
  return true;
}

function toScopeSwimmerIds(row, selectedSwimmerId) {
  const selected = normalizeText(selectedSwimmerId);
  if (selected && selected !== 'all') {
    const direct = normalizeText(row?.swimmerId);
    if (direct && direct !== selected) return [];
    const attendeeIds = asArray(row?.attendeeIds).map((id) => normalizeText(id)).filter(Boolean);
    if (attendeeIds.length > 0 && !attendeeIds.includes(selected)) return [];
    const resultKeys = row?.resultsBySwimmer && typeof row.resultsBySwimmer === 'object'
      ? Object.keys(row.resultsBySwimmer).map((id) => normalizeText(id)).filter(Boolean)
      : [];
    if (resultKeys.length > 0 && !resultKeys.includes(selected)) return [];
    const swimmerIds = asArray(row?.swimmerIds).map(normalizeText).filter(Boolean);
    const athleteIds = asArray(row?.athleteIds).map(normalizeText).filter(Boolean);
    if (swimmerIds.length && !swimmerIds.includes(selected)) return [];
    if (athleteIds.length && !athleteIds.includes(selected)) return [];
    if (!direct && !attendeeIds.length && !resultKeys.length && !swimmerIds.length && !athleteIds.length) return [];
    return [selected];
  }

  const resolved = new Set();
  const direct = normalizeText(row?.swimmerId);
  if (direct) resolved.add(direct);
  [...asArray(row?.attendeeIds), ...asArray(row?.swimmerIds), ...asArray(row?.athleteIds)].forEach((id) => {
    const token = normalizeText(id);
    if (token) resolved.add(token);
  });
  if (resolved.size === 0) {
    const bySwimmer = row?.resultsBySwimmer && typeof row.resultsBySwimmer === 'object'
      ? Object.keys(row.resultsBySwimmer)
      : [];
    bySwimmer.forEach((id) => {
      const token = normalizeText(id);
      if (token) resolved.add(token);
    });
  }
  return Array.from(resolved);
}

function buildEvidenceDedupKey(row) {
  const swimmerId = normalizeText(row?.swimmerId);
  const fixtureOrTestId = normalizeText(row?.fixtureId || row?.testId || row?.id);
  const eventOrSetId = normalizeText(row?.eventId || row?.setId || row?.linkedSetId || row?.trainingSetId);
  const date = normalizeDateKey(row?.date || row?.testDate || row?.resultDate || row?.updatedAt || row?.startDate);
  const result = normalizeText(resolveResultValue(row)).toLowerCase();
  const distance = normalizeText(row?.distance);
  const stroke = normalizeText(row?.stroke);
  return [swimmerId, fixtureOrTestId, eventOrSetId, date, result, distance, stroke].join('|').toLowerCase();
}

function dedupeRows(rows) {
  const map = new Map();
  for (const row of asArray(rows)) {
    const key = buildEvidenceDedupKey(row);
    if (!key) continue;
    if (!map.has(key)) {
      map.set(key, row);
      continue;
    }
    const existing = map.get(key);
    const existingQuality = hasAnyTimeOrResultFields(existing) ? 1 : 0;
    const incomingQuality = hasAnyTimeOrResultFields(row) ? 1 : 0;
    if (incomingQuality > existingQuality) {
      map.set(key, row);
    }
  }
  return Array.from(map.values());
}

export function buildCanonicalSwimmerEvidence({
  db,
  swimmerId = 'all',
  activeAccountId = '',
  activeTenantId = '',
  rangeStart = '',
  rangeEnd = '',
}) {
  const selectedSwimmerId = normalizeText(swimmerId);
  const inWindow = (value) => {
    const key = normalizeDateKey(value);
    if (!key) return true;
    if (rangeStart && key < rangeStart) return false;
    if (rangeEnd && key > rangeEnd) return false;
    return true;
  };

  // Attendance decides whose results count. A test in a session where the
  // swimmer is recorded absent, or a race the swimmer is no longer entered
  // in, is a data conflict: listed in attendanceConflicts, never scored.
  const attendanceBySwimmer = new Map();
  const attendanceOf = (id) => {
    if (!attendanceBySwimmer.has(id)) attendanceBySwimmer.set(id, buildSwimmerScheduleDeliveryRatios(db, id));
    return attendanceBySwimmer.get(id);
  };
  const recordedAbsent = (id, scheduleId) => Boolean(scheduleId) && attendanceOf(id).get(scheduleId)?.attended === false;
  const attendanceConflicts = [];

  const testRows = [];
  for (const row of asArray(db?.tests)) {
    if (!matchesOwnership(row, activeAccountId, activeTenantId)) continue;
    const swimmerIds = toScopeSwimmerIds(row, selectedSwimmerId);
    if (swimmerIds.length === 0) continue;
    const rowDate = normalizeDateKey(row?.date || row?.testDate || row?.resultDate || row?.updatedAt);
    if (!inWindow(rowDate)) continue;

    for (const resolvedSwimmerId of swimmerIds) {
      const swimmerResult = row?.resultsBySwimmer && typeof row.resultsBySwimmer === 'object'
        ? row.resultsBySwimmer[resolvedSwimmerId]
        : null;
      const source = swimmerResult && typeof swimmerResult === 'object'
        ? { ...row, ...swimmerResult }
        : row;
      const canonicalRow = {
        sourceType: 'tests',
        id: normalizeText(row?.id),
        testId: normalizeText(row?.id),
        swimmerId: resolvedSwimmerId,
        attendeeIds: asArray(row?.attendeeIds).map((value) => normalizeText(value)).filter(Boolean),
        testType: normalizeText(row?.testType || row?.metric || row?.type || row?.testName || row?.name || 'Test'),
        testName: normalizeText(row?.testName || row?.name || row?.metric || row?.testType),
        templateName: normalizeText(row?.templateName),
        notes: normalizeText(source?.notes || row?.notes),
        date: rowDate,
        resultDate: rowDate,
        scheduleId: normalizeText(row?.scheduleId),
        sessionId: normalizeText(row?.sessionId || row?.trainingSessionId),
        linkedSetId: normalizeText(row?.linkedSetId || row?.setId || row?.trainingSetId),
        setId: normalizeText(row?.linkedSetId || row?.setId || row?.trainingSetId),
        distance: toNumber(row?.distance || row?.distancePerRep, 0),
        stroke: normalizeText(row?.stroke || row?.eventStroke),
        squadId: normalizeText(row?.squadId),
        squadIds: asArray(row?.squadIds).map((value) => normalizeText(value)).filter(Boolean),
        repResults: asArray(source?.repResults),
        testRepResults: asArray(source?.testRepResults),
        resultValue: resolveResultValue(source),
        resultFields: asArray(source?.resultFields),
        resultValues: source?.resultValues && typeof source.resultValues === 'object' ? { ...source.resultValues } : {},
        completed: hasCompletedTestMeasurement(source) && (!rowDate || rowDate <= normalizeDateKey(new Date().toISOString())),
        raw: source,
      };
      if (canonicalRow.completed && recordedAbsent(resolvedSwimmerId, canonicalRow.scheduleId)) {
        canonicalRow.completed = false;
        canonicalRow.attendanceConflict = 'test-result-recorded-for-absent-swimmer';
        attendanceConflicts.push({ sourceType: 'tests', id: canonicalRow.id, swimmerId: resolvedSwimmerId, date: rowDate, scheduleId: canonicalRow.scheduleId, conflict: canonicalRow.attendanceConflict });
      }
      testRows.push(canonicalRow);
    }
  }

  // testRepResults rows are individual repetitions. Rows sharing a testId
  // belong to ONE test (ordered by rep number) so that rep-to-rep variation,
  // drift and first break can be measured; they were previously split into
  // one-rep tests. A parent test already holding its reps is not duplicated.
  const repGroups = new Map();
  asArray(db?.testRepResults).forEach((row, order) => {
    if (!matchesOwnership(row, activeAccountId, activeTenantId)) return;
    const swimmerIds = toScopeSwimmerIds(row, selectedSwimmerId);
    if (swimmerIds.length === 0) return;
    const rowDate = normalizeDateKey(row?.date || row?.testDate || row?.resultDate || row?.updatedAt);
    if (!inWindow(rowDate)) return;
    const testKey = normalizeText(row?.testId) || normalizeText(row?.id) || `row-${order}`;
    for (const resolvedSwimmerId of swimmerIds) {
      // The date is part of the key: a test id reused on another day is a
      // different sitting and must not merge into one test.
      const key = `${testKey}|${resolvedSwimmerId}|${rowDate}`;
      if (!repGroups.has(key)) repGroups.set(key, { testKey, swimmerId: resolvedSwimmerId, rowDate, rows: [] });
      repGroups.get(key).rows.push({ row, order });
    }
  });
  const repNumber = (entry) => {
    const n = Number(entry.row?.repIndex ?? entry.row?.rep ?? entry.row?.repNumber ?? entry.row?.repetition);
    return Number.isFinite(n) ? n : Number.POSITIVE_INFINITY;
  };
  for (const group of repGroups.values()) {
    const ordered = group.rows.slice().sort((a, b) => (repNumber(a) - repNumber(b)) || (a.order - b.order));
    const first = ordered[0].row;
    const repResults = ordered.map(({ row }) => ({
      overallTime: normalizeText(row?.overallTime || row?.time || row?.resultTime || row?.value),
      overallStrokeCount: normalizeText(row?.overallStrokeCount || row?.strokeCount),
      // Keep the recorded unit: cycles must never be read as strokes.
      ...(row?.strokeCountUnit === 'cycles' ? { strokeCountUnit: 'cycles' } : {}),
      splits: asArray(row?.splits),
    }));
    // The parent is a stored test of the same sitting, never a test this loop
    // built from another date's repetition rows.
    const parent = testRows.find((test) => test.swimmerId === group.swimmerId
      && test.sourceType !== 'testRepResults'
      && (test.id === group.testKey || test.testId === group.testKey)
      && (!group.rowDate || !normalizeDateKey(test.date || test.testDate || test.resultDate)
        || normalizeDateKey(test.date || test.testDate || test.resultDate) === group.rowDate));
    if (parent) {
      if (!asArray(parent.repResults).length) parent.repResults = repResults;
      continue;
    }
    const repEnvelope = { repResults };
    testRows.push({
      sourceType: 'testRepResults',
      id: normalizeText(first?.testId) || normalizeText(first?.id),
      testId: group.testKey,
      swimmerId: group.swimmerId,
      attendeeIds: [],
      testType: normalizeText(first?.testType || first?.metric || first?.type || 'Test'),
      date: group.rowDate,
      resultDate: group.rowDate,
      scheduleId: normalizeText(first?.scheduleId),
      sessionId: normalizeText(first?.sessionId || first?.trainingSessionId),
      linkedSetId: normalizeText(first?.linkedSetId || first?.setId || first?.trainingSetId),
      setId: normalizeText(first?.linkedSetId || first?.setId || first?.trainingSetId),
      distance: toNumber(first?.distance || first?.distancePerRep, 0),
      stroke: normalizeText(first?.stroke),
      squadId: normalizeText(first?.squadId),
      squadIds: asArray(first?.squadIds).map((value) => normalizeText(value)).filter(Boolean),
      repResults,
      resultValue: resolveResultValue({ ...first, ...repEnvelope }),
      completed: hasAnyTimeOrResultFields({ ...first, ...repEnvelope }) && (!group.rowDate || group.rowDate <= normalizeDateKey(new Date().toISOString())),
      raw: first,
    });
    const built = testRows[testRows.length - 1];
    if (built.completed && recordedAbsent(group.swimmerId, built.scheduleId)) {
      built.completed = false;
      built.attendanceConflict = 'test-result-recorded-for-absent-swimmer';
      attendanceConflicts.push({ sourceType: 'testRepResults', id: built.id, swimmerId: group.swimmerId, date: group.rowDate, scheduleId: built.scheduleId, conflict: built.attendanceConflict });
    }
  }

  const fixtureCompetitionRows = [];
  for (const fixture of asArray(db?.fixtures)) {
    if (!matchesOwnership(fixture, activeAccountId, activeTenantId)) continue;
    const fixtureDate = normalizeDateKey(fixture?.startDate || fixture?.endDate || fixture?.updatedAt);
    if (!inWindow(fixtureDate)) continue;
    const fixtureEvents = [...asArray(fixture?.events), ...asArray(fixture?.galaEvents)];
    for (const eventItem of fixtureEvents) {
      const resultsBySwimmer = eventItem?.resultsBySwimmer && typeof eventItem.resultsBySwimmer === 'object'
        ? eventItem.resultsBySwimmer
        : {};
      const swimmerIds = selectedSwimmerId && selectedSwimmerId !== 'all'
        ? [selectedSwimmerId]
        : Object.keys(resultsBySwimmer).map((value) => normalizeText(value)).filter(Boolean);
      for (const resolvedSwimmerId of swimmerIds) {
        const result = resultsBySwimmer?.[resolvedSwimmerId] && typeof resultsBySwimmer[resolvedSwimmerId] === 'object'
          ? resultsBySwimmer[resolvedSwimmerId]
          : {};
        const canonicalRow = {
          sourceType: 'fixtures',
          id: `${normalizeText(fixture?.id)}:${normalizeText(eventItem?.id)}:${resolvedSwimmerId}`,
          fixtureId: normalizeText(fixture?.id),
          fixtureName: normalizeText(fixture?.name || 'Competition'),
          eventId: normalizeText(eventItem?.id),
          swimmerId: resolvedSwimmerId,
          date: fixtureDate,
          distance: toNumber(eventItem?.distance || result?.distance, 0),
          stroke: normalizeText(eventItem?.stroke || result?.stroke),
          squadId: normalizeText(fixture?.squadId),
          squadIds: asArray(fixture?.squadIds).map((value) => normalizeText(value)).filter(Boolean),
          competitionType: normalizeText(fixture?.competitionType || fixture?.type),
          event: normalizeText(eventItem?.event || eventItem?.eventLabel || eventItem?.name),
          eventName: normalizeText(eventItem?.eventLabel || eventItem?.event || eventItem?.name),
          notes: normalizeText(result?.observations || fixture?.notes),
          isMainEvent: Boolean(fixture?.isMainEvent),
          resultValue: resolveResultValue(result),
          rank: result?.rank,
          pb: Boolean(result?.pb || result?.isPb || result?.isPB || result?.personalBest),
          // A future fixture is a planned competition, not a completed race,
          // even when a showcase/template row contains a provisional time.
          completed: hasAnyTimeOrResultFields(result) && (!fixtureDate || fixtureDate <= normalizeDateKey(new Date().toISOString())),
          raw: { fixture, eventItem, result },
        };
        const entrants = asArray(eventItem?.attendeeIds).map((value) => normalizeText(value)).filter(Boolean);
        if (canonicalRow.completed && entrants.length > 0 && !entrants.includes(resolvedSwimmerId)) {
          canonicalRow.completed = false;
          canonicalRow.attendanceConflict = 'race-result-for-swimmer-not-entered-in-event';
          attendanceConflicts.push({ sourceType: 'fixtures', id: canonicalRow.id, swimmerId: resolvedSwimmerId, date: fixtureDate, conflict: canonicalRow.attendanceConflict });
        }
        fixtureCompetitionRows.push(canonicalRow);
      }
    }
  }

  const legacyCompetitionRows = [];
  for (const row of [...asArray(db?.competitionResults), ...asArray(db?.competitionRepResults)]) {
    if (!matchesOwnership(row, activeAccountId, activeTenantId)) continue;
    const rowDate = normalizeDateKey(row?.date || row?.resultDate || row?.startDate || row?.updatedAt);
    if (!inWindow(rowDate)) continue;
    const swimmerIds = toScopeSwimmerIds(row, selectedSwimmerId);
    if (swimmerIds.length === 0) continue;
    for (const resolvedSwimmerId of swimmerIds) {
      legacyCompetitionRows.push({
        sourceType: 'legacyCompetition',
        id: normalizeText(row?.id),
        fixtureId: normalizeText(row?.fixtureId || row?.competitionId),
        fixtureName: normalizeText(row?.fixtureName || row?.competition || row?.name || 'Competition'),
        eventId: normalizeText(row?.eventId),
        swimmerId: resolvedSwimmerId,
        date: rowDate,
        distance: toNumber(row?.distance || row?.eventDistance, 0),
        stroke: normalizeText(row?.stroke || row?.eventStroke || row?.event),
        squadId: normalizeText(row?.squadId),
        squadIds: asArray(row?.squadIds).map((value) => normalizeText(value)).filter(Boolean),
        competitionType: normalizeText(row?.competitionType || row?.type),
        isMainEvent: Boolean(row?.isMainEvent),
        resultValue: resolveResultValue(row),
        rank: row?.rank,
        pb: Boolean(row?.pb || row?.isPb || row?.isPB || row?.personalBest),
        // Legacy imports must obey the same future-race rule as fixture results.
        // A target or provisional future result is not completed evidence.
        completed: hasAnyTimeOrResultFields(row) && (!rowDate || rowDate <= normalizeDateKey(new Date().toISOString())),
        raw: row,
      });
    }
  }

  // Resolve recorded evidence to the canonical swimmer, not to the
  // competition event or a guessed position in a squad roster.
  const swimmerNames = new Map(asArray(db?.swimmers)
    .map(swimmer => {
      const id = normalizeText(swimmer?.id || swimmer?.swimmerId);
      const name = normalizeText(swimmer?.fullName || swimmer?.name
        || [swimmer?.firstName, swimmer?.lastName].map(normalizeText).filter(Boolean).join(' '));
      return [id,name];
    }).filter(([id,name]) => id && name));
  const withSwimmerIdentity = (row) => ({
    ...row,
    swimmerName: swimmerNames.get(normalizeText(row?.swimmerId))
      || normalizeText(row?.raw?.swimmerName || row?.raw?.athleteName)
      || (normalizeText(row?.swimmerId) ? `Swimmer ID: ${normalizeText(row.swimmerId)}` : 'Unidentified swimmer'),
  });

  const canonicalTests = dedupeRows(testRows).map(withSwimmerIdentity);
  const canonicalCompetitions = dedupeRows([...fixtureCompetitionRows, ...legacyCompetitionRows]).map(withSwimmerIdentity);

  return {
    tests: canonicalTests,
    completedTests: canonicalTests.filter((row) => Boolean(row?.completed)),
    competitions: canonicalCompetitions,
    completedCompetitions: canonicalCompetitions.filter((row) => Boolean(row?.completed)),
    attendanceConflicts,
  };
}

export function canonicalEvidenceHasCompletedResult(row) {
  return hasAnyTimeOrResultFields(row);
}

export function canonicalEvidenceNormalizeDateKey(value) {
  return normalizeDateKey(value);
}
