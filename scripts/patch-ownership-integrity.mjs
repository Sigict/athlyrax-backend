import fs from 'node:fs';
import path from 'node:path';

const indexPath = path.resolve('index.js');
let source = fs.readFileSync(indexPath, 'utf8').replace(/\r\n/g, '\n');

function replaceRequired(needle, replacement, label) {
  if (source.includes(replacement)) return;
  if (!source.includes(needle)) throw new Error(`${label} anchor was not found.`);
  source = source.replace(needle, replacement);
}

// Keep the ownership/cross-tenant guard aligned with every persisted collection
// that can contain tenant-owned competition data.
replaceRequired(
  `\t'tests',\n\t'fixtures',\n\t'seasons',`,
  `\t'tests',\n\t'competitions',\n\t'fixtures',\n\t'groups',\n\t'seasons',`,
  'Ownership collection coverage',
);

// Existing attribution is authoritative server state. A full-database PUT must
// not be able to replace createdByUserId/createdAt merely by echoing modified
// client fields for an existing row ID.
const oldIndexFunction = `function buildExistingDbRowIdIndex(dbShape) {\n\tconst index = new Map();\n\tfor (const key of OWNERSHIP_TRACKED_COLLECTION_KEYS) {\n\t\tconst rows = Array.isArray(dbShape?.[key]) ? dbShape[key] : [];\n\t\tconst rowIds = new Set();\n\t\tfor (const row of rows) {\n\t\t\tconst rowId = toRowId(row?.id);\n\t\t\tif (rowId) rowIds.add(rowId);\n\t\t}\n\t\tindex.set(key, rowIds);\n\t}\n\treturn index;\n}`;
const newIndexFunction = `function buildExistingDbRowIndex(dbShape) {\n\t// ATHLYRAX_SERVER_AUTHORITATIVE_OWNERSHIP_METADATA\n\tconst index = new Map();\n\tfor (const key of OWNERSHIP_TRACKED_COLLECTION_KEYS) {\n\t\tconst rows = Array.isArray(dbShape?.[key]) ? dbShape[key] : [];\n\t\tconst rowIndex = new Map();\n\t\tfor (const row of rows) {\n\t\t\tconst rowId = toRowId(row?.id);\n\t\t\tif (rowId && !rowIndex.has(rowId)) rowIndex.set(rowId, row);\n\t\t}\n\t\tindex.set(key, rowIndex);\n\t}\n\treturn index;\n}`;
replaceRequired(oldIndexFunction, newIndexFunction, 'Existing row ownership index');
replaceRequired(
  `\tconst existingRowIdIndex = buildExistingDbRowIdIndex(existingDbShape);`,
  `\tconst existingRowIndex = buildExistingDbRowIndex(existingDbShape);`,
  'Ownership index use',
);
replaceRequired(
  `\t\tconst existingIds = existingRowIdIndex.get(key) || new Set();\n\t\tnextShape[key] = rows.map((row) => {\n\t\t\tif (!row || typeof row !== 'object' || Array.isArray(row)) return row;\n\t\t\tconst rowId = toRowId(row?.id);\n\t\t\tconst isExistingRow = Boolean(rowId && existingIds.has(rowId));\n\t\t\tconst existingCreatedBy = String(row?.createdByUserId || '').trim().toLowerCase();\n\t\t\tconst createdByUserId = existingCreatedBy\n\t\t\t\t|| (isExistingRow ? 'legacy-unattributed' : actorUsername);`,
  `\t\tconst persistedRows = existingRowIndex.get(key) || new Map();\n\t\tnextShape[key] = rows.map((row) => {\n\t\t\tif (!row || typeof row !== 'object' || Array.isArray(row)) return row;\n\t\t\tconst rowId = toRowId(row?.id);\n\t\t\tconst persistedRow = rowId ? persistedRows.get(rowId) : null;\n\t\t\tconst isExistingRow = Boolean(persistedRow);\n\t\t\tconst persistedCreatedBy = String(persistedRow?.createdByUserId || '').trim().toLowerCase();\n\t\t\tconst incomingCreatedBy = String(row?.createdByUserId || '').trim().toLowerCase();\n\t\t\tconst createdByUserId = isExistingRow\n\t\t\t\t? (persistedCreatedBy || 'legacy-unattributed')\n\t\t\t\t: (incomingCreatedBy || actorUsername);`,
  'Server-authoritative createdBy metadata',
);
replaceRequired(
  `\t\t\t\tcreatedAt: String(row?.createdAt || nowIsoValue).trim() || nowIsoValue,`,
  `\t\t\t\tcreatedAt: String((isExistingRow ? persistedRow?.createdAt : row?.createdAt) || nowIsoValue).trim() || nowIsoValue,`,
  'Server-authoritative createdAt metadata',
);

// Backfilling legacy ownership changes provenance for many rows and is an admin
// operation, not an ordinary assistant-coach write.
replaceRequired(
  `app.post('/db/ownership-backfill', requireAuth, requireWriteRole, requireBillingWriteAccess, (req, res) => {`,
  `app.post('/db/ownership-backfill', requireAuth, requireAdminRole, requireBillingWriteAccess, (req, res) => {`,
  'Ownership backfill admin authorization',
);

for (const token of [
  'ATHLYRAX_SERVER_AUTHORITATIVE_OWNERSHIP_METADATA',
  `'competitions'`,
  `'groups'`,
  `app.post('/db/ownership-backfill', requireAuth, requireAdminRole, requireBillingWriteAccess`,
]) if (!source.includes(token)) throw new Error(`Ownership integrity token is missing: ${token}`);

if (source.includes('buildExistingDbRowIdIndex(')) throw new Error('Legacy ID-only ownership index remains.');

fs.writeFileSync(indexPath, source, 'utf8');
console.log('OWNERSHIP_INTEGRITY_PATCH_OK');
