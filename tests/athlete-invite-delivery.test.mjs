import test from 'node:test';
import assert from 'node:assert/strict';
import { savedContacts, applyContactChoice, coachInviteState, buildInviteEmail, applyDeliveryEvent, recordDelivery, updateDelivery, planBulkItem, dedupeBulkItems, rotateInviteToken, markAutoDelivery, resendAllowed } from '../athlete-invite-delivery.mjs';
import { createAthleteInvite, preserveServerOwnedAthleteData, parseInviteToken, resolveInvite } from '../athlete-account-invites.mjs';

const now = new Date('2026-11-08T12:00:00Z');
const adult = { id: 'ad1', firstName: 'Ada', lastName: 'Long', dob: '2000-01-01', email: 'Ada@Example.com' };
const kid = { id: 'kd1', firstName: 'Kit', lastName: 'Young', dob: '2014-01-01', parentEmail: 'parent@example.com' };

test('contacts: imported fields only pre-fill; saved contacts win', () => {
  assert.deepEqual(savedContacts(adult), { athleteEmail: 'ada@example.com', athleteSource: 'imported:email', guardianEmail: '', guardianSource: '' });
  assert.equal(savedContacts(kid).guardianSource, 'imported:parentEmail');
  assert.equal(savedContacts({ ...kid, athleteContacts: { guardianEmail: 'mum@example.com' } }).guardianEmail, 'mum@example.com');
});

test('contacts: save only when ticked; replacing needs confirmation; history is kept; imported fields untouched', () => {
  assert.equal(applyContactChoice(adult, { athleteEmail: 'x@example.com', saveAthlete: false }).changed, false);
  const first = applyContactChoice(adult, { athleteEmail: 'ada@example.com', saveAthlete: true, actor: 'coach', now });
  assert.equal(first.row.athleteContacts.athleteEmail, 'ada@example.com');
  assert.equal(first.row.email, 'Ada@Example.com', 'imported field unchanged');
  const conflict = applyContactChoice(first.row, { athleteEmail: 'new@example.com', saveAthlete: true, now });
  assert.equal(conflict.ok, false);
  assert.deepEqual(conflict.conflicts, [{ kind: 'athlete', saved: 'ada@example.com', proposed: 'new@example.com' }]);
  assert.equal(conflict.row, first.row, 'nothing changed');
  const replaced = applyContactChoice(first.row, { athleteEmail: 'new@example.com', saveAthlete: true, confirmReplaceAthlete: true, actor: 'coach', now });
  assert.equal(replaced.row.athleteContacts.athleteEmail, 'new@example.com');
  assert.deepEqual(replaced.row.athleteContacts.history.map((h) => [h.action, h.from, h.to]), [['saved', '', 'ada@example.com'], ['replaced', 'ada@example.com', 'new@example.com']]);
  // Guardian and athlete choices are independent.
  const g = applyContactChoice(kid, { athleteEmail: 'kit@example.com', guardianEmail: 'parent@example.com', saveGuardian: true, now });
  assert.deepEqual([g.row.athleteContacts.guardianEmail, g.row.athleteContacts.athleteEmail], ['parent@example.com', undefined]);
});

test('whole-club saves cannot change saved invitation contacts', () => {
  const stored = { swimmers: [{ ...adult, athleteContacts: { athleteEmail: 'ada@example.com' } }] };
  const incoming = { swimmers: [{ ...adult, athleteContacts: { athleteEmail: 'evil@example.com' }, firstName: 'Ada2' }] };
  const out = preserveServerOwnedAthleteData(incoming, stored);
  assert.equal(out.swimmers[0].athleteContacts.athleteEmail, 'ada@example.com');
  assert.equal(out.swimmers[0].firstName, 'Ada2');
  const fresh = preserveServerOwnedAthleteData({ swimmers: [{ id: 'n1', athleteContacts: { athleteEmail: 'x@example.com' } }] }, { swimmers: [] });
  assert.equal(fresh.swimmers[0].athleteContacts, undefined);
});

