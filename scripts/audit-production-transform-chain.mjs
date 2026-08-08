import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(process.cwd());
const failures = [];
const read = (relative) => {
  const filePath = path.join(root, relative);
  if (!fs.existsSync(filePath)) {
    failures.push(`Missing required file: ${relative}`);
    return '';
  }
  return fs.readFileSync(filePath, 'utf8');
};

const expectedTransforms = [
  'scripts/patch-data-safety-coverage.mjs',
  'scripts/patch-storage-recovery-semantics.mjs',
  'scripts/patch-index-signup-legal.mjs',
  'scripts/patch-logout-csrf.mjs',
  'scripts/patch-canonical-storage-contract.mjs',
  'scripts/patch-persistence-integrity.mjs',
  'scripts/patch-durable-storage-writes.mjs',
  'scripts/patch-operational-integrity.mjs',
  'scripts/patch-runtime-data-retention.mjs',
  'scripts/patch-revision-integrity.mjs',
  'scripts/patch-auth-tenant-integrity.mjs',
  'scripts/patch-migration-validation.mjs',
  'scripts/patch-runtime-auth-billing-safety.mjs',
  'scripts/patch-auth-persistence-transaction.mjs',
  'scripts/patch-runtime-identity-event-safety.mjs',
  'scripts/patch-ownership-integrity.mjs',
  'scripts/patch-orphan-tenant-safety.mjs',
  'scripts/patch-billing-catalog-integrity.mjs',
  'scripts/patch-account-lifecycle-integrity.mjs',
  'scripts/patch-auth-enumeration-safety.mjs',
  'scripts/patch-coach-link-suite.mjs',
  'scripts/patch-production-error-redaction.mjs',
  'scripts/patch-production-cors-origins.mjs',
  'scripts/patch-runtime-db-read-integrity.mjs',
];

const expectedCoachLinkSteps = [
  'scripts/patch-swimmer-coach-authority.mjs',
  'scripts/patch-parent-notification-semantics.mjs',
  'scripts/patch-coach-link-workflow.mjs',
  'scripts/patch-coach-link-lifecycle.mjs',
  'scripts/patch-coach-link-integrity.mjs',
  'scripts/patch-coach-link-ownership.mjs',
  'scripts/patch-coach-link-routing.mjs',
  'scripts/patch-coach-link-reconnect.mjs',
  'scripts/patch-coach-link-transaction-integrity.mjs',
  'scripts/patch-coach-link-rollback-safety.mjs',
];

for (const relative of expectedTransforms) read(relative);
for (const relative of expectedCoachLinkSteps) read(relative);
for (const relative of [
  'tests/data-safety-rollback.test.mjs',
  'tests/storage-recovery-preflight.test.mjs',
  'tests/stage-storage-restore.test.mjs',
  'tests/auth-persistence-transaction.test.mjs',
  'tests/auth-enumeration-safety.test.mjs',
  'tests/coach-link-transaction.test.mjs',
]) read(relative);

const build = read('scripts/build-production-backend.mjs');
const transformArrayMatch = build.match(/const transforms = \[([\s\S]*?)\n\];/);
if (!transformArrayMatch) failures.push('scripts/build-production-backend.mjs: transforms array could not be parsed.');
else {
  const actualTransforms = Array.from(transformArrayMatch[1].matchAll(/'([^']+\.mjs)'/g), (match) => match[1]);
  if (JSON.stringify(actualTransforms) !== JSON.stringify(expectedTransforms)) failures.push(`scripts/build-production-backend.mjs: production transform order mismatch. Expected ${JSON.stringify(expectedTransforms)} but found ${JSON.stringify(actualTransforms)}.`);
  if (new Set(actualTransforms).size !== actualTransforms.length) failures.push('scripts/build-production-backend.mjs: duplicate production transform exists.');
  for (const internalStep of expectedCoachLinkSteps) if (actualTransforms.includes(internalStep)) failures.push(`scripts/build-production-backend.mjs: coach-link internal step leaked back into top-level transform chain: ${internalStep}`);
}

