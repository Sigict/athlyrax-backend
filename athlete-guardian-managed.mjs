// Guardian-managed Athlete App logins for under-18 athletes without an email address.
// Design: docs/athlete-guardian-managed-accounts-design.md.
// - Only a parent/guardian who has given VERIFIED consent (email code) on a live invitation can
//   create the login, and only when the invitation has no athlete email (an athlete with their own
//   email accepts their own invitation instead).
// - The athlete gets separate credentials (username + password); the guardian never gets a login to
//   the athlete's account. Password-reset codes go to the guardian's verified email.
// - The guardian can revoke access at any time with their link plus a fresh emailed code.
import crypto from 'node:crypto';
import { ATHLETE_INVITE_COLLECTION, resolveInvite, inviteStatus, uniqueSwimmerRow, linkedAccountOf, guardianCodeDigest, sameHash, maskEmail, GUARDIAN_CODE_TTL_MINUTES, GUARDIAN_CODE_MAX_ATTEMPTS, GUARDIAN_CODE_MAX_SENDS, GUARDIAN_CODE_RESEND_SECONDS } from './athlete-account-invites.mjs';

const text = (v) => String(v ?? '').trim();
const list = (v) => (Array.isArray(v) ? v : []);

export const MANAGED_CREATED_VIA = 'guardian-managed';
export const isGuardianManaged = (user) => Boolean(user && user.managedBy && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text(user.managedBy.guardianEmail)) && !text(user.email));

// Guardian link -> may this guardian create a login without email for the athlete? No writes.
export function checkManagedAcceptance(db = {}, parsed, account = {}, now = new Date()) {
  if (!parsed || parsed.kind !== 'guardian') return { ok: false, status: 404, error: 'This parent/guardian link is not valid.' };
  const invite = resolveInvite(db, parsed, 'guardian');
  if (!invite) return { ok: false, status: 404, error: 'This parent/guardian link is not valid.' };
  const username = text(account.username).toLowerCase();
  const status = inviteStatus(invite, now.getTime());
  if (status === 'accepted') {
    if (username && text(invite.acceptedBy).toLowerCase() === username) return { ok: true, already: true, invite };
    return { ok: false, status: 409, error: 'This invitation has already been used.' };
  }
  if (status === 'revoked') return { ok: false, status: 410, error: 'This invitation was withdrawn by the club.' };
  if (status === 'expired') return { ok: false, status: 410, error: 'This invitation has expired. Ask the club for a new one.' };
  // The verified emailed guardian link is also proof of mailbox control: recordGuardianConsent
  // validates its one-use secret and delivery before marking it emailed-invitation-link.
  if (!invite.guardianRequired || !['email-code', 'emailed-invitation-link'].includes(invite.guardianConsent?.verifiedBy)) return { ok: false, status: 403, error: 'Verified parent/guardian consent is required first.' };
  if (invite.targetEmail) return { ok: false, status: 409, error: 'This invitation is for the athlete\'s own email address; the athlete accepts it from their own invitation email.' };
  const { row, duplicate } = uniqueSwimmerRow(db, invite.swimmerId);
  if (duplicate) return { ok: false, status: 409, error: 'The swimmer record for this invitation is ambiguous. Ask the club to correct it.' };
  if (!row || text(row.status).toLowerCase() === 'deleted' || row.deletedAt) return { ok: false, status: 409, error: 'The swimmer record for this invitation is no longer available.' };
  const linked = linkedAccountOf(row);
  if (linked.username) return { ok: false, status: 409, error: 'This swimmer is already linked to another login.' };
  if (username && list(db.swimmers).some((s) => text(s?.id) !== text(row.id) && text(s?.swimmerAccountUsername).toLowerCase() === username)) return { ok: false, status: 409, error: 'This login is already linked to another swimmer.' };
  return { ok: true, invite, row };
}

export function managedUserRecord({ username, passwordHash, fullName, invite, tenantKey, clubName, billing, now = new Date() }) {
  const at = now.toISOString();
  return {
    username: text(username).toLowerCase(), role: 'swimmer', tenantId: tenantKey, passwordHash, tokenValidAfter: 0,
    createdVia: MANAGED_CREATED_VIA, athleteInviteManaged: true, createdAt: at, fullName: text(fullName), email: '',
    managedBy: { guardianEmail: text(invite.guardianEmail).toLowerCase(), guardianName: text(invite.guardianConsent?.name), relationship: text(invite.guardianConsent?.relationship), inviteId: invite.id, tenantId: tenantKey, consentAt: text(invite.guardianConsent?.at) },
    swimClub: clubName || '', isApproved: true, onboardingCompletedAt: at, billing,
  };
}

