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
  'scripts/patch-auth-persistence-transaction.mjs',
  'scripts/patch-persistence-integrity.mjs',
  'scripts/patch-durable-storage-writes.mjs',
  'scripts/patch-operational-integrity.mjs',
  'scripts/patch-runtime-data-retention.mjs',
  'scripts/patch-revision-integrity.mjs',
  'scripts/patch-auth-tenant-integrity.mjs',
  'scripts/patch-migration-validation.mjs',
  'scripts/patch-runtime-auth-billing-safety.mjs',
  'scripts/patch-stripe-webhook-signature.mjs',
  'scripts/patch-runtime-identity-event-safety.mjs',
  'scripts/patch-ownership-integrity.mjs',
  'scripts/patch-orphan-tenant-safety.mjs',
  'scripts/patch-billing-catalog-integrity.mjs',
  'scripts/patch-account-lifecycle-integrity.mjs',
  'scripts/patch-auth-enumeration-safety.mjs',
  'scripts/patch-password-policy.mjs',
  'scripts/patch-snapshot-cookie-session.mjs',
  'scripts/patch-production-auth-token-redaction.mjs',
  'scripts/patch-coach-link-suite.mjs',
  'scripts/patch-client-ip-integrity.mjs',
  'scripts/patch-rate-limit-integrity.mjs',
  'scripts/patch-request-body-limits.mjs',
  'scripts/patch-production-error-redaction.mjs',
  'scripts/patch-production-cors-origins.mjs',
  'scripts/patch-runtime-db-read-integrity.mjs',
];

const expectedCoachLinkSteps = [
  'scripts/patch-swimmer-coach-authority.mjs',
  'scripts/patch-parent-notification-semantics.mjs',
  'scripts/patch-coach-link-workflow.mjs',
  'scripts/patch-coach-link-lifecycle.mjs',
  'scripts/patch-coach-link-rejection-stale-guard.mjs',
  'scripts/patch-coach-link-integrity.mjs',
  'scripts/patch-coach-link-ownership.mjs',
  'scripts/patch-coach-link-routing.mjs',
  'scripts/patch-coach-link-reconnect.mjs',
  'scripts/patch-coach-link-transaction-integrity.mjs',
];

for (const relative of expectedTransforms) read(relative);
for (const relative of expectedCoachLinkSteps) read(relative);
read('tests/auth-persistence-transaction.test.mjs');
read('tests/auth-enumeration-safety.test.mjs');
read('tests/snapshot-cookie-session.test.mjs');
read('tests/production-auth-token-redaction.test.mjs');
read('tests/coach-link-transaction.test.mjs');

const build = read('scripts/build-production-backend.mjs');
const transformArrayMatch = build.match(/const transforms = \[([\s\S]*?)\n\];/);
if (!transformArrayMatch) failures.push('scripts/build-production-backend.mjs: transforms array could not be parsed.');
else {
  const actualTransforms = Array.from(transformArrayMatch[1].matchAll(/'([^']+\.mjs)'/g), (match) => match[1]);
  if (JSON.stringify(actualTransforms) !== JSON.stringify(expectedTransforms)) failures.push(`scripts/build-production-backend.mjs: production transform order mismatch. Expected ${JSON.stringify(expectedTransforms)} but found ${JSON.stringify(actualTransforms)}.`);
  if (new Set(actualTransforms).size !== actualTransforms.length) failures.push('scripts/build-production-backend.mjs: duplicate production transform exists.');
  for (const internalStep of expectedCoachLinkSteps) if (actualTransforms.includes(internalStep)) failures.push(`scripts/build-production-backend.mjs: coach-link internal step leaked back into top-level transform chain: ${internalStep}`);
}
if (build.includes('operationalTransformAlreadyFinalized') || build.includes('OPERATIONAL_INTEGRITY_PATCH_ALREADY_FINALIZED')) {
  failures.push('scripts/build-production-backend.mjs: stale conditional transform-skip shortcut remains. Every transform must execute and prove idempotency.');
}