const coachSuite = read('scripts/patch-coach-link-suite.mjs');
const coachStepArrayMatch = coachSuite.match(/const steps = \[([\s\S]*?)\n\];/);
if (!coachStepArrayMatch) failures.push('scripts/patch-coach-link-suite.mjs: internal step array could not be parsed.');
else {
  const actualCoachSteps = Array.from(coachStepArrayMatch[1].matchAll(/'([^']+\.mjs)'/g), (match) => match[1]);
  if (JSON.stringify(actualCoachSteps) !== JSON.stringify(expectedCoachLinkSteps)) failures.push(`scripts/patch-coach-link-suite.mjs: internal coach-link order mismatch. Expected ${JSON.stringify(expectedCoachLinkSteps)} but found ${JSON.stringify(actualCoachSteps)}.`);
  if (new Set(actualCoachSteps).size !== actualCoachSteps.length) failures.push('scripts/patch-coach-link-suite.mjs: duplicate internal coach-link step exists.');
}
for (const token of [
  'ATHLYRAX_COACH_LINK_SUITE_V1',
  'ATHLYRAX_SWIMMER_PROFILE_SYNC_COACH_LINK_NON_AUTHORITATIVE',
  'ATHLYRAX_PARENT_NOTIFICATION_ONLY',
  'ATHLYRAX_COACH_LINK_TRANSACTIONAL_COMMIT_V1',
  'ATHLYRAX_COACH_LINK_REVISION_SAFE_ROLLBACK',
  'ATHLYRAX_COACH_LINK_SUITE_OK',
]) if (!coachSuite.includes(token)) failures.push(`scripts/patch-coach-link-suite.mjs: missing suite verification token ${token}`);

for (const required of [
  "run('storage/path audit', ['scripts/audit-storage-paths.mjs']);",
  "run('production transform-chain audit', ['scripts/audit-production-transform-chain.mjs']);",
  "run(`${relative} syntax check`, ['--check', relative]);",
  'ATHLYRAX_PRODUCTION_BACKEND_BUILD_OK',
]) if (!build.includes(required)) failures.push(`scripts/build-production-backend.mjs: missing build guard ${required}`);

const transformedIndex = read('index.js');
for (const marker of [
  'ATHLYRAX_AUTH_PAIRED_PERSISTENCE_TRANSACTION',
  'ATHLYRAX_PASSWORD_RESET_ENUMERATION_SAFE',
  'ATHLYRAX_PASSWORD_RESET_ACCOUNT_ATTEMPT_LIMIT',
  'ATHLYRAX_PRODUCTION_DEFAULT_AUTH_USERS_DISABLED',
  'const DEFAULT_AUTH_USERS = IS_PRODUCTION ? [] : [',
  'ATHLYRAX_AUTH_IDENTIFIER_AMBIGUITY_SAFE',
  'ATHLYRAX_SNAPSHOT_AUTH_IDENTIFIER_AMBIGUITY_SAFE',
  'ATHLYRAX_SNAPSHOT_LOGIN_IDENTIFIER_AMBIGUITY_SAFE',
  'ATHLYRAX_SNAPSHOT_RESET_CONFIRM_IDENTIFIER_AMBIGUITY_SAFE',
  'ATHLYRAX_FIRST_MATCH_IDENTIFIER_HELPER_REMOVED',
  'ATHLYRAX_ONBOARDING_EMAIL_UNIQUE',
  'ATHLYRAX_GLOBAL_OWNER_ROLE_TENANT_CONTRACT',
  'ATHLYRAX_INVITE_GLOBAL_OWNER_FORBIDDEN',
  'ATHLYRAX_PRODUCTION_ERROR_DETAILS_REDACTED',
  'ATHLYRAX_PRODUCTION_CORS_FRONTEND_ORIGINS',
  'ATHLYRAX_SWIMMER_PROFILE_SYNC_COACH_LINK_NON_AUTHORITATIVE',
  'ATHLYRAX_COACH_LINK_WORKFLOW_V1',
  'ATHLYRAX_COACH_LINK_LIFECYCLE_V1',
  'ATHLYRAX_COACH_LINK_INTEGRITY_V1',
  'ATHLYRAX_COACH_LINK_TENANT_OWNERSHIP_V1',
  'ATHLYRAX_COACH_LINK_UNAMBIGUOUS_ROUTING_V1',
  'ATHLYRAX_COACH_LINK_RECONNECT_V1',
  'ATHLYRAX_COACH_LINK_TRANSACTIONAL_COMMIT_V1',
  'ATHLYRAX_COACH_LINK_REVISION_SAFE_ROLLBACK',
  'ATHLYRAX_COACH_LINK_DISTINCT_SOURCE_TARGET',
  'ATHLYRAX_COACH_LINK_REQUESTS_HIDDEN_FROM_GENERIC_DB',
  'ATHLYRAX_COACH_LINK_REQUESTS_PRESERVED_ON_GENERIC_DB_WRITE',
]) if (!transformedIndex.includes(marker)) failures.push(`index.js: missing transformed production marker ${marker}`);
for (const forbidden of [
  'ATHLYRAX_ONBOARDING_EMAIL_UNIQUENESS',
  'function findAuthUserByIdentifier(',
  'ATHLYRAX_PRODUCTION_AUDIT_RETENTION_NO_SILENT_DELETE',
  'ATHLYRAX_PRODUCTION_DB_SNAPSHOT_RETENTION_NO_SILENT_DELETE',
]) if (transformedIndex.includes(forbidden)) failures.push(`index.js: forbidden obsolete/duplicate runtime token remains: ${forbidden}`);
if (!transformedIndex.includes(': (IS_PRODUCTION ? [] : DEFAULT_ALLOWED_ORIGINS)')) failures.push('index.js: production CORS still lacks production-only default-origin separation.');

