import fs from 'node:fs';
import path from 'node:path';

const indexPath = path.resolve('index.js');
let source = fs.readFileSync(indexPath, 'utf8').replace(/\r\n/g, '\n');

const marker = '// ATHLYRAX_RUNTIME_DB_READ_FAIL_CLOSED';
if (!source.includes(marker)) {
  const getRouteStart = source.indexOf("app.get('/db', requireAuth, (req, res) => {");
  const legacyReadAnchor = `\t\t} else {\n\t\t\tlet responsePayload = data;\n\t\t\tconst role = String(req.auth?.role || '').trim().toLowerCase();`;
  const occurrenceReadAnchor = `\t\t} else {\n\t\t\tlet responsePayload = data;\n\t\t\ttry {\n\t\t\t\tconst persistedShape = JSON.parse(String(data || '{}'));\n\t\t\t\tconst persistedSuppressions = Array.isArray(persistedShape?.__meta?.scheduleOccurrenceSuppressions)\n\t\t\t\t\t? persistedShape.__meta.scheduleOccurrenceSuppressions\n\t\t\t\t\t: [];\n\t\t\t\tconst readFiltered = applyScheduleOccurrenceSuppressionsToDbShape(persistedShape, persistedSuppressions);\n\t\t\t\tresponsePayload = JSON.stringify(readFiltered.dbShape);\n\t\t\t} catch {\n\t\t\t\t// Invalid db.json is handled by the storage safety layer; preserve the original response here.\n\t\t\t}\n\t\t\tconst role = String(req.auth?.role || '').trim().toLowerCase();`;
  const readIndex = source.indexOf(
    source.includes(occurrenceReadAnchor) ? occurrenceReadAnchor : legacyReadAnchor,
    getRouteStart,
  );
  if (getRouteStart < 0 || readIndex < 0) throw new Error('GET /db read-integrity anchor was not found.');

  const occurrenceAwareReplacement = `\t\t} else {\n\t\t\t${marker}\n\t\t\tlet parsedDatabase;\n\t\t\ttry {\n\t\t\t\tparsedDatabase = JSON.parse(String(data || ''));\n\t\t\t\tif (!parsedDatabase || typeof parsedDatabase !== 'object' || Array.isArray(parsedDatabase)) {\n\t\t\t\t\tthrow new Error('Database root must be an object.');\n\t\t\t\t}\n\t\t\t} catch (error) {\n\t\t\t\tappendAuthAuditEvent({\n\t\t\t\t\taction: 'database_read_blocked',\n\t\t\t\t\treq,\n\t\t\t\t\tstatus: 'blocked',\n\t\t\t\t\treason: 'database_invalid_json',\n\t\t\t\t\tdetails: { tenantKey: storagePaths.tenantKey },\n\t\t\t\t});\n\t\t\t\tres.status(503).json({\n\t\t\t\t\terror: 'Tenant data is unavailable because the stored database failed integrity validation. No empty replacement was created.',\n\t\t\t\t\ttenantKey: storagePaths.tenantKey,\n\t\t\t\t});\n\t\t\t\treturn;\n\t\t\t}\n\t\t\tconst persistedSuppressions = Array.isArray(parsedDatabase?.__meta?.scheduleOccurrenceSuppressions)\n\t\t\t\t? parsedDatabase.__meta.scheduleOccurrenceSuppressions\n\t\t\t\t: [];\n\t\t\tconst readFiltered = applyScheduleOccurrenceSuppressionsToDbShape(parsedDatabase, persistedSuppressions);\n\t\t\tlet responsePayload = JSON.stringify(readFiltered.dbShape);\n\t\t\tconst role = String(req.auth?.role || '').trim().toLowerCase();`;

  const legacyReplacement = `\t\t} else {\n\t\t\t${marker}\n\t\t\tlet parsedDatabase;\n\t\t\ttry {\n\t\t\t\tparsedDatabase = JSON.parse(String(data || ''));\n\t\t\t\tif (!parsedDatabase || typeof parsedDatabase !== 'object' || Array.isArray(parsedDatabase)) {\n\t\t\t\t\tthrow new Error('Database root must be an object.');\n\t\t\t\t}\n\t\t\t} catch (error) {\n\t\t\t\tappendAuthAuditEvent({\n\t\t\t\t\taction: 'database_read_blocked',\n\t\t\t\t\treq,\n\t\t\t\t\tstatus: 'blocked',\n\t\t\t\t\treason: 'database_invalid_json',\n\t\t\t\t\tdetails: { tenantKey: storagePaths.tenantKey },\n\t\t\t\t});\n\t\t\t\tres.status(503).json({\n\t\t\t\t\terror: 'Tenant data is unavailable because the stored database failed integrity validation. No empty replacement was created.',\n\t\t\t\t\ttenantKey: storagePaths.tenantKey,\n\t\t\t\t});\n\t\t\t\treturn;\n\t\t\t}\n\t\t\tlet responsePayload = JSON.stringify(parsedDatabase);\n\t\t\tconst role = String(req.auth?.role || '').trim().toLowerCase();`;

  if (source.includes(occurrenceReadAnchor)) {
    source = source.slice(0, readIndex) + source.slice(readIndex).replace(occurrenceReadAnchor, occurrenceAwareReplacement);
  } else {
    source = source.slice(0, readIndex) + source.slice(readIndex).replace(legacyReadAnchor, legacyReplacement);
  }

  const swimmerRawParse = `\t\t\t\ttry {\n\t\t\t\t\tconst parsed = JSON.parse(String(data || '{}'));\n\t\t\t\t\tconst swimmers = Array.isArray(parsed?.swimmers) ? parsed.swimmers : [];`;
  const swimmerResponseParse = `\t\t\t\ttry {\n\t\t\t\t\tconst parsed = JSON.parse(String(responsePayload || '{}'));\n\t\t\t\t\tconst swimmers = Array.isArray(parsed?.swimmers) ? parsed.swimmers : [];`;
  const swimmerParsed = `\t\t\t\ttry {\n\t\t\t\t\tconst parsed = typeof readFiltered !== 'undefined' ? readFiltered.dbShape : parsedDatabase;\n\t\t\t\t\tconst swimmers = Array.isArray(parsed?.swimmers) ? parsed.swimmers : [];`;
  if (source.includes(swimmerResponseParse)) source = source.replace(swimmerResponseParse, swimmerParsed);
  else if (source.includes(swimmerRawParse)) source = source.replace(swimmerRawParse, swimmerParsed);
  else throw new Error('GET /db swimmer parse anchor was not found.');

  const unsafeSwimmerCatch = `\t\t\t\t} catch {\n\t\t\t\t\tresponsePayload = JSON.stringify({ swimmers: [] });\n\t\t\t\t}`;
  const safeSwimmerCatch = `\t\t\t\t} catch (error) {\n\t\t\t\t\tappendAuthAuditEvent({ action: 'database_read_blocked', req, status: 'blocked', reason: 'swimmer_scope_filter_failed', details: { tenantKey: storagePaths.tenantKey } });\n\t\t\t\t\tres.status(503).json({ error: 'Swimmer data could not be safely scoped. No empty result was substituted.' });\n\t\t\t\t\treturn;\n\t\t\t\t}`;
  if (!source.includes(unsafeSwimmerCatch)) throw new Error('GET /db swimmer empty-fallback anchor was not found.');
  source = source.replace(unsafeSwimmerCatch, safeSwimmerCatch);
}