const coachSuite = read('scripts/patch-coach-link-suite.mjs');
const coachStepArrayMatch = coachSuite.match(/const steps = \[([\s\S]*?)\n\];/);
if (!coachStepArrayMatch) failures.push('scripts/patch-coach-link-suite.mjs: internal step array could not be parsed.');
else {
  const actualCoachSteps = Array.from(coachStepArrayMatch[1].matchAll(/'([^']+\.mjs)'/g), (match) => match[1]);
  if (JSON.stringify(actualCoachSteps) !== JSON.stringify(expectedCoachLinkSteps)) failures.push(`scripts/patch-coach-link-suite.mjs: internal coach-link order mismatch. Expected ${JSON.stringify(expectedCoachLinkSteps)} but found ${JSON.stringify(actualCoachSteps)}.`);
  if (new Set(actualCoachSteps).size !== actualCoachSteps.length) failures.push('scripts/patch-coach-link-suite.mjs: duplicate internal coach-link step exists.');
}
for (const token of ['ATHLYRAX_COACH_LINK_SUITE_V1','ATHLYRAX_SWIMMER_PROFILE_SYNC_COACH_LINK_NON_AUTHORITATIVE','ATHLYRAX_PARENT_NOTIFICATION_ONLY','ATHLYRAX_COACH_LINK_REJECTION_STALE_GUARD','ATHLYRAX_COACH_LINK_TRANSACTIONAL_COMMIT_V1','ATHLYRAX_COACH_LINK_SUITE_OK']) {
  if (!coachSuite.includes(token)) failures.push(`scripts/patch-coach-link-suite.mjs: missing suite verification token ${token}`);
}

for (const required of ["run('storage/path audit', ['scripts/audit-storage-paths.mjs']);","run('production transform-chain audit', ['scripts/audit-production-transform-chain.mjs']);","run(`${relative} syntax check`, ['--check', relative]);",'ATHLYRAX_PRODUCTION_BACKEND_BUILD_OK']) {
  if (!build.includes(required)) failures.push(`scripts/build-production-backend.mjs: missing build guard ${required}`);
}

