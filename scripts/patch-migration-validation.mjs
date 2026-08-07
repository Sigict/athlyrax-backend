import fs from 'node:fs';
import path from 'node:path';

function patchMigration() {
  const filePath = path.resolve('scripts/migrate-storage-once.mjs');
  let source = fs.readFileSync(filePath, 'utf8').replace(/\r\n/g, '\n');
  const importAnchor = `import { sanitizeDemoTenantDatabase } from './demo-data-sanitizer.mjs';`;
  const imports = `${importAnchor}\nimport { validateAuthStoreSemanticIntegrity } from './auth-store-integrity.mjs';\nimport { validateTenantDatabaseSemanticIntegrity } from './tenant-db-integrity.mjs';`;
  if (!source.includes(`validateAuthStoreSemanticIntegrity`)) {
    if (!source.includes(importAnchor)) throw new Error('Migration semantic import anchor was not found.');
    source = source.replace(importAnchor, imports);
  }
  const verifyAnchor = `  const verifiedFiles = [`;
  const semanticBlock = `  // ATHLYRAX_MIGRATION_SEMANTIC_VALIDATION\n  const semanticFailures = [\n    ...validateAuthStoreSemanticIntegrity(configuration, process.env, fs),\n    ...validateTenantDatabaseSemanticIntegrity(configuration, process.env, fs),\n  ];\n  if (semanticFailures.length > 0) throw new Error(semanticFailures.join('\\n'));\n\n${verifyAnchor}`;
  if (!source.includes('// ATHLYRAX_MIGRATION_SEMANTIC_VALIDATION')) {
    if (!source.includes(verifyAnchor)) throw new Error('Migration semantic validation anchor was not found.');
    source = source.replace(verifyAnchor, semanticBlock);
  }
  for (const token of ['ATHLYRAX_MIGRATION_SEMANTIC_VALIDATION', 'validateAuthStoreSemanticIntegrity(configuration', 'validateTenantDatabaseSemanticIntegrity(configuration']) {
    if (!source.includes(token)) throw new Error(`Migration semantic validation is missing ${token}.`);
  }
  fs.writeFileSync(filePath, source, 'utf8');
}

function patchApproval() {
  const filePath = path.resolve('scripts/approve-storage-layout.mjs');
  let source = fs.readFileSync(filePath, 'utf8').replace(/\r\n/g, '\n');
  const importAnchor = `import { canonicalStoragePaths } from './storage-path-contract.mjs';`;
  const imports = `${importAnchor}\nimport { validateAuthStoreSemanticIntegrity } from './auth-store-integrity.mjs';\nimport { validateTenantDatabaseSemanticIntegrity } from './tenant-db-integrity.mjs';`;
  if (!source.includes(`validateAuthStoreSemanticIntegrity`)) {
    if (!source.includes(importAnchor)) throw new Error('Approval semantic import anchor was not found.');
    source = source.replace(importAnchor, imports);
  }
  const markerAnchor = `  const markerPath = writeStorageReadyMarker(storageRoot, { requiredTenants, verifiedFiles: verified });`;
  const semanticBlock = `  // ATHLYRAX_APPROVAL_SEMANTIC_VALIDATION\n  const semanticFailures = [\n    ...validateAuthStoreSemanticIntegrity(configuration, process.env, fs),\n    ...validateTenantDatabaseSemanticIntegrity(configuration, process.env, fs),\n  ];\n  if (semanticFailures.length > 0) throw new Error(semanticFailures.join('\\n'));\n\n${markerAnchor}`;
  if (!source.includes('// ATHLYRAX_APPROVAL_SEMANTIC_VALIDATION')) {
    if (!source.includes(markerAnchor)) throw new Error('Approval semantic validation anchor was not found.');
    source = source.replace(markerAnchor, semanticBlock);
  }
  fs.writeFileSync(filePath, source, 'utf8');
}

patchMigration();
patchApproval();
console.log('MIGRATION_SEMANTIC_VALIDATION_PATCH_OK');
