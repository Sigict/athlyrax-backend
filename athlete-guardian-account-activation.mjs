// Fresh guardian email verification for an already-authorised parent's first login.
// The guardian invitation identifies the club's recorded guardian email; code possession
// proves that address is still controlled. Does not change guardian consent or swimmer data.
import crypto from 'node:crypto';
import { ATHLETE_INVITE_COLLECTION, resolveInvite, inviteStatus, guardianCodeDigest, sameHash,
  GUARDIAN_CODE_TTL_MINUTES, GUARDIAN_CODE_MAX_ATTEMPTS, GUARDIAN_CODE_MAX_SENDS,
  GUARDIAN_CODE_RESEND_SECONDS } from './athlete-account-invites.mjs';
const list = (x) => Array.isArray(x) ? x : [];
const text = (x) => String(x ?? '').trim();

function target(db, parsed, now) {
  if (parsed?.kind !== 'guardian') return { ok: false, status: 404, error: 'Invalid parent link.' };
  const inv = resolveInvite(db, parsed, 'guardian');
  if (!inv) return { ok: false, status: 404, error: 'Invalid parent link.' };
  const status = inviteStatus(inv, now.getTime());
  if (status === 'expired' || status === 'revoked' || !(Date.parse(inv.expiresAt) > now.getTime())) {
    return { ok: false, status: 410, error: 'This parent link has expired or been revoked. Ask the club for a new one.' };
  }
  if (!inv.guardianConsent?.at || inv.guardianConsent?.verifiedBy !== 'email-code') {
    return { ok: false, status: 403, error: 'Verified parental authorisation is required first.' };
  }
  return { ok: true, invite: inv };
}

export function issueGuardianAccountCode(db = {}, parsed, { now = new Date(), codeKey } = {}) {
  const t = target(db, parsed, now);
  if (!t.ok) return t;
  const prev = t.invite.guardianAccountCode || {};
  const windowStart = prev.windowStart && now.getTime() - Date.parse(prev.windowStart) < 24 * 3600000 ? prev.windowStart : now.toISOString();
  const sends = windowStart === prev.windowStart ? Number(prev.sends || 0) : 0;
  if (sends >= GUARDIAN_CODE_MAX_SENDS) return { ok: false, status: 429, error: 'Too many codes today. Try again tomorrow.' };
  if (prev.sentAt && now.getTime() - Date.parse(prev.sentAt) < GUARDIAN_CODE_RESEND_SECONDS * 1000) {
    return { ok: false, status: 429, error: 'A code was sent less than a minute ago.' };
  }
  const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  const rec = { hash: guardianCodeDigest(codeKey, `guardian-account:${t.invite.id}`, code), alg: 'hmac-sha256',
    sentAt: now.toISOString(), expiresAt: new Date(now.getTime() + GUARDIAN_CODE_TTL_MINUTES * 60000).toISOString(),
    windowStart, sends: sends + 1, attempts: 0 };
  const invites = list(db[ATHLETE_INVITE_COLLECTION]).map((i) => i.id === t.invite.id ? { ...i, guardianAccountCode: rec } : i);
  return { ok: true, invite: t.invite, email: t.invite.guardianEmail, code, db: { ...db, [ATHLETE_INVITE_COLLECTION]: invites } };
}

export function verifyGuardianAccountCode(db = {}, parsed, code, { now = new Date(), codeKey } = {}) {
  const t = target(db, parsed, now);
  if (!t.ok) return t;
  const rec = t.invite.guardianAccountCode || {};
  if (!rec.hash) return { ok: false, status: 403, error: 'Request a fresh parent-account code first.' };
  if (Number(rec.attempts || 0) >= GUARDIAN_CODE_MAX_ATTEMPTS) return { ok: false, status: 429, error: 'Too many incorrect codes.' };
  if (!(Date.parse(rec.expiresAt) > now.getTime())) return { ok: false, status: 403, error: 'The code has expired. Request a new one.' };
  const good = /^\d{6}$/.test(text(code)) && rec.alg === 'hmac-sha256' &&
    sameHash(guardianCodeDigest(codeKey, `guardian-account:${t.invite.id}`, code), rec.hash);
  const invites = list(db[ATHLETE_INVITE_COLLECTION]).map((i) => i.id === t.invite.id
    ? { ...i, guardianAccountCode: good ? { ...rec, hash: '', usedAt: now.toISOString() } : { ...rec, attempts: Number(rec.attempts || 0) + 1 } } : i);
  const next = { ...db, [ATHLETE_INVITE_COLLECTION]: invites };
  if (!good) return { ok: false, status: 403, persist: true, db: next, error: 'The parent-account code is incorrect.' };
  return { ...t, db: next };
}
