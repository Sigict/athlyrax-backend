import fs from 'node:fs';
import path from 'node:path';

const indexPath = path.resolve('index.js');
let source = fs.readFileSync(indexPath, 'utf8').replace(/\r\n/g, '\n');

const marker = '// ATHLYRAX_CANONICAL_SCHEDULE_DELETE_OCCURRENCE_V1';
const sparseLegacyMarker = '// ATHLYRAX_SPARSE_LEGACY_SCHEDULE_PHYSICAL_DELETE_V1';
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
		${sparseLegacyMarker}
		// A sparse legacy/generated row may not contain enough date/time/source metadata
		// to derive a semantic occurrence suppression. It is still the user's persisted
		// data and must remain deletable. Exact physical Schedule IDs are permanently
		// tombstoned by the authoritative route, so stale clients cannot restore them.
		// Semantic suppressions remain an additional protection whenever identity exists.
		const physicalOnlyScheduleIds = canonicalDeleteResolution.unresolvedGeneratedScheduleIds;
		const targetIds = new Set(canonicalDeleteResolution.targetScheduleIds);
		const serverDerivedSuppressions = canonicalDeleteResolution.suppressions;
`;
  source = source.replace(oldResolution, canonicalResolution);

  const incomingSuppressionDefinition = `		const incomingSuppressions = Array.isArray(req.body?.scheduleOccurrenceSuppressions)
			? req.body.scheduleOccurrenceSuppressions
			: [];
`;
  source = source.replace(incomingSuppressionDefinition, '');

  const suppressionAnchor = `		const mergedSuppressions = mergeScheduleOccurrenceSuppressionLists(
			Array.isArray(currentDb?.__meta?.scheduleOccurrenceSuppressions) ? currentDb.__meta.scheduleOccurrenceSuppressions : [],
			incomingSuppressions,
		);`;
  if (!source.includes(suppressionAnchor)) {
    throw new Error('Could not locate Schedule occurrence suppression merge.');
  }
  source = source.replace(suppressionAnchor, `		const mergedSuppressions = mergeScheduleOccurrenceSuppressionLists(
			Array.isArray(currentDb?.__meta?.scheduleOccurrenceSuppressions) ? currentDb.__meta.scheduleOccurrenceSuppressions : [],
			serverDerivedSuppressions,
		);`);

  const responseAnchor = `			scheduleOccurrenceSuppressionCount: mergedSuppressions.length,`;
  if (!source.includes(responseAnchor)) throw new Error('Could not locate Schedule deletion response suppression count.');
  source = source.replace(responseAnchor, `${responseAnchor}
			serverDerivedScheduleOccurrenceSuppressionCount: serverDerivedSuppressions.length,
			physicalOnlyScheduleIds,`);
}

for (const required of [
  importLine,
  marker,
  sparseLegacyMarker,
  'resolveCanonicalScheduleDeleteTargets({',
  'canonicalDeleteResolution.targetScheduleIds',
  'canonicalDeleteResolution.unresolvedGeneratedScheduleIds',
  'physicalOnlyScheduleIds',
  'serverDerivedSuppressions',
  'serverDerivedSuppressions,',
  'serverDerivedScheduleOccurrenceSuppressionCount',
]) {
  if (!source.includes(required)) throw new Error(`Canonical Schedule delete occurrence transform missing invariant: ${required}`);
}

if (source.includes('req.body?.scheduleOccurrenceSuppressions') || source.includes('incomingSuppressions')) {
  throw new Error('Authoritative Schedule deletion still accepts client-supplied suppression authority.');
}

if (source.includes('Refusing a deletion that could regenerate.')) {
  throw new Error('Sparse legacy Schedule rows are still blocked by the obsolete semantic-identity refusal.');
}

fs.writeFileSync(indexPath, source, 'utf8');
console.log('ATHLYRAX_CANONICAL_SCHEDULE_DELETE_OCCURRENCE_OK');