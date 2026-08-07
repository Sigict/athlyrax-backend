import fs from 'node:fs';
import path from 'node:path';

function patchMigration() {
  const filePath = path.resolve('scripts/migrate-storage-once.mjs');
  let source = fs.readFileSync(filePath, 'utf8').replace(/\r\n/g, '\n');
  const importAnchor = `import { sanitizeDemoTenantDatabase } from './demo-data-sanitizer.mjs';`;
  const imports = `${importAnchor}\nimport { validateAuthStoreSemanticIntegrity } from './auth-store-integrity.mjs';\nimport { validateInviteStoreSemanticIntegrity } from './invite-store-integrity.mjs';\nimport { validateTenantDatabaseSemanticIntegrity } from './tenant-db-integrity.mjs';`;
  if (!source.includes(`validateAuthStoreSemanticIntegrity`)) {
    if (!source.includes(importAnchor)) throw new Error('Migration semantic import anchor was not found.');
    source = source.replace(importAnchor, imports);
  } else if (!source.includes(`validateInviteStoreSemanticIntegrity`)) {
    const authImport = `import { validateAuthStoreSemanticIntegrity } from './auth-store-integrity.mjs';`;
    if (!source.includes(authImport)) throw new Error('Migration auth semantic import was not found.');
    source = source.replace(authImport, `${authImport}\nimport { validateInviteStoreSemanticIntegrity } from './invite-store-integrity.mjs';`);
  }
  const verifyAnchor = `  const verifiedFiles = [`;
  const oldSemantic = `  // ATHLYRAX_MIGRATION_SEMANTIC_VALIDATION\n  const semanticFailures = [\n    ...validateAuthStoreSemanticIntegrity(configuration, process.env, fs),\n    ...validateTenantDatabaseSemanticIntegrity(configuration, process.env, fs),\n  ];\n  if (semanticFailures.length > 0) throw new Error(semanticFailures.join('\\n'));\n\n${verifyAnchor}`;
  const semanticBlock = `  // ATHLYRAX_MIGRATION_SEMANTIC_VALIDATION\n  const semanticFailures = [\n    ...validateAuthStoreSemanticIntegrity(configuration, process.env, fs),\n    ...validateInviteStoreSemanticIntegrity(configuration, process.env, fs),\n    ...validateTenantDatabaseSemanticIntegrity(configuration, process.env, fs),\n  ];\n  if (semanticFailures.length > 0) throw new Error(semanticFailures.join('\\n'));\n\n${verifyAnchor}`;
  if (source.includes(oldSemantic)) source = source.replace(oldSemantic, semanticBlock);
  else if (!source.includes('// ATHLYRAX_MIGRATION_SEMANTIC_VALIDATION')) {
    if (!source.includes(verifyAnchor)) throw new Error('Migration semantic validation anchor was not found.');
    source = source.replace(verifyAnchor, semanticBlock);
  }
  for (const token of ['ATHLYRAX_MIGRATION_SEMANTIC_VALIDATION', 'validateAuthStoreSemanticIntegrity(configuration', 'validateInviteStoreSemanticIntegrity(configuration', 'validateTenantDatabaseSemanticIntegrity(configuration']) {
    if (!source.includes(token)) throw new Error(`Migration semantic validation is missing ${token}.`);
  }
  fs.writeFileSync(filePath, source, 'utf8');
}

function patchApproval() {
  const filePath = path.resolve('scripts/approve-storage-layout.mjs');
  let source = fs.readFileSync(filePath, 'utf8').replace(/\r\n/g, '\n');
  const importAnchor = `import { canonicalStoragePaths } from './storage-path-contract.mjs';`;
  const imports = `${importAnchor}\nimport { validateAuthStoreSemanticIntegrity } from './auth-store-integrity.mjs';\nimport { validateInviteStoreSemanticIntegrity } from './invite-store-integrity.mjs';\nimport { validateTenantDatabaseSemanticIntegrity } from './tenant-db-integrity.mjs';`;
  if (!source.includes(`validateAuthStoreSemanticIntegrity`)) {
    if (!source.includes(importAnchor)) throw new Error('Approval semantic import anchor was not found.');
    source = source.replace(importAnchor, imports);
  } else if (!source.includes(`validateInviteStoreSemanticIntegrity`)) {
    const authImport = `import { validateAuthStoreSemanticIntegrity } from './auth-store-integrity.mjs';`;
    if (!source.includes(authImport)) throw new Error('Approval auth semantic import was not found.');
    source = source.replace(authImport, `${authImport}\nimport { validateInviteStoreSemanticIntegrity } from './invite-store-integrity.mjs';`);
  }
  const markerAnchor = `  const markerPath = writeStorageReadyMarker(storageRoot, { requiredTenants, verifiedFiles: verified });`;
  const oldSemantic = `  // ATHLYRAX_APPROVAL_SEMANTIC_VALIDATION\n  const semanticFailures = [\n    ...validateAuthStoreSemanticIntegrity(configuration, process.env, fs),\n    ...validateTenantDatabaseSemanticIntegrity(configuration, process.env, fs),\n  ];\n  if (semanticFailures.length > 0) throw new Error(semanticFailures.join('\\n'));\n\n${markerAnchor}`;
  const semanticBlock = `  // ATHLYRAX_APPROVAL_SEMANTIC_VALIDATION\n  const semanticFailures = [\n    ...validateAuthStoreSemanticIntegrity(configuration, process.env, fs),\n    ...validateInviteStoreSemanticIntegrity(configuration, process.env, fs),\n    ...validateTenantDatabaseSemanticIntegrity(configuration, process.env, fs),\n  ];\n  if (semanticFailures.length > 0) throw new Error(semanticFailures.join('\\n'));\n\n${markerAnchor}`;
  if (source.includes(oldSemantic)) source = source.replace(oldSemantic, semanticBlock);
  else if (!source.includes('// ATHLYRAX_APPROVAL_SEMANTIC_VALIDATION')) {
    if (!source.includes(markerAnchor)) throw new Error('Approval semantic validation anchor was not found.');
    source = source.replace(markerAnchor, semanticBlock);
  }
  for (const token of ['ATHLYRAX_APPROVAL_SEMANTIC_VALIDATION', 'validateInviteStoreSemanticIntegrity(configuration']) {
    if (!source.includes(token)) throw new Error(`Approval semantic validation is missing ${token}.`);
  }
  fs.writeFileSync(filePath, source, 'utf8');
}

patchMigration();
patchApproval();
console.log('MIGRATION_SEMANTIC_VALIDATION_PATCH_OK');