const transformedIndex = read('index.js');
for (const marker of [
  'ATHLYRAX_AUTH_PAIRED_PERSISTENCE_TRANSACTION','ATHLYRAX_PASSWORD_RESET_ENUMERATION_SAFE','ATHLYRAX_PRODUCTION_DEFAULT_AUTH_USERS_DISABLED','const DEFAULT_AUTH_USERS = IS_PRODUCTION ? [] : [',
  'ATHLYRAX_AUTH_IDENTIFIER_AMBIGUITY_SAFE','ATHLYRAX_SNAPSHOT_AUTH_IDENTIFIER_AMBIGUITY_SAFE','ATHLYRAX_SNAPSHOT_LOGIN_IDENTIFIER_AMBIGUITY_SAFE','ATHLYRAX_SNAPSHOT_RESET_CONFIRM_IDENTIFIER_AMBIGUITY_SAFE',
  'ATHLYRAX_FIRST_MATCH_IDENTIFIER_HELPER_REMOVED','ATHLYRAX_ONBOARDING_EMAIL_UNIQUE','ATHLYRAX_GLOBAL_OWNER_ROLE_TENANT_CONTRACT','ATHLYRAX_INVITE_GLOBAL_OWNER_FORBIDDEN','ATHLYRAX_PASSWORD_MINIMUM_10','ATHLYRAX_SNAPSHOT_COOKIE_SESSION_V1','ATHLYRAX_PRODUCTION_AUTH_TOKEN_RESPONSE_REDACTED','ATHLYRAX_STRIPE_WEBHOOK_SIGNATURE_REQUIRED',
  'ATHLYRAX_PROXY_OBSERVED_CLIENT_IP','ATHLYRAX_LAYERED_AUTH_RATE_LIMIT','ATHLYRAX_ROUTE_SCOPED_JSON_BODY_LIMITS','ATHLYRAX_PRODUCTION_ERROR_DETAILS_REDACTED','ATHLYRAX_PRODUCTION_CORS_FRONTEND_ORIGINS',
  'ATHLYRAX_SWIMMER_PROFILE_SYNC_COACH_LINK_NON_AUTHORITATIVE','ATHLYRAX_COACH_LINK_WORKFLOW_V1','ATHLYRAX_COACH_LINK_LIFECYCLE_V1','ATHLYRAX_COACH_LINK_REJECTION_STALE_GUARD','ATHLYRAX_COACH_LINK_INTEGRITY_V1','ATHLYRAX_COACH_LINK_TENANT_OWNERSHIP_V1','ATHLYRAX_COACH_LINK_UNAMBIGUOUS_ROUTING_V1','ATHLYRAX_COACH_LINK_RECONNECT_V1','ATHLYRAX_COACH_LINK_TRANSACTIONAL_COMMIT_V1','ATHLYRAX_COACH_LINK_DISTINCT_SOURCE_TARGET','ATHLYRAX_COACH_LINK_REQUESTS_HIDDEN_FROM_GENERIC_DB','ATHLYRAX_COACH_LINK_REQUESTS_PRESERVED_ON_GENERIC_DB_WRITE',
]) if (!transformedIndex.includes(marker)) failures.push(`index.js: missing transformed production marker ${marker}`);
for (const forbidden of ['ATHLYRAX_ONBOARDING_EMAIL_UNIQUENESS','function findAuthUserByIdentifier(','ATHLYRAX_PRODUCTION_AUDIT_RETENTION_NO_SILENT_DELETE','ATHLYRAX_PRODUCTION_DB_SNAPSHOT_RETENTION_NO_SILENT_DELETE',"app.use(express.json({ limit: '25mb' }));","return forwarded.split(',')[0].trim();",'`identity:${clientKey}:${identifier}`','if (password.length < 8) {','if (nextPassword.length < 8) {','Password must be at least 8 characters.']) {
  if (transformedIndex.includes(forbidden)) failures.push(`index.js: forbidden obsolete/duplicate runtime token remains: ${forbidden}`);
}
if (!transformedIndex.includes(': (IS_PRODUCTION ? [] : DEFAULT_ALLOWED_ORIGINS)')) failures.push('index.js: production CORS still lacks production-only default-origin separation.');
if (!transformedIndex.includes('`identity:${identifier}`')) failures.push('index.js: identity authentication rate limit is not global across source IPs.');
if (!transformedIndex.includes('if (password.length < 10) {') || !transformedIndex.includes('if (nextPassword.length < 10) {') || !transformedIndex.includes('Password must be at least 10 characters.')) failures.push('index.js: production password minimum is not consistently 10 characters.');

const operationalPatch = read('scripts/patch-operational-integrity.mjs');
for (const token of ['ATHLYRAX_GLOBAL_OWNER_ROLE_TENANT_CONTRACT','ATHLYRAX_INVITE_GLOBAL_OWNER_FORBIDDEN']) if (!operationalPatch.includes(token)) failures.push(`scripts/patch-operational-integrity.mjs: missing final tenant contract ${token}`);

const retentionPatch = read('scripts/patch-runtime-data-retention.mjs');
for (const token of ['ATHLYRAX_PRODUCTION_AUDIT_ARCHIVE_BEFORE_DELETE','ATHLYRAX_BOUNDED_PRIMARY_DB_SNAPSHOT_RETENTION']) if (!retentionPatch.includes(token)) failures.push(`scripts/patch-runtime-data-retention.mjs: missing final retention token ${token}`);