const dataSafety = read('scripts/data-safety-preload.mjs');
for (const token of [
  'runWithDatabaseRollbackAuthorization',
  'rollbackContext',
  'ATHLYRAX_DB_ROLLBACK_AUTHORIZATION_MISMATCH',
  "rollbackAuthorized ? 'pre-authorized-rollback' : 'pre-write'",
]) if (!dataSafety.includes(token)) failures.push(`scripts/data-safety-preload.mjs: missing rollback safety token ${token}`);
const dataSafetyCoverage = read('scripts/patch-data-safety-coverage.mjs');
if (!dataSafetyCoverage.includes('if (!rollbackAuthorized) {')) failures.push('scripts/patch-data-safety-coverage.mjs: catastrophic shrink/wipe checks are not rollback-context aware.');

const storageRecovery = read('scripts/patch-storage-recovery-semantics.mjs');
for (const token of ['ATHLYRAX_AUTH_RECOVERY_BACKUP_PREFLIGHT','Refusing to mutate canonical auth state']) if (!storageRecovery.includes(token)) failures.push(`scripts/patch-storage-recovery-semantics.mjs: missing ${token}`);
const restoreStage = read('scripts/stage-storage-restore.mjs');
if (!restoreStage.includes('ATHLYRAX_RESTORE_PREFLIGHT_BEFORE_WRITE')) failures.push('scripts/stage-storage-restore.mjs: all-source preflight marker missing.');

const safeStart = read('scripts/safe-start.mjs');
if (safeStart.includes('installSignupLegalAcceptanceGuard')) failures.push('scripts/safe-start.mjs: duplicate signup legal guard owner returned.');
const signupPatch = read('scripts/patch-index-signup-legal.mjs');
if (!signupPatch.includes('installSignupLegalAcceptanceGuard(express);')) failures.push('scripts/patch-index-signup-legal.mjs: sole signup legal guard owner missing.');

const operationalPatch = read('scripts/patch-operational-integrity.mjs');
for (const token of ['ATHLYRAX_GLOBAL_OWNER_ROLE_TENANT_CONTRACT','ATHLYRAX_INVITE_GLOBAL_OWNER_FORBIDDEN']) if (!operationalPatch.includes(token)) failures.push(`scripts/patch-operational-integrity.mjs: missing final tenant contract ${token}`);
for (const token of ['ATHLYRAX_PRODUCTION_AUDIT_RETENTION_NO_SILENT_DELETE','ATHLYRAX_PRODUCTION_DB_SNAPSHOT_RETENTION_NO_SILENT_DELETE']) if (operationalPatch.includes(token)) failures.push(`scripts/patch-operational-integrity.mjs: temporary retention ownership returned: ${token}`);

const retentionPatch = read('scripts/patch-runtime-data-retention.mjs');
for (const token of ['ATHLYRAX_PRODUCTION_AUDIT_ARCHIVE_BEFORE_DELETE','ATHLYRAX_BOUNDED_PRIMARY_DB_SNAPSHOT_RETENTION']) if (!retentionPatch.includes(token)) failures.push(`scripts/patch-runtime-data-retention.mjs: missing final retention token ${token}`);

