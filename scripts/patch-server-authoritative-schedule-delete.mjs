import fs from 'node:fs';
import path from 'node:path';

const indexPath = path.resolve('index.js');
let source = fs.readFileSync(indexPath, 'utf8').replace(/\r\n/g, '\n');

const marker = '// ATHLYRAX_SERVER_AUTHORITATIVE_SCHEDULE_DELETE_V1';
const putAnchor = "app.put('/db', requireAuth, requireWriteRole, requireBillingWriteAccess, (req, res) => {";

if (!source.includes(marker)) {
  if (!source.includes(putAnchor)) throw new Error('Could not locate PUT /db anchor for server-authoritative schedule deletion.');

  const route = String.raw`${marker}
app.post('/db/schedule-delete', requireAuth, requireWriteRole, requireBillingWriteAccess, (req, res) => {
	const tenantScope = resolveStoragePathsForRequest(req);
	if (!tenantScope.ok) {
		res.status(tenantScope.status).json(tenantScope.body);
		return;
	}

	const rawIds = Array.isArray(req.body?.scheduleIds) ? req.body.scheduleIds : [];
	const scheduleIds = Array.from(new Set(rawIds.map((value) => String(value || '').trim()).filter(Boolean)));
	if (scheduleIds.length < 1) {
		res.status(400).json({ error: 'At least one schedule ID is required.' });
		return;
	}
	if (scheduleIds.length > 20000) {
		res.status(413).json({ error: 'Too many schedule IDs in one delete request.' });
		return;
	}

	const storagePaths = tenantScope.storagePaths;
	ensureStorageLayout(storagePaths);

	enqueueWrite(async () => {
		ensureStorageLayout(storagePaths);
		if (!fs.existsSync(storagePaths.dbPath)) {
			const err = new Error('Tenant database is missing. Refusing destructive operation.');
			err.status = 503;
			throw err;
		}

		const currentDb = readJsonFile(storagePaths.dbPath);
		if (!currentDb || typeof currentDb !== 'object' || Array.isArray(currentDb)) {
			const err = new Error('Tenant database is unreadable. Refusing destructive operation.');
			err.status = 503;
			throw err;
		}

		const now = new Date().toISOString();
		const targetIds = new Set(scheduleIds);
		const textId = (value) => String(value || '').trim();
		const scheduleRows = Array.isArray(currentDb.schedule) ? currentDb.schedule : [];
		const legacyScheduleRows = Array.isArray(currentDb.trainingSchedules) ? currentDb.trainingSchedules : [];
		const sessionRows = Array.isArray(currentDb.trainingSessions) ? currentDb.trainingSessions : [];
		const setRows = Array.isArray(currentDb.trainingSessionSets) ? currentDb.trainingSessionSets : [];
		const blockRows = Array.isArray(currentDb.trainingSetBlocks) ? currentDb.trainingSetBlocks : [];
		const attendanceRows = Array.isArray(currentDb.attendance) ? currentDb.attendance : [];
		const requestedScheduleRows = scheduleRows.filter((row) => targetIds.has(textId(row?.id)));

		const linkedSessionIds = new Set(
			sessionRows
				.filter((row) => targetIds.has(textId(row?.scheduleId || row?.trainingScheduleId)))
				.map((row) => textId(row?.id))
				.filter(Boolean),
		);
		const linkedSetIds = new Set(
			setRows
				.filter((row) => linkedSessionIds.has(textId(row?.sessionId || row?.trainingSessionId)) || targetIds.has(textId(row?.scheduleId || row?.trainingScheduleId)))
				.map((row) => textId(row?.id))
				.filter(Boolean),
		);
		const linkedBlockIds = new Set(
			blockRows
				.filter((row) => {
					if (linkedSessionIds.has(textId(row?.sessionId || row?.trainingSessionId))) return true;
					if (linkedSetIds.has(textId(row?.setId))) return true;
					return (Array.isArray(row?.setIds) ? row.setIds : []).some((id) => linkedSetIds.has(textId(id)));
				})
				.map((row) => textId(row?.id))
				.filter(Boolean),
		);
		const linkedAttendanceIds = new Set(
			attendanceRows
				.filter((row) => targetIds.has(textId(row?.scheduleId || row?.trainingScheduleId)))
				.map((row) => textId(row?.id))
				.filter(Boolean),
		);

		// The backend owns semantic deletion identity. The browser may send older
		// suppression metadata for backward compatibility, but it is not trusted as
		// the source of truth. Build a safe identity from the persisted Schedule and
		// its linked Training Session copies before any destructive write occurs.
		const serverDerivedSuppressions = [];
		const unresolvedPermanentScheduleIds = [];
		for (const scheduleRow of requestedScheduleRows) {
			if (isExplicitManualScheduleRow(scheduleRow)) continue;
			const scheduleId = textId(scheduleRow?.id);
			const linkedSessions = sessionRows.filter(
				(row) => textId(row?.scheduleId || row?.trainingScheduleId) === scheduleId,
			);
			const firstValue = (resolver) => {
				const own = resolver(scheduleRow);
				if (own) return own;
				for (const linked of linkedSessions) {
					const value = resolver(linked);
					if (value) return value;
				}
				return '';
			};
			const squadIds = scheduleOccurrenceUnique([
				...getScheduleOccurrenceSquadIds(scheduleRow),
				...linkedSessions.flatMap((row) => getScheduleOccurrenceSquadIds(row)),
			]);
			const evidenceRow = {
				...scheduleRow,
				generatedSourceSlotId: firstValue(getScheduleOccurrenceSourceSlotId),
				timetableId: firstValue(getScheduleOccurrenceTimetableId),
				scheduleDate: firstValue(getScheduleOccurrenceDate),
				startTime: firstValue((row) => getScheduleOccurrenceTime(row?.startTime)),
				endTime: firstValue((row) => getScheduleOccurrenceTime(row?.endTime)),
				venueId: firstValue((row) => scheduleOccurrenceText(row?.venueId || row?.venue)),
				sessionTypeId: firstValue((row) => scheduleOccurrenceText(row?.sessionTypeId || row?.trainingTypeId || row?.sessionType || row?.type)),
				squadIds,
			};
			const exactIdentity = getScheduleOccurrenceIdentityParts(evidenceRow);
			if (exactIdentity) {
				serverDerivedSuppressions.push({
					identityType: 'source-slot',
					...exactIdentity,
					deletedAt: now,
					deletedBy: 'server-authoritative-schedule-delete',
				});
				continue;
			}
			const fingerprint = getScheduleOccurrenceFingerprint(evidenceRow);
			if (fingerprint) {
				serverDerivedSuppressions.push({
					identityType: 'legacy-fingerprint',
					...fingerprint,
					deletedAt: now,
					deletedBy: 'server-authoritative-schedule-delete',
				});
				continue;
			}
			if (scheduleId) unresolvedPermanentScheduleIds.push(scheduleId);
		}
		if (unresolvedPermanentScheduleIds.length > 0) {
			const err = new Error('Could not establish a safe permanent identity for one or more Scheduled Sessions. Refusing partial deletion.');
			err.status = 409;
			err.details = { unresolvedPermanentScheduleIds };
			throw err;
		}

		const deletionTombstones = [
			...scheduleIds.map((id) => ({ collection: 'schedule', id, deletedAt: now, deletedBy: 'server-authoritative-schedule-delete' })),
			...Array.from(linkedSessionIds).map((id) => ({ collection: 'trainingSessions', id, deletedAt: now, deletedBy: 'server-authoritative-schedule-delete' })),
			...Array.from(linkedSetIds).map((id) => ({ collection: 'trainingSessionSets', id, deletedAt: now, deletedBy: 'server-authoritative-schedule-delete' })),
			...Array.from(linkedBlockIds).map((id) => ({ collection: 'trainingSetBlocks', id, deletedAt: now, deletedBy: 'server-authoritative-schedule-delete' })),
			...Array.from(linkedAttendanceIds).map((id) => ({ collection: 'attendance', id, deletedAt: now, deletedBy: 'server-authoritative-schedule-delete' })),
		];
		const mergedTombstones = mergeTombstoneLists(
			Array.isArray(currentDb.__tombstones) ? currentDb.__tombstones : [],
			deletionTombstones,
		);
		const mergedSuppressions = mergeScheduleOccurrenceSuppressionLists(
			Array.isArray(currentDb?.__meta?.scheduleOccurrenceSuppressions) ? currentDb.__meta.scheduleOccurrenceSuppressions : [],
			serverDerivedSuppressions,
		);

		const currentRevisionRaw = Number.parseInt(String(currentDb?.__meta?.storageRevision ?? '0'), 10);
		const currentRevision = Number.isFinite(currentRevisionRaw) && currentRevisionRaw >= 0 ? currentRevisionRaw : 0;
		let nextDb = {
			...currentDb,
			schedule: scheduleRows.filter((row) => !targetIds.has(textId(row?.id))),
			...(Object.prototype.hasOwnProperty.call(currentDb, 'trainingSchedules')
				? { trainingSchedules: legacyScheduleRows.filter((row) => !targetIds.has(textId(row?.id))) }
				: {}),
			trainingSessions: sessionRows.filter((row) => !targetIds.has(textId(row?.scheduleId || row?.trainingScheduleId))),
			trainingSessionSets: setRows.filter((row) => !linkedSessionIds.has(textId(row?.sessionId || row?.trainingSessionId)) && !targetIds.has(textId(row?.scheduleId || row?.trainingScheduleId))),
			trainingSetBlocks: blockRows.filter((row) => !linkedBlockIds.has(textId(row?.id))),
			attendance: attendanceRows.filter((row) => !targetIds.has(textId(row?.scheduleId || row?.trainingScheduleId))),
			__tombstones: mergedTombstones,
			__meta: {
				...(currentDb.__meta && typeof currentDb.__meta === 'object' ? currentDb.__meta : {}),
				scheduleOccurrenceSuppressions: mergedSuppressions,
				storageRevision: currentRevision + 1,
				updatedAt: now,
			},
		};

		const suppressionFiltered = applyScheduleOccurrenceSuppressionsToDbShape(nextDb, mergedSuppressions);
		nextDb = {
			...suppressionFiltered.dbShape,
			__tombstones: mergedTombstones,
			__meta: {
				...(suppressionFiltered.dbShape?.__meta && typeof suppressionFiltered.dbShape.__meta === 'object'
					? suppressionFiltered.dbShape.__meta
					: {}),
				scheduleOccurrenceSuppressions: mergedSuppressions,
				storageRevision: currentRevision + 1,
				updatedAt: now,
			},
		};

		writeDbSnapshotIfPossible(storagePaths.dbPath, storagePaths.snapshotDir);
		writeAtomicJsonFile(storagePaths.dbPath, nextDb);

		const persisted = readJsonFile(storagePaths.dbPath);
		const persistedSchedule = Array.isArray(persisted?.schedule) ? persisted.schedule : [];
		const persistedLegacySchedule = Array.isArray(persisted?.trainingSchedules) ? persisted.trainingSchedules : [];
		const persistedSessions = Array.isArray(persisted?.trainingSessions) ? persisted.trainingSessions : [];
		const persistedSets = Array.isArray(persisted?.trainingSessionSets) ? persisted.trainingSessionSets : [];
		const persistedAttendance = Array.isArray(persisted?.attendance) ? persisted.attendance : [];
		const remainingScheduleIds = persistedSchedule.map((row) => textId(row?.id)).filter((id) => targetIds.has(id));
		const remainingLegacyIds = persistedLegacySchedule.map((row) => textId(row?.id)).filter((id) => targetIds.has(id));
		const remainingSessionIds = persistedSessions.map((row) => textId(row?.id)).filter((id) => linkedSessionIds.has(id));
		const remainingSetIds = persistedSets.map((row) => textId(row?.id)).filter((id) => linkedSetIds.has(id));
		const remainingAttendanceIds = persistedAttendance.map((row) => textId(row?.id)).filter((id) => linkedAttendanceIds.has(id));
		if (remainingScheduleIds.length || remainingLegacyIds.length || remainingSessionIds.length || remainingSetIds.length || remainingAttendanceIds.length) {
			const err = new Error('Server-authoritative schedule deletion verification failed after persistence reread.');
			err.status = 500;
			err.details = {
				remainingScheduleIds,
				remainingLegacyIds,
				remainingSessionIds,
				remainingSetIds,
				remainingAttendanceIds,
			};
			throw err;
		}

		return {
			deletedScheduleIds: scheduleIds,
			removedScheduleCount: scheduleRows.length - (Array.isArray(persisted?.schedule) ? persisted.schedule.length : 0),
			removedLegacyScheduleCount: legacyScheduleRows.length - (Array.isArray(persisted?.trainingSchedules) ? persisted.trainingSchedules.length : 0),
			removedTrainingSessionCount: linkedSessionIds.size,
			removedTrainingSetCount: linkedSetIds.size,
			removedTrainingSetBlockCount: linkedBlockIds.size,
			removedAttendanceCount: linkedAttendanceIds.size,
			serverDerivedScheduleOccurrenceSuppressionCount: serverDerivedSuppressions.length,
			tombstoneCount: mergedTombstones.length,
			scheduleOccurrenceSuppressionCount: mergedSuppressions.length,
			storageRevision: currentRevision + 1,
		};
	})
		.then((result) => {
			res.setHeader('X-AthlyraX-DB-Revision', String(result.storageRevision));
			res.status(200).json({
				ok: true,
				verified: true,
				...result,
			});
		})
		.catch((error) => {
			const status = Number.isFinite(Number(error?.status)) ? Number(error.status) : 500;
			res.status(status).json({
				error: error instanceof Error ? error.message : 'Could not delete scheduled sessions.',
				...(error?.details ? { details: error.details } : {}),
			});
		});
});

`;

  source = source.replace(putAnchor, `${route}${putAnchor}`);
}