const authTenantPatch = read('scripts/patch-auth-tenant-integrity.mjs');
if (authTenantPatch.includes('function replaceRequired(')) failures.push('scripts/patch-auth-tenant-integrity.mjs: staged creation/invite rewrites returned; tenant creation contracts must have one owner.');
if (!authTenantPatch.includes('ATHLYRAX_ROLE_TENANT_COMPATIBILITY')) failures.push('scripts/patch-auth-tenant-integrity.mjs: role tenant compatibility guard missing.');

const authPersistencePatch = read('scripts/patch-auth-persistence-transaction.mjs');
for (const token of ['ATHLYRAX_AUTH_PAIRED_PERSISTENCE_TRANSACTION','ATHLYRAX_AUTH_PERSISTENCE_SINGLE_OWNER','writeAtomicJsonFile(AUTH_USERS_BACKUP_PATH, payload);','writeAtomicJsonFile(AUTH_USERS_PATH, payload);','Authentication primary/backup verification failed after persistence.','restorePrevious(AUTH_USERS_PATH','restorePrevious(AUTH_USERS_BACKUP_PATH','rollback was incomplete']) {
  if (!authPersistencePatch.includes(token)) failures.push(`scripts/patch-auth-persistence-transaction.mjs: missing required token ${token}`);
}

const authEnumerationPatch = read('scripts/patch-auth-enumeration-safety.mjs');
for (const token of ['ATHLYRAX_PASSWORD_RESET_ENUMERATION_SAFE','ATHLYRAX_PRODUCTION_DEFAULT_AUTH_USERS_DISABLED','const DEFAULT_AUTH_USERS = IS_PRODUCTION ? [] : [','ATHLYRAX_PASSWORD_RESET_REQUEST_GENERIC_FAILURE_RESPONSE','ATHLYRAX_SNAPSHOT_PASSWORD_RESET_REQUEST_GENERIC_FAILURE_RESPONSE','ATHLYRAX_PASSWORD_RESET_CONFIRM_GENERIC_UNKNOWN_ACCOUNT','ATHLYRAX_AUTH_IDENTIFIER_AMBIGUITY_SAFE','ATHLYRAX_SNAPSHOT_AUTH_IDENTIFIER_AMBIGUITY_SAFE','ATHLYRAX_SNAPSHOT_LOGIN_IDENTIFIER_AMBIGUITY_SAFE','ATHLYRAX_SNAPSHOT_RESET_CONFIRM_IDENTIFIER_AMBIGUITY_SAFE','ATHLYRAX_FIRST_MATCH_IDENTIFIER_HELPER_REMOVED','ATHLYRAX_ONBOARDING_EMAIL_UNIQUE','resolveLoginUserByIdentifier(identifier)']) {
  if (!authEnumerationPatch.includes(token)) failures.push(`scripts/patch-auth-enumeration-safety.mjs: missing required token ${token}`);
}
if (authEnumerationPatch.includes('ATHLYRAX_ONBOARDING_EMAIL_UNIQUENESS')) failures.push('scripts/patch-auth-enumeration-safety.mjs: duplicate onboarding email guard logic returned.');

const passwordPolicyPatch = read('scripts/patch-password-policy.mjs');
for (const token of ['ATHLYRAX_PASSWORD_MINIMUM_10','if (password.length < 10) {','if (nextPassword.length < 10) {','Password must be at least 10 characters.','Legacy weak password policy remains']) {
  if (!passwordPolicyPatch.includes(token)) failures.push(`scripts/patch-password-policy.mjs: missing ${token}`);
}

const stripeWebhookPatch = read('scripts/patch-stripe-webhook-signature.mjs');
for (const token of ['ATHLYRAX_STRIPE_WEBHOOK_SIGNATURE_REQUIRED',"if (!signature) {",'Stripe webhook signature is required.','Stripe webhook verification is not configured.','Unsigned Stripe webhook fallback remains']) {
  if (!stripeWebhookPatch.includes(token)) failures.push(`scripts/patch-stripe-webhook-signature.mjs: missing ${token}`);
}
if (transformedIndex.includes('if (BILLING_STRIPE_WEBHOOK_SECRET && signature) {')) failures.push('index.js: unsigned Stripe webhook fallback remains.');