test('email content names AthlyraX, club, coach, swimmer, purpose, expiry and the link; no link in preview', () => {
  const g = buildInviteEmail({ kind: 'guardian', clubName: 'Club A', coachName: 'Sam Coach', swimmerName: 'Kit Young', link: 'https://athlyrax.com/athlete-invite.html#token=AXG1.x', expiresAt: '2026-11-15T12:00:00Z', replyTo: { email: 'c@example.com' } });
  for (const s of ['AthlyraX', 'Club A', 'Sam Coach', 'Kit Young', 'parent or guardian', '15 November 2026', '#token=AXG1.x', 'not a marketing subscription']) assert.ok(g.text.includes(s), s);
  assert.match(g.subject, /Club A.*authorise Kit/);
  assert.ok(g.html.includes('Review and authorise'));
  const a = buildInviteEmail({ kind: 'athlete', clubName: 'Club <A>', coachName: 'Sam', swimmerName: 'Ada Long', link: null, expiresAt: '2026-11-15T12:00:00Z' });
  assert.ok(a.text.includes('[secure invitation link]') && !a.text.includes('AXA1'));
  assert.ok(a.html.includes('Club &lt;A&gt;'), 'HTML escaped');
  assert.ok(a.text.includes('diary'), 'privacy note');
});

test('bulk planning: linked, open, missing and invalid addresses are skipped; duplicates removed', () => {
  const db = { swimmers: [adult, kid, { id: 'lk1', firstName: 'L', swimmerAccountUsername: 'l.user' }, { id: 'nd', firstName: 'No', dob: '' }] };
  assert.equal(planBulkItem(db, { swimmerId: 'ad1', athleteEmail: 'ada@example.com' }, now).sendTo, 'athlete');
  assert.equal(planBulkItem(db, { swimmerId: 'ad1' }, now).code, 'missing-athlete-email');
  assert.equal(planBulkItem(db, { swimmerId: 'kd1', athleteEmail: 'kit@example.com' }, now).code, 'missing-guardian-email');
  const k = planBulkItem(db, { swimmerId: 'kd1', athleteEmail: 'kit@example.com', guardianEmail: 'parent@example.com' }, now);
  assert.deepEqual([k.sendTo, k.athleteEmail, k.guardianEmail], ['guardian', 'kit@example.com', 'parent@example.com']);
  assert.equal(planBulkItem(db, { swimmerId: 'kd1', athleteEmail: 'p@example.com', guardianEmail: 'p@example.com' }, now).code, 'same-email');
  assert.equal(planBulkItem(db, { swimmerId: 'nd', guardianEmail: 'g@example.com' }, now).guardianRequired, true, 'no date of birth needs a guardian');
  assert.equal(planBulkItem(db, { swimmerId: 'lk1', athleteEmail: 'l@example.com' }, now).code, 'already-linked');
  assert.equal(planBulkItem(db, { swimmerId: 'zz' }, now).code, 'not-found');
  assert.equal(planBulkItem(db, { swimmerId: 'ad1', athleteEmail: 'bad' }, now).code, 'invalid-athlete-email');
  const created = createAthleteInvite(db, { swimmerId: 'ad1', tenantKey: 't', actor: 'c', targetEmail: 'ada@example.com', now });
  assert.equal(planBulkItem(created.db, { swimmerId: 'ad1', athleteEmail: 'ada@example.com' }, now).code, 'already-invited');
  assert.deepEqual(dedupeBulkItems([{ swimmerId: 'a' }, { swimmerId: 'a' }, { swimmerId: 'b' }, {}]).items.map((i) => i.swimmerId), ['a', 'b']);
});

test('automatic invitations: athlete link only after consent; rotation invalidates old links', () => {
  const db0 = { swimmers: [kid] };
  const c = createAthleteInvite(db0, { swimmerId: 'kd1', tenantKey: 't', actor: 'c', targetEmail: 'kit@example.com', guardianEmail: 'parent@example.com', now });
  const db = markAutoDelivery(c.db, c.invite.id, { requestId: 'req12345' });
  assert.equal(rotateInviteToken(db, c.invite.id, 'athlete', { now }).status, 403, 'no athlete link before consent');
  const g = rotateInviteToken(db, c.invite.id, 'guardian', { now });
  assert.ok(g.ok);
  assert.equal(resolveInvite(g.db, parseInviteToken(c.guardianToken), 'guardian'), null, 'old guardian link stops working');
  assert.ok(resolveInvite(g.db, parseInviteToken(g.token), 'guardian'));
  const consented = { ...g.db, athleteAccountInvites: g.db.athleteAccountInvites.map((i) => ({ ...i, guardianConsent: { at: now.toISOString() } })) };
  const a = rotateInviteToken(consented, c.invite.id, 'athlete', { now });
  assert.ok(a.ok && resolveInvite(a.db, parseInviteToken(a.token), 'athlete'));
  assert.equal(resolveInvite(a.db, parseInviteToken(c.athleteToken), 'athlete'), null, 'the never-sent original athlete link is dead');
  // Link-only (manual) invitations are never rotated.
  assert.equal(rotateInviteToken(c.db, c.invite.id, 'guardian', { now }).status, 409);
});