for (const required of [
  marker,
  "app.post('/db/schedule-delete'",
  "verified: true",
  "Server-authoritative schedule deletion verification failed after persistence reread.",
  "X-AthlyraX-DB-Revision",
  "attendance: attendanceRows.filter((row) => !targetIds.has(textId(row?.scheduleId || row?.trainingScheduleId)))",
  "...Array.from(linkedAttendanceIds).map((id) => ({ collection: 'attendance'",
  "remainingAttendanceIds",
  "removedAttendanceCount: linkedAttendanceIds.size",
  "const serverDerivedSuppressions = [];",
  "getScheduleOccurrenceIdentityParts(evidenceRow)",
  "getScheduleOccurrenceFingerprint(evidenceRow)",
  "unresolvedPermanentScheduleIds",
  "serverDerivedScheduleOccurrenceSuppressionCount",
]) {
  if (!source.includes(required)) throw new Error(`Server-authoritative schedule deletion route missing invariant: ${required}`);
}

if (source.includes('req.body?.scheduleOccurrenceSuppressions')) {
  throw new Error('Server-authoritative Schedule deletion must not trust client-supplied semantic suppressions.');
}

fs.writeFileSync(indexPath, source, 'utf8');
console.log('ATHLYRAX_SERVER_AUTHORITATIVE_SCHEDULE_DELETE_OK');