const snapshotCookiePatch = read('scripts/patch-snapshot-cookie-session.mjs');
for (const token of ['ATHLYRAX_SNAPSHOT_COOKIE_SESSION_V1','ATHLYRAX_SNAPSHOT_SIGNUP_NO_BEARER_TOKEN','setAuthCookies(res, { token: session.token, csrfToken: session.csrf });','csrfToken: session.csrf','Snapshot auth still exposes bearer token']) {
  if (!snapshotCookiePatch.includes(token)) failures.push(`scripts/patch-snapshot-cookie-session.mjs: missing ${token}`);
}
if (!transformedIndex.includes('ATHLYRAX_SNAPSHOT_COOKIE_SESSION_V1')) failures.push('index.js: snapshot cookie session hardening marker missing.');

const authTokenPatch = read('scripts/patch-production-auth-token-redaction.mjs');
for (const token of ['ATHLYRAX_PRODUCTION_AUTH_TOKEN_RESPONSE_REDACTED','...(IS_PRODUCTION ? {} : { token: session.token })','csrfToken: session.csrf','Unconditional bearer token remains in production auth route']) {
  if (!authTokenPatch.includes(token)) failures.push(`scripts/patch-production-auth-token-redaction.mjs: missing ${token}`);
}
if (!transformedIndex.includes('ATHLYRAX_PRODUCTION_AUTH_TOKEN_RESPONSE_REDACTED')) failures.push('index.js: production auth token response redaction marker missing.');

const clientIpPatch = read('scripts/patch-client-ip-integrity.mjs');
for (const token of ['ATHLYRAX_PROXY_OBSERVED_CLIENT_IP','return chain[chain.length - 1];','Spoofable leftmost X-Forwarded-For selection remains.']) {
  if (!clientIpPatch.includes(token)) failures.push(`scripts/patch-client-ip-integrity.mjs: missing ${token}`);
}

const rateLimitPatch = read('scripts/patch-rate-limit-integrity.mjs');
for (const token of ['ATHLYRAX_LAYERED_AUTH_RATE_LIMIT','AUTH_LOGIN_RATE_IP_MAX_ATTEMPTS','`ip:${clientKey}`','`identity:${identifier}`','Identity rate limit is still coupled to client IP.']) {
  if (!rateLimitPatch.includes(token)) failures.push(`scripts/patch-rate-limit-integrity.mjs: missing ${token}`);
}

const requestLimitPatch = read('scripts/patch-request-body-limits.mjs');
for (const token of ['ATHLYRAX_ROUTE_SCOPED_JSON_BODY_LIMITS',"app.use('/db', express.json({ limit: '25mb' }));","app.use('/swimmer/profile/sync', express.json({ limit: '25mb' }));","app.use(express.json({ limit: '5mb' }));",'Unscoped 25 MB JSON parser remains.']) {
  if (!requestLimitPatch.includes(token)) failures.push(`scripts/patch-request-body-limits.mjs: missing ${token}`);
}

const redactionPatch = read('scripts/patch-production-error-redaction.mjs');
for (const token of ['ATHLYRAX_PRODUCTION_ERROR_DETAILS_REDACTED','IS_PRODUCTION ? {}','Raw exception detail response remains']) if (!redactionPatch.includes(token)) failures.push(`scripts/patch-production-error-redaction.mjs: missing ${token}`);

const corsPatch = read('scripts/patch-production-cors-origins.mjs');
for (const token of [': (IS_PRODUCTION ? [] : DEFAULT_ALLOWED_ORIGINS)',"origin === '*'",'new URL(origin)','parsed.origin === origin','!exactOrigin','return new Set(origins);']) if (!corsPatch.includes(token)) failures.push(`scripts/patch-production-cors-origins.mjs: missing ${token}`);

const coachTransactionPatch = read('scripts/patch-coach-link-transaction-integrity.mjs');
for (const token of ['ATHLYRAX_COACH_LINK_DISTINCT_SOURCE_TARGET','ATHLYRAX_COACH_LINK_ACCEPT_DB_FIRST_AUTH_LAST','ATHLYRAX_COACH_LINK_REJECT_ROLLBACK_TARGET','ATHLYRAX_COACH_LINK_DISCONNECT_DB_FIRST_AUTH_LAST','database rollback was incomplete']) if (!coachTransactionPatch.includes(token)) failures.push(`scripts/patch-coach-link-transaction-integrity.mjs: missing required token ${token}`);

const legalPatch = read('scripts/signup-legal-acceptance-preload.mjs');
for (const token of ['ATHLYRAX_LEGAL_ACCEPTANCE_DUAL_DURABLE_JOURNAL','ATHLYRAX_LEGAL_PROXY_OBSERVED_CLIENT_IP','chain[chain.length - 1]']) if (!legalPatch.includes(token)) failures.push(`scripts/signup-legal-acceptance-preload.mjs: missing ${token}`);

const pkg = JSON.parse(read('package.json') || '{}');
const postinstall = String(pkg?.scripts?.postinstall || '');
const start = String(pkg?.scripts?.start || '');
const storageAudit = String(pkg?.scripts?.['audit:storage-paths'] || '');
const storageAll = String(pkg?.scripts?.['test:storage-all'] || '');
const securityVerify = String(pkg?.scripts?.['verify:closed-pilot-security'] || '');
const coachLinkTestCommand = String(pkg?.scripts?.['test:coach-link-workflow'] || '');
if (postinstall !== 'node scripts/build-production-backend.mjs') failures.push('package.json: postinstall is not the verified production build orchestrator.');
if (!start.includes('test:storage-all') || !start.includes('production-start.mjs')) failures.push('package.json: production start is not gated by the full test suite.');
if (!storageAudit.includes('audit-storage-paths.mjs') || !storageAudit.includes('audit-production-transform-chain.mjs')) failures.push('package.json: audit:storage-paths must run both storage and transform-chain audits.');
if (!coachLinkTestCommand.includes('tests/coach-link-workflow.test.mjs') || !coachLinkTestCommand.includes('tests/coach-link-transaction.test.mjs')) failures.push('package.json: test:coach-link-workflow must run both workflow and transaction regressions.');
for (const requiredTest of ['test:storage-safety','test:data-safety','test:persistence-integrity','test:auth-persistence-transaction','test:auth-enumeration-safety','test:snapshot-cookie-session','test:production-auth-token-redaction','test:storage-routing-safety','test:storage-migration-identity','test:storage-extra-invariants','test:startup-mutation-safety','test:storage-path-integrity','test:storage-path-contract','test:signup-legal-acceptance','test:runtime-hardening','test:billing-catalog-integrity','test:coach-link-workflow','test:closed-pilot-backup-restore','test:closed-pilot-security','audit:storage-paths']) {
  if (!storageAll.includes(requiredTest)) failures.push(`package.json: test:storage-all missing ${requiredTest}`);
}
for (const requiredTest of ['test:signup-legal-acceptance','test:storage-path-contract','test:data-safety','test:persistence-integrity','test:auth-persistence-transaction','test:auth-enumeration-safety','test:storage-routing-safety','test:storage-migration-identity','test:storage-extra-invariants','test:startup-mutation-safety','test:storage-path-integrity','test:runtime-hardening','test:billing-catalog-integrity','test:coach-link-workflow','audit:storage-paths']) {
  if (!securityVerify.includes(requiredTest)) failures.push(`package.json: verify:closed-pilot-security missing ${requiredTest}`);
}

if (failures.length) {
  console.error('ATHLYRAX_PRODUCTION_TRANSFORM_CHAIN_AUDIT_FAIL');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}
console.log('ATHLYRAX_PRODUCTION_TRANSFORM_CHAIN_AUDIT_OK');
