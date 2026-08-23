import fs from 'node:fs';
import path from 'node:path';

const indexPath = path.resolve('index.js');
let source = fs.readFileSync(indexPath, 'utf8').replace(/\r\n/g, '\n');

const marker = '// ATHLYRAX_CANONICAL_SCHEDULE_DELETE_OCCURRENCE_V1';
const aliasMarker = '// ATHLYRAX_SERVER_AUTHORITATIVE_SCHEDULE_DELETE_SESSION_ALIAS_V1';
const importLine = "import { resolveCanonicalScheduleDeleteTargets } from './scripts/schedule-delete-occurrence-identity.mjs';";

if (!source.includes(importLine)) {
  const importAnchor = "import Stripe from 'stripe';";
  if (!source.includes(importAnchor)) throw new Error('Could not locate backend import anchor for canonical Schedule delete resolver.');
  source = source.replace(importAnchor, `${importAnchor}\n${importLine}`);
}

if (!source.includes(marker)) {
  const oldResolution = `${aliasMarker}
		const requestedDeleteIds = new Set(scheduleIds.map(textId).filter(Boolean));
		const targetIds = new Set(requestedDeleteIds);
		for (const sessionRow of sessionRows) {
			const sessionId = textId(sessionRow?.id);
			if (!sessionId || !requestedDeleteIds.has(sessionId)) continue;
			const linkedScheduleId = textId(sessionRow?.scheduleId || sessionRow?.trainingScheduleId);
			if (linkedScheduleId) targetIds.add(linkedScheduleId);
		}
		const persistedScheduleIds = new Set([
			...scheduleRows.map((row) => textId(row?.id)),
			...legacyScheduleRows.map((row) => textId(row?.id)),
		].filter(Boolean));
		const resolvedScheduleIds = Array.from(targetIds).filter((id) => persistedScheduleIds.has(id));
		if (resolvedScheduleIds.length < 1) {
			const err = new Error('No persisted Schedule could be resolved from the selected Scheduled Session rows.');
			err.status = 409;
			err.details = { requestedScheduleIds: Array.from(requestedDeleteIds) };
			throw err;
		}
		targetIds.clear();
		for (const id of resolvedScheduleIds) targetIds.add(id);
`;
  if (!source.includes(oldResolution)) {
    throw new Error('Could not locate exact Schedule delete physical-ID resolution block. Refusing partial transform.');
  }

  const canonicalResolution = `${aliasMarker}
		${marker}
		const requestedDeleteIds = new Set(scheduleIds.map(textId).filter(Boolean));
		const canonicalDeleteResolution = resolveCanonicalScheduleDeleteTargets({
			requestedIds: scheduleIds,
			scheduleRows,
			legacyScheduleRows,
			sessionRows,
			deletedAt: now,
		});
		if (canonicalDeleteResolution.targetScheduleIds.length < 1) {
			const err = new Error('No persisted Schedule could be resolved from the selected Scheduled Session rows.');
			err.status = 409;
			err.details = { requestedScheduleIds: Array.from(requestedDeleteIds) };
			throw err;
		}
		if (canonicalDeleteResolution.unresolvedGeneratedScheduleIds.length > 0) {
			const err = new Error('Could not establish a safe permanent occurrence identity for one or more Scheduled Sessions. Refusing a deletion that could regenerate.');
			err.status = 409;
			err.details = {
				requestedScheduleIds: Array.from(requestedDeleteIds),
				unresolvedGeneratedScheduleIds: canonicalDeleteResolution.unresolvedGeneratedScheduleIds,
			};
			throw err;
		}
		const targetIds = new Set(canonicalDeleteResolution.targetScheduleIds);
		const serverDerivedSuppressions = canonicalDeleteResolution.suppressions;
`;
  source = source.replace(oldResolution, canonicalResolution);

  const suppressionAnchor = `		const mergedSuppressions = mergeScheduleOccurrenceSuppressionLists(
			Array.isArray(currentDb?.__meta?.scheduleOccurrenceSuppressions) ? currentDb.__meta.scheduleOccurrenceSuppressions : [],
			incomingSuppressions,
		);`;
  if (!source.includes(suppressionAnchor)) {
    throw new Error('Could not locate Schedule occurrence suppression merge.');
  }
  source = source.replace(suppressionAnchor, `		const mergedSuppressions = mergeScheduleOccurrenceSuppressionLists(
			Array.isArray(currentDb?.__meta?.scheduleOccurrenceSuppressions) ? currentDb.__meta.scheduleOccurrenceSuppressions : [],
			[...incomingSuppressions, ...serverDerivedSuppressions],
		);`);

  const responseAnchor = `			scheduleOccurrenceSuppressionCount: mergedSuppressions.length,`;
  if (!source.includes(responseAnchor)) throw new Error('Could not locate Schedule deletion response suppression count.');
  source = source.replace(responseAnchor, `${responseAnchor}
			serverDerivedScheduleOccurrenceSuppressionCount: serverDerivedSuppressions.length,`);
}

for (const required of [
  importLine,
  marker,
  'resolveCanonicalScheduleDeleteTargets({',
  'canonicalDeleteResolution.targetScheduleIds',
  'canonicalDeleteResolution.unresolvedGeneratedScheduleIds',
  'serverDerivedSuppressions',
  '[...incomingSuppressions, ...serverDerivedSuppressions]',
  'serverDerivedScheduleOccurrenceSuppressionCount',
  'Refusing a deletion that could regenerate.',
]) {
  if (!source.includes(required)) throw new Error(`Canonical Schedule delete occurrence transform missing invariant: ${required}`);
}

fs.writeFileSync(indexPath, source, 'utf8');
console.log('ATHLYRAX_CANONICAL_SCHEDULE_DELETE_OCCURRENCE_OK');
