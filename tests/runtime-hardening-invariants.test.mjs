import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { validateInviteStoreSemanticIntegrity } from '../scripts/invite-store-integrity.mjs';

test('production build contains runtime auth billing identity ownership and tenant hardening', () => {
  const source = fs.readFileSync(path.resolve('index.js'), 'utf8');
  for (const token of [
    'ATHLYRAX_AUTH_ROW_METADATA_PRESERVED',
    'ATHLYRAX_BILLING_POLICY_SINGLE_SOURCE',
    'ATHLYRAX_UNKNOWN_STRIPE_PRICE_FAIL_CLOSED',
    'ATHLYRAX_BILLING_CHECKOUT_POLICY_ENFORCED',
    'ATHLYRAX_BILLING_MEMORY_ROLLBACK',
    'ATHLYRAX_BILLING_CATALOG_MEMORY_ROLLBACK',
    'ATHLYRAX_BILLING_CATALOG_PARTIAL_UPDATE_PRESERVES_STATE',
    'ATHLYRAX_INVITE_ROW_METADATA_PRESERVED',
    'ATHLYRAX_INVITE_CODE_CRYPTO_RNG',
    'ATHLYRAX_INVITE_CODE_UNIQUENESS_FAIL_CLOSED',
    'ATHLYRAX_STRIPE_EVENT_ORDER_GUARD',
    'ATHLYRAX_SERVER_AUTHORITATIVE_OWNERSHIP_METADATA',
    'ATHLYRAX_ORPHAN_TENANT_CLAIM_BLOCKED',
    'ATHLYRAX_LAST_TENANT_ACCOUNT_DELETE_BLOCKED',
    'ATHLYRAX_SWIMMER_CANNOT_SELF_APPROVE_COACH_LINK',
    'ATHLYRAX_PARENT_NOTIFICATION_ONLY',
    'ATHLYRAX_PRODUCTION_CORS_FRONTEND_ORIGINS',
    'ATHLYRAX_PRODUCTION_ERROR_DETAILS_REDACTED',
    'ATHLYRAX_RUNTIME_DB_READ_FAIL_CLOSED',
    'ATHLYRAX_OWNERSHIP_SUMMARY_STRICT_DB_READ',
    'ATHLYRAX_NO_PRODUCTION_STARTUP_AUTOHEAL',
    'ATHLYRAX_PRODUCTION_LOGIN_READ_ONLY',
    'ATHLYRAX_PRODUCTION_DB_GET_READ_ONLY',
    'ATHLYRAX_GLOBAL_OWNER_ROLE_TENANT_CONTRACT',
    'ATHLYRAX_INVITE_GLOBAL_OWNER_FORBIDDEN',
    'ATHLYRAX_FIRST_MATCH_IDENTIFIER_HELPER_REMOVED',
  ]) assert.ok(source.includes(token), `missing runtime hardening token ${token}`);

  assert.equal(source.includes("const isBillingEnforced = isBillingEnabled && BILLING_ENFORCED;"), false);
  assert.equal(source.includes("if (!BILLING_ENFORCED || !stripeClient) return next();"), false);
  assert.equal(source.includes("return { planKey: 'tier-1', priceId: linePriceId };"), false);
  assert.equal(source.includes('Math.floor(Math.random() * alphabet.length)'), false);
  assert.equal(source.includes('buildExistingDbRowIdIndex('), false);
  assert.equal(source.includes("responsePayload = JSON.stringify({ swimmers: [] });"), false);
  assert.equal(source.includes('Under-18 approvals require parent email 1.'), false);
  assert.equal(source.includes('Under-18 approvals require parent 1 consent.'), false);
  assert.equal(source.includes('Parent 2 consent is required when parent email 2 is provided.'), false);
  assert.equal(source.includes('function findAuthUserByIdentifier('), false);
  assert.equal(source.includes("details: error instanceof Error ? error.message : 'Unknown error'"), false);
  assert.ok(source.includes("...(IS_PRODUCTION ? {} : { details: error instanceof Error ? error.message : 'Unknown error' })"));
  assert.ok(source.includes("'https://athlyrax.com'"));
  assert.ok(source.includes("'https://www.athlyrax.com'"));
  assert.ok(source.includes(': (IS_PRODUCTION ? [] : DEFAULT_ALLOWED_ORIGINS)'));
  assert.ok(source.includes("origin === '*'"));
  assert.ok(source.includes("app.post('/db/ownership-backfill', requireAuth, requireAdminRole, requireBillingWriteAccess"));
  assert.ok(source.includes('Team storage already exists without an active membership. Automatic claiming is blocked'));
  assert.ok(source.includes('Each configured Stripe price ID may belong to only one billing plan.'));
  assert.ok(source.includes('Cannot delete the last account for a tenant while its database still exists.'));
  assert.ok(source.includes('Coach connections become approved only through coach-side acceptance.'));
  assert.ok(source.includes('Parent email 1 is invalid.'));
  assert.ok(source.includes('Parent email 2 is invalid.'));
  assert.ok(source.includes('No empty result was substituted.'));
});

test('invite semantic validator rejects duplicates invalid tenant and impossible use count', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'athlyrax-invites-'));
  const filePath = path.join(root, 'auth-invites.json');
  fs.writeFileSync(filePath, JSON.stringify([
    { code: 'ABCD-EFGH-JKLM', role: 'assistant-coach', tenantId: 'club-one', expiresAt: '2030-01-01T00:00:00.000Z', maxUses: 1, usedCount: 0, disabled: false },
    { code: 'abcd-efgh-jklm', role: 'assistant-coach', tenantId: 'global-owner', expiresAt: '2030-01-01T00:00:00.000Z', maxUses: 1, usedCount: 2, disabled: false },
  ]));
  const failures = validateInviteStoreSemanticIntegrity({ authInvitesPath: filePath }, process.env, fs).join('\n');
  assert.match(failures, /duplicated/);
  assert.match(failures, /invalid tenantId/);
  assert.match(failures, /invalid usedCount/);
});

test('invite semantic validator accepts valid empty history and valid retained rows', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'athlyrax-invites-ok-'));
  const filePath = path.join(root, 'auth-invites.json');
  fs.writeFileSync(filePath, JSON.stringify([]));
  assert.deepEqual(validateInviteStoreSemanticIntegrity({ authInvitesPath: filePath }, process.env, fs), []);
  fs.writeFileSync(filePath, JSON.stringify([
    { code: 'ABCD-EFGH-JKLM', role: 'viewer', tenantId: 'club-one', expiresAt: '2030-01-01T00:00:00.000Z', maxUses: 3, usedCount: 3, disabled: true, retainedAuditMetadata: 'kept' },
  ]));
  assert.deepEqual(validateInviteStoreSemanticIntegrity({ authInvitesPath: filePath }, process.env, fs), []);
});