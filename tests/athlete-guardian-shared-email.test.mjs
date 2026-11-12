import test from 'node:test';
import assert from 'node:assert/strict';
import { createAthleteInvite, parseInviteToken } from '../athlete-account-invites.mjs';
import { planBulkItem } from '../athlete-invite-delivery.mjs';
import { checkManagedAcceptance } from '../athlete-guardian-managed.mjs';

// Regression: a parent's existing AthlyraX email must not become a second athlete login
// or be used as the child's independently verified email.
test('under-18 swimmer sharing guardian email routes to guardian-managed account', () => {
  const now = new Date('2026-11-12T12:00:00Z');
  const db = { swimmers: [{ id: 'child-1', firstName: 'Child', lastName: 'Demo', dob: '2012-03-01' }] };
  const plan = planBulkItem(db, { swimmerId: 'child-1', athleteEmail: 'FATHER@EXAMPLE.COM', guardianEmail: 'father@example.com' }, now);
  assert.equal(plan.ok, true);
  assert.equal(plan.athleteEmail, '');
  assert.equal(plan.guardianEmail, 'father@example.com');
  assert.equal(plan.sendTo, 'guardian');
  const made = createAthleteInvite(db, { swimmerId: 'child-1', tenantKey: 'demo-club', actor: 'demo.coach', guardianEmail: plan.guardianEmail, targetEmail: 'father@example.com', now });
  assert.equal(made.ok, true);
  assert.equal(made.invite.targetEmail, '');
  assert.equal(made.db.swimmers.length, 1, 'do not duplicate existing swimmer');
  const token = parseInviteToken(made.guardianToken);
  assert.ok(token);
  const check = (guardianConsent) => checkManagedAcceptance({
    ...made.db,
    athleteAccountInvites: made.db.athleteAccountInvites.map((inv) => ({ ...inv, guardianConsent })),
  }, token, { username: 'child.demo' }, now);
  assert.equal(check(null).status, 403, 'guardian consent is mandatory');
  assert.equal(check({ at: now.toISOString(), verifiedBy: 'emailed-invitation-link' }).ok, true, 'verified emailed guardian approval can create managed child login');
  assert.equal(check({ at: now.toISOString(), verifiedBy: 'email-code' }).ok, true, 'verified six-digit code remains supported');
  assert.equal(check({ at: now.toISOString(), verifiedBy: 'unknown' }).status, 403, 'unverified consent never passes');
});

test('distinct swimmer email remains independently restricted', () => {
  const now = new Date('2026-11-12T12:00:00Z');
  const db = { swimmers: [{ id: 'child-2', firstName: 'Child', dob: '2012-03-01' }] };
  const made = createAthleteInvite(db, { swimmerId: 'child-2', tenantKey: 'demo-club', actor: 'demo.coach', guardianEmail: 'father@example.com', targetEmail: 'child@example.com', now });
  assert.equal(made.invite.targetEmail, 'child@example.com');
  const withConsent = {
    ...made.db,
    athleteAccountInvites: made.db.athleteAccountInvites.map((inv) => ({ ...inv, guardianConsent: { at: now.toISOString(), verifiedBy: 'emailed-invitation-link' } })),
  };
  assert.equal(checkManagedAcceptance(withConsent, parseInviteToken(made.guardianToken), { username: 'child.demo2' }, now).status, 409, 'own-email invitation cannot use managed-account route');
});