const authTenantPatch = read('scripts/patch-auth-tenant-integrity.mjs');
if (authTenantPatch.includes('function replaceRequired(')) failures.push('scripts/patch-auth-tenant-integrity.mjs: staged creation/invite rewrites returned; tenant creation contracts must have one owner.');
if (!authTenantPatch.includes('ATHLYRAX_ROLE_TENANT_COMPATIBILITY')) failures.push('scripts/patch-auth-tenant-integrity.mjs: role tenant compatibility guard missing.');

const authPersistencePatch = read('scripts/patch-auth-persistence-transaction.mjs');
for (const token of ['ATHLYRAX_AUTH_PAIRED_PERSISTENCE_TRANSACTION','writeAtomicJsonFile(AUTH_USERS_BACKUP_PATH, payload);','writeAtomicJsonFile(AUTH_USERS_PATH, payload);','Authentication primary/backup verification failed after persistence.','restorePrevious(AUTH_USERS_PATH','restorePrevious(AUTH_USERS_BACKUP_PATH','rollback was incomplete']) if (!authPersistencePatch.includes(token)) failures.push(`scripts/patch-auth-persistence-transaction.mjs: missing required token ${token}`);

const authEnumerationPatch = read('scripts/patch-auth-enumeration-safety.mjs');
for (const token of [
  'ATHLYRAX_PASSWORD_RESET_ENUMERATION_SAFE','ATHLYRAX_PASSWORD_RESET_ACCOUNT_ATTEMPT_LIMIT','resetEntry.failedAttempts >= 5',
  'ATHLYRAX_PRODUCTION_DEFAULT_AUTH_USERS_DISABLED','const DEFAULT_AUTH_USERS = IS_PRODUCTION ? [] : [',
  'ATHLYRAX_PASSWORD_RESET_REQUEST_GENERIC_FAILURE_RESPONSE','ATHLYRAX_SNAPSHOT_PASSWORD_RESET_REQUEST_GENERIC_FAILURE_RESPONSE','ATHLYRAX_PASSWORD_RESET_CONFIRM_GENERIC_UNKNOWN_ACCOUNT',
  'ATHLYRAX_AUTH_IDENTIFIER_AMBIGUITY_SAFE','ATHLYRAX_SNAPSHOT_AUTH_IDENTIFIER_AMBIGUITY_SAFE','ATHLYRAX_SNAPSHOT_LOGIN_IDENTIFIER_AMBIGUITY_SAFE','ATHLYRAX_SNAPSHOT_RESET_CONFIRM_IDENTIFIER_AMBIGUITY_SAFE',
  'ATHLYRAX_FIRST_MATCH_IDENTIFIER_HELPER_REMOVED','ATHLYRAX_ONBOARDING_EMAIL_UNIQUE','resolveLoginUserByIdentifier(identifier)',
]) if (!authEnumerationPatch.includes(token)) failures.push(`scripts/patch-auth-enumeration-safety.mjs: missing required token ${token}`);
if (authEnumerationPatch.includes('ATHLYRAX_ONBOARDING_EMAIL_UNIQUENESS')) failures.push('scripts/patch-auth-enumeration-safety.mjs: duplicate onboarding email guard logic returned.');

const redactionPatch = read('scripts/patch-production-error-redaction.mjs');
for (const token of ['ATHLYRAX_PRODUCTION_ERROR_DETAILS_REDACTED','IS_PRODUCTION ? {}','Raw exception detail response remains']) if (!redactionPatch.includes(token)) failures.push(`scripts/patch-production-error-redaction.mjs: missing ${token}`);
const corsPatch = read('scripts/patch-production-cors-origins.mjs');
for (const token of [': (IS_PRODUCTION ? [] : DEFAULT_ALLOWED_ORIGINS)',"origin === '*'",'parsed.origin !== origin','return new Set(origins);']) if (!corsPatch.includes(token)) failures.push(`scripts/patch-production-cors-origins.mjs: missing ${token}`);