// ---- guardian "manage access" code (revocation) ----
// The guardian proves control of the verified email again before revoking.
export function guardianManageTarget(db = {}, parsed, now = new Date()) {
  if (!parsed || parsed.kind !== 'guardian') return { ok: false, status: 404, error: 'This parent/guardian link is not valid.' };
  const invite = resolveInvite(db, parsed, 'guardian');
  if (!invite || !invite.guardianConsent) return { ok: false, status: 404, error: 'This parent/guardian link is not valid.' };
  if (inviteStatus(invite, now.getTime()) !== 'accepted') return { ok: false, status: 409, error: 'No Athlete App login is linked through this invitation.' };
  const { row } = uniqueSwimmerRow(db, invite.swimmerId);
  const linked = row ? linkedAccountOf(row) : {};
  if (!row || !linked.username || text(row.accountLinkInviteId) !== text(invite.id)) return { ok: false, status: 409, error: 'The login linked through this invitation has already been removed.' };
  return { ok: true, invite, row, username: linked.username };
}

export function issueManageCode(db = {}, parsed, { now = new Date(), codeKey } = {}) {
  const t = guardianManageTarget(db, parsed, now);
  if (!t.ok) return t;
  const prev = t.invite.guardianManageCode || {};
  const windowStart = prev.windowStart && now.getTime() - Date.parse(prev.windowStart) < 24 * 3600000 ? prev.windowStart : now.toISOString();
  const sends = windowStart === prev.windowStart ? Number(prev.sends || 0) : 0;
  if (sends >= GUARDIAN_CODE_MAX_SENDS) return { ok: false, status: 429, error: 'Too many codes were requested today. Try again tomorrow or contact the club.' };
  if (prev.sentAt && now.getTime() - Date.parse(prev.sentAt) < GUARDIAN_CODE_RESEND_SECONDS * 1000) return { ok: false, status: 429, error: 'A code was sent less than a minute ago.' };
  const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  const rec = { hash: guardianCodeDigest(codeKey, `manage:${t.invite.id}`, code), alg: 'hmac-sha256', sentAt: now.toISOString(), expiresAt: new Date(now.getTime() + GUARDIAN_CODE_TTL_MINUTES * 60000).toISOString(), attempts: 0, sends: sends + 1, windowStart };
  const invites = list(db[ATHLETE_INVITE_COLLECTION]).map((inv) => (inv.id === t.invite.id ? { ...inv, guardianManageCode: rec } : inv));
  return { ok: true, code, email: t.invite.guardianEmail, invite: t.invite, username: t.username, db: { ...db, [ATHLETE_INVITE_COLLECTION]: invites } };
}

// Verifies the manage code (one use). Returns the target on success; counts wrong attempts.
export function verifyManageCode(db = {}, parsed, code, { now = new Date(), codeKey } = {}) {
  const t = guardianManageTarget(db, parsed, now);
  if (!t.ok) return t;
  const gc = t.invite.guardianManageCode || {};
  if (!gc.hash) return { ok: false, status: 403, error: `Request a code first: it is sent to ${maskEmail(t.invite.guardianEmail)}.` };
  if (Number(gc.attempts || 0) >= GUARDIAN_CODE_MAX_ATTEMPTS) return { ok: false, status: 429, error: 'Too many wrong codes. Request a new code.' };
  if (!(Date.parse(gc.expiresAt) > now.getTime())) return { ok: false, status: 403, error: 'The code has expired. Request a new code.' };
  const good = /^\d{6}$/.test(text(code)) && sameHash(guardianCodeDigest(codeKey, `manage:${t.invite.id}`, code), gc.hash);
  const invites = list(db[ATHLETE_INVITE_COLLECTION]).map((inv) => (inv.id === t.invite.id ? { ...inv, guardianManageCode: good ? { ...gc, hash: '', usedAt: now.toISOString() } : { ...gc, attempts: Number(gc.attempts || 0) + 1 } } : inv));
  const next = { ...db, [ATHLETE_INVITE_COLLECTION]: invites };
  if (!good) return { ok: false, status: 403, error: 'The code is not correct.', persist: true, db: next };
  return { ...t, ok: true, db: next };
}