const ownershipMarker = '// ATHLYRAX_OWNERSHIP_SUMMARY_STRICT_DB_READ';
if (!source.includes(ownershipMarker)) {
  const anchor = `\t\tconst storagePaths = resolveStoragePathsForAuth(req.auth);\n\t\tensureStorageLayout(storagePaths);\n\t\tconst dbShape = readJsonFile(storagePaths.dbPath);\n\t\tconst summary = buildOwnershipSummary(dbShape);`;
  const replacement = `\t\tconst storagePaths = resolveStoragePathsForAuth(req.auth);\n\t\t${ownershipMarker}\n\t\tif (!fs.existsSync(storagePaths.dbPath)) {\n\t\t\tres.status(503).json({ error: 'Tenant database is missing. No empty replacement was created.' });\n\t\t\treturn;\n\t\t}\n\t\tlet dbShape;\n\t\ttry {\n\t\t\tdbShape = JSON.parse(fs.readFileSync(storagePaths.dbPath, 'utf8'));\n\t\t\tif (!dbShape || typeof dbShape !== 'object' || Array.isArray(dbShape)) throw new Error('Database root must be an object.');\n\t\t} catch {\n\t\t\tres.status(503).json({ error: 'Tenant database failed integrity validation.' });\n\t\t\treturn;\n\t\t}\n\t\tconst summary = buildOwnershipSummary(dbShape);`;
  if (!source.includes(anchor)) throw new Error('Ownership summary database-read anchor was not found.');
  source = source.replace(anchor, replacement);
}

const releaseMarker = 'ATHLYRAX_DEMO_RECOVERY_RELEASE_2026_08_08_V1';
if (!source.includes(releaseMarker)) {
  const configAnchor = `\t\tassetId: BACKEND_ASSET_ID,\n\t});`;
  const configReplacement = `\t\tassetId: BACKEND_ASSET_ID,\n\t\treleaseMarker: '${releaseMarker}',\n\t});`;
  if (!source.includes(configAnchor)) throw new Error('Auth config release-marker anchor was not found.');
  source = source.replace(configAnchor, configReplacement);
}

for (const token of [
  'ATHLYRAX_RUNTIME_DB_READ_FAIL_CLOSED',
  'database_invalid_json',
  'No empty replacement was created.',
  'No empty result was substituted.',
  'ATHLYRAX_OWNERSHIP_SUMMARY_STRICT_DB_READ',
  'ATHLYRAX_DEMO_RECOVERY_RELEASE_2026_08_08_V1',
]) if (!source.includes(token)) throw new Error(`Runtime database read hardening missing: ${token}`);

fs.writeFileSync(indexPath, source, 'utf8');
console.log('RUNTIME_DB_READ_INTEGRITY_OK');