const coachTransactionPatch = read('scripts/patch-coach-link-transaction-integrity.mjs');
for (const token of ['ATHLYRAX_COACH_LINK_DISTINCT_SOURCE_TARGET','ATHLYRAX_COACH_LINK_ACCEPT_DB_FIRST_AUTH_LAST','ATHLYRAX_COACH_LINK_REJECT_ROLLBACK_TARGET','ATHLYRAX_COACH_LINK_DISCONNECT_DB_FIRST_AUTH_LAST','database rollback was incomplete']) if (!coachTransactionPatch.includes(token)) failures.push(`scripts/patch-coach-link-transaction-integrity.mjs: missing required token ${token}`);
const coachRollbackPatch = read('scripts/patch-coach-link-rollback-safety.mjs');
for (const token of ['ATHLYRAX_COACH_LINK_REVISION_SAFE_ROLLBACK','runWithDatabaseRollbackAuthorization','writeCoachLinkRollbackDb(targetPaths, targetDb)','writeCoachLinkRollbackDb(sourcePaths, sourceDb)','writeCoachLinkRollbackDb(currentPaths, currentDb)','writeCoachLinkRollbackDb(pendingTargetPaths, pendingTargetRollback)']) if (!coachRollbackPatch.includes(token)) failures.push(`scripts/patch-coach-link-rollback-safety.mjs: missing ${token}`);

const pkg = JSON.parse(read('package.json') || '{}');
const postinstall = String(pkg?.scripts?.postinstall || '');
const start = String(pkg?.scripts?.start || '');
const storageAudit = String(pkg?.scripts?.['audit:storage-paths'] || '');
const storageAll = String(pkg?.scripts?.['test:storage-all'] || '');
const securityVerify = String(pkg?.scripts?.['verify:closed-pilot-security'] || '');
const coachLinkTestCommand = String(pkg?.scripts?.['test:coach-link-workflow'] || '');
const dataSafetyTestCommand = String(pkg?.scripts?.['test:data-safety'] || '');
const backupRestoreTestCommand = String(pkg?.scripts?.['test:closed-pilot-backup-restore'] || '');
if (postinstall !== 'node scripts/build-production-backend.mjs') failures.push('package.json: postinstall is not the verified production build orchestrator.');
if (!start.includes('test:storage-all') || !start.includes('production-start.mjs')) failures.push('package.json: production start is not gated by the full test suite.');
if (!storageAudit.includes('audit-storage-paths.mjs') || !storageAudit.includes('audit-production-transform-chain.mjs')) failures.push('package.json: audit:storage-paths must run both storage and transform-chain audits.');
if (!coachLinkTestCommand.includes('tests/coach-link-workflow.test.mjs') || !coachLinkTestCommand.includes('tests/coach-link-transaction.test.mjs')) failures.push('package.json: test:coach-link-workflow must run both workflow and transaction regressions.');
if (!dataSafetyTestCommand.includes('tests/data-safety-rollback.test.mjs')) failures.push('package.json: test:data-safety must execute the authorized rollback regression.');
if (!backupRestoreTestCommand.includes('tests/stage-storage-restore.test.mjs')) failures.push('package.json: backup/restore suite must execute restore staging preflight regression.');
for (const requiredTest of ['test:storage-safety','test:data-safety','test:persistence-integrity','test:auth-persistence-transaction','test:auth-enumeration-safety','test:storage-routing-safety','test:storage-migration-identity','test:storage-recovery-preflight','test:storage-extra-invariants','test:startup-mutation-safety','test:storage-path-integrity','test:storage-path-contract','test:signup-legal-acceptance','test:runtime-hardening','test:billing-catalog-integrity','test:coach-link-workflow','test:closed-pilot-backup-restore','test:closed-pilot-security','audit:storage-paths']) if (!storageAll.includes(requiredTest)) failures.push(`package.json: test:storage-all missing ${requiredTest}`);
for (const requiredTest of ['test:data-safety','test:auth-persistence-transaction','test:auth-enumeration-safety','test:storage-recovery-preflight','test:coach-link-workflow','audit:storage-paths']) if (!securityVerify.includes(requiredTest)) failures.push(`package.json: verify:closed-pilot-security missing ${requiredTest}`);

if (failures.length) {
  console.error('ATHLYRAX_PRODUCTION_TRANSFORM_CHAIN_AUDIT_FAIL');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}
console.log('ATHLYRAX_PRODUCTION_TRANSFORM_CHAIN_AUDIT_OK');