test('states and delivery events', () => {
  const db0 = { swimmers: [adult] };
  const c = createAthleteInvite(db0, { swimmerId: 'ad1', tenantKey: 't', actor: 'c', targetEmail: 'ada@example.com', now });
  let db = markAutoDelivery(c.db, c.invite.id);
  let inv = () => db.athleteAccountInvites[0];
  assert.equal(coachInviteState(adult, null), 'not-invited');
  db = recordDelivery(db, c.invite.id, { id: 'dl_1', kind: 'athlete', to: 'ada@example.com', provider: 'smtp', status: 'queued', now });
  db = updateDelivery(db, c.invite.id, 'dl_1', { messageId: '<m1@x>', status: 'sent' });
  assert.equal(coachInviteState(adult, inv(), now.getTime()), 'invitation-sent');
  assert.equal(applyDeliveryEvent(db, { messageId: '<m1@x>', event: 'opened' }).ok, false, 'opens are not tracked');
  db = applyDeliveryEvent(db, { messageId: 'm1@x', event: 'delivered', at: 'd1' }).db;
  assert.equal(inv().deliveries[0].status, 'delivered');
  db = applyDeliveryEvent(db, { messageId: '<m1@x>', event: 'deferred' }).db;
  assert.equal(inv().deliveries[0].status, 'delivered', 'a later deferral does not downgrade');
  db = applyDeliveryEvent(db, { messageId: '<m1@x>', event: 'hard_bounce', reason: 'mailbox AXA1.t.ai_1.secret unknown 123456' }).db;
  assert.equal(inv().deliveries[0].status, 'bounced');
  assert.ok(!inv().deliveries[0].error.includes('secret') && !inv().deliveries[0].error.includes('123456'), 'no secrets in errors');
  assert.equal(coachInviteState(adult, inv(), now.getTime()), 'delivery-failed');
  assert.equal(coachInviteState({ ...adult, swimmerAccountUsername: 'ada' }, inv()), 'linked');
  assert.equal(coachInviteState(adult, { ...inv(), revokedAt: 'x' }), 'revoked');
  assert.equal(coachInviteState(adult, { ...inv(), expiresAt: '2020-01-01' }), 'expired');
  // Resend limits: a failed attempt may be retried at once; a successful one waits a minute.
  assert.equal(resendAllowed({ deliveries: [{ kind: 'athlete', status: 'failed', at: now.toISOString() }] }, 'athlete', now).ok, true);
  assert.equal(resendAllowed({ deliveries: [{ kind: 'athlete', status: 'sent', at: now.toISOString() }] }, 'athlete', now).status, 429);
  // A corrected address is sent at once; the same address still waits (no repeated message).
  const sentTo = { deliveries: [{ kind: 'guardian', to: 'wrong@example.com', status: 'sent', at: now.toISOString() }] };
  assert.equal(resendAllowed(sentTo, 'guardian', now, 'right@example.com').ok, true);
  assert.equal(resendAllowed(sentTo, 'guardian', now, 'WRONG@example.com').status, 429);
  assert.equal(resendAllowed({ deliveries: Array.from({ length: 5 }, (_, i) => ({ kind: 'guardian', to: `a${i}@example.com`, status: 'sent', at: now.toISOString() })) }, 'guardian', now, 'new@example.com').status, 429, 'total sends stay capped');
});

test('email subject never contains line breaks from club data (header injection)', () => {
  const m = buildInviteEmail({ kind: 'guardian', clubName: 'Club\r\nBcc: x@evil.test', coachName: 'C\nX', swimmerName: 'Kit\r\nYoung', link: 'https://athlyrax.com/x', expiresAt: '2026-11-15T12:00:00Z' });
  assert.ok(!/[\r\n]/.test(m.subject), m.subject);
});
