// AthlyraX athlete account invitations: link an athlete's login to an EXISTING swimmer record.
// One swimmer identity: the swimmer row in the club's database is never duplicated; the link is the
// existing swimmerAccountUsername / swimmerAccountEmail binding on that row.
//
// Invitations live in the club database (collection athleteAccountInvites) and are server-owned:
// a whole-club save can never create, change or revive them, and the account-link fields on swimmer
// rows can only be changed by these routes.
//
// Token: AXA1.<tenantKey>.<inviteId>.<secret> (athlete) and AXG1.<tenantKey>.<inviteId>.<secret>
// (parent/guardian). Only SHA-256 hashes of the secrets are stored; the tenant and invite id in the
// token only locate the invitation, the secret must match, so editing a link cannot reach another
// club or swimmer, and no swimmer id supplied by the athlete is ever used.
import crypto from 'node:crypto';

export const ATHLETE_INVITE_COLLECTION = 'athleteAccountInvites';
export const ATHLETE_LINK_FIELDS = Object.freeze(['swimmerAccountUsername', 'swimmerAccountEmail', 'accountLinkedAt', 'accountLinkInviteId', 'accountLinkHistory']);
export const SERVER_OWNED_COLLECTIONS = Object.freeze([ATHLETE_INVITE_COLLECTION]);
export const GUARDIAN_CONSENT_VERSION = 'athlete-app-guardian-consent-v1';

const text = (v) => String(v ?? '').trim();
const list = (v) => (Array.isArray(v) ? v : []);
const sha256 = (v) => crypto.createHash('sha256').update(String(v)).digest('hex');
const secret = () => crypto.randomBytes(32).toString('base64url');

export function sameHash(a, b) {
  const x = Buffer.from(text(a), 'hex'); const y = Buffer.from(text(b), 'hex');
  return x.length === 32 && y.length === 32 && crypto.timingSafeEqual(x, y);
}

export function parseInviteToken(token) {
  const parts = text(token).split('.');
  if (parts.length !== 4 || !['AXA1', 'AXG1'].includes(parts[0])) return null;
  const [kind, tenantKey, inviteId, sec] = parts;
  if (!/^[a-z0-9._-]{1,120}$/i.test(tenantKey) || !/^ai_[a-z0-9]{8,40}$/.test(inviteId) || !/^[A-Za-z0-9_-]{40,60}$/.test(sec)) return null;
  return { kind: kind === 'AXA1' ? 'athlete' : 'guardian', tenantKey, inviteId, secret: sec };
}

export function swimmerDisplayName(row = {}) {
  return text(row.name) || `${text(row.firstName)} ${text(row.lastName)}`.trim() || text(row.id);
}

export function swimmerAgeYears(row = {}, at = new Date()) {
  const raw = text(row.dob || row.dateOfBirth || row.birthDate || row.dateOfBirthIso);
  const m = raw.match(/^(\d{4})-(\d{2})-(\d{2})/) || raw.match(/^(\d{2})[/.-](\d{2})[/.-](\d{4})$/);
  if (!m) return null;
  const [y, mo, d] = raw.match(/^\d{4}/) ? [Number(m[1]), Number(m[2]), Number(m[3])] : [Number(m[3]), Number(m[2]), Number(m[1])];
  const now = at instanceof Date ? at : new Date(at);
  let age = now.getUTCFullYear() - y;
  if (now.getUTCMonth() + 1 < mo || (now.getUTCMonth() + 1 === mo && now.getUTCDate() < d)) age -= 1;
  return Number.isFinite(age) ? age : null;
}

// Under 18, or no date of birth on record: a parent/guardian must authorise before the athlete can accept.
export function guardianRequiredFor(row = {}, at = new Date()) {
  const age = swimmerAgeYears(row, at);
  return age === null || age < 18;
}

export function linkedAccountOf(row = {}) {
  return { username: text(row.swimmerAccountUsername), email: text(row.swimmerAccountEmail) };
}

export function inviteStatus(invite = {}, now = Date.now()) {
  if (invite.revokedAt) return 'revoked';
  if (invite.acceptedAt) return 'accepted';
  if (!(Date.parse(invite.expiresAt) > now)) return 'expired';
  if (invite.guardianRequired && !invite.guardianConsent) return 'awaiting-guardian';
  return 'pending';
}

// Public view of an invitation (no hashes, no account details).
export function publicInvite(invite = {}, now = Date.now()) {
  return {
    id: text(invite.id), swimmerId: text(invite.swimmerId), status: inviteStatus(invite, now),
    createdAt: text(invite.createdAt), createdBy: text(invite.createdBy), expiresAt: text(invite.expiresAt),
    targetEmail: text(invite.targetEmail), guardianRequired: invite.guardianRequired === true,
    guardianConsentAt: text(invite.guardianConsent?.at), acceptedAt: text(invite.acceptedAt), acceptedBy: text(invite.acceptedBy),
    revokedAt: text(invite.revokedAt), revokedBy: text(invite.revokedBy),
  };
}

export function createAthleteInvite(db = {}, { swimmerId, tenantKey, clubName = '', actor, targetEmail = '', guardianEmail = '', ttlHours = 168, now = new Date() } = {}) {
  const swimmers = list(db.swimmers);
  const row = swimmers.find((s) => text(s?.id) === text(swimmerId));
  if (!row) return { ok: false, status: 404, error: 'Swimmer not found in this club.' };
  if (text(row.status).toLowerCase() === 'deleted' || row.deletedAt) return { ok: false, status: 409, error: 'This swimmer record is deleted.' };
  const linked = linkedAccountOf(row);
  if (linked.username || linked.email) return { ok: false, status: 409, error: 'This swimmer is already linked to an Athlete App account. Use "Correct account link" first if the link is wrong.' };
  if (targetEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(targetEmail)) return { ok: false, status: 400, error: 'Enter a valid athlete email address.' };
  const guardianRequired = guardianRequiredFor(row, now);
  const id = `ai_${crypto.randomBytes(12).toString('hex')}`;
  const athleteSecret = secret(); const guardianSecret = guardianRequired ? secret() : '';
  const invite = {
    id, swimmerId: text(row.id), tenantKey: text(tenantKey), createdAt: now.toISOString(), createdBy: text(actor),
    expiresAt: new Date(now.getTime() + Math.max(1, Number(ttlHours) || 168) * 3600 * 1000).toISOString(),
    targetEmail: text(targetEmail).toLowerCase(), tokenHash: sha256(athleteSecret),
    guardianRequired, guardianEmail: text(guardianEmail).toLowerCase(), guardianTokenHash: guardianSecret ? sha256(guardianSecret) : '',
    guardianConsent: null, acceptedAt: '', acceptedBy: '', revokedAt: '', revokedBy: '',
  };
  // One live invitation per swimmer: earlier pending ones are revoked.
  const invites = list(db[ATHLETE_INVITE_COLLECTION]).map((inv) => (text(inv.swimmerId) === invite.swimmerId && ['pending', 'awaiting-guardian'].includes(inviteStatus(inv, now.getTime()))
    ? { ...inv, revokedAt: now.toISOString(), revokedBy: `${text(actor)} (replaced)` } : inv));
  invites.push(invite);
  return {
    ok: true, invite, db: { ...db, [ATHLETE_INVITE_COLLECTION]: invites },
    athleteToken: `AXA1.${invite.tenantKey}.${id}.${athleteSecret}`,
    guardianToken: guardianSecret ? `AXG1.${invite.tenantKey}.${id}.${guardianSecret}` : '',
    swimmerName: swimmerDisplayName(row), clubName,
  };
}

// Finds the invitation a token proves. Every failure looks the same to the caller.
export function resolveInvite(db = {}, parsed, kind) {
  if (!parsed || parsed.kind !== kind) return null;
  const invite = list(db[ATHLETE_INVITE_COLLECTION]).find((inv) => text(inv.id) === parsed.inviteId && text(inv.tenantKey) === parsed.tenantKey);
  if (!invite) return null;
  const hash = sha256(parsed.secret);
  return sameHash(hash, kind === 'athlete' ? invite.tokenHash : invite.guardianTokenHash) ? invite : null;
}

export function recordGuardianConsent(db = {}, parsed, { name, relationship, email, consent, consentVersion, now = new Date(), ip = '' } = {}) {
  const invite = resolveInvite(db, parsed, 'guardian');
  if (!invite) return { ok: false, status: 404, error: 'This parent/guardian link is not valid.' };
  const status = inviteStatus(invite, now.getTime());
  if (['revoked', 'accepted', 'expired'].includes(status)) return { ok: false, status: 410, error: `This invitation is ${status}.` };
  if (invite.guardianConsent) return { ok: true, already: true, invite };
  if (consent !== true || consentVersion !== GUARDIAN_CONSENT_VERSION) return { ok: false, status: 400, error: 'Parent/guardian consent must be confirmed.' };
  if (!text(name) || !text(relationship)) return { ok: false, status: 400, error: 'Enter the parent/guardian name and relationship.' };
  if (invite.guardianEmail && text(email).toLowerCase() !== invite.guardianEmail) return { ok: false, status: 403, error: 'This link was issued to a different parent/guardian email.' };
  const guardianConsent = { at: now.toISOString(), name: text(name), relationship: text(relationship), email: text(email).toLowerCase(), version: GUARDIAN_CONSENT_VERSION, ip: text(ip) };
  const invites = list(db[ATHLETE_INVITE_COLLECTION]).map((inv) => (inv.id === invite.id ? { ...inv, guardianConsent } : inv));
  return { ok: true, invite: { ...invite, guardianConsent }, db: { ...db, [ATHLETE_INVITE_COLLECTION]: invites } };
}

// Checks an athlete token for acceptance by `account` ({username, email}). No writes.
export function checkAcceptance(db = {}, parsed, account = {}, now = new Date()) {
  const invite = resolveInvite(db, parsed, 'athlete');
  if (!invite) return { ok: false, status: 404, error: 'This invitation link is not valid.' };
  const username = text(account.username); const email = text(account.email).toLowerCase();
  const swimmers = list(db.swimmers);
  const row = swimmers.find((s) => text(s?.id) === text(invite.swimmerId));
  const status = inviteStatus(invite, now.getTime());
  if (status === 'accepted') {
    if (username && text(invite.acceptedBy).toLowerCase() === username.toLowerCase()) return { ok: true, already: true, invite, row };
    return { ok: false, status: 409, error: 'This invitation has already been used.' };
  }
  if (status === 'revoked') return { ok: false, status: 410, error: 'This invitation was withdrawn by the club.' };
  if (status === 'expired') return { ok: false, status: 410, error: 'This invitation has expired. Ask the club for a new one.' };
  if (status === 'awaiting-guardian') return { ok: false, status: 403, error: 'A parent or guardian must authorise this invitation first.' };
  if (invite.targetEmail && email !== invite.targetEmail) return { ok: false, status: 403, error: 'This invitation was issued to a different email address.' };
  if (!row || text(row.status).toLowerCase() === 'deleted' || row.deletedAt) return { ok: false, status: 409, error: 'The swimmer record for this invitation is no longer available.' };
  const linked = linkedAccountOf(row);
  if (linked.username && linked.username.toLowerCase() !== username.toLowerCase()) return { ok: false, status: 409, error: 'This swimmer is already linked to another account. The club must correct the link first.' };
  if (username) {
    const other = swimmers.find((s) => text(s?.id) !== text(row.id) && text(s?.swimmerAccountUsername).toLowerCase() === username.toLowerCase());
    if (other) return { ok: false, status: 409, error: 'This account is already linked to another swimmer in this club.' };
  }
  return { ok: true, invite, row };
}

// Applies the link to the existing swimmer row and marks the invitation used.
export function applyAcceptance(db = {}, invite, account = {}, now = new Date()) {
  const at = now.toISOString();
  const swimmers = list(db.swimmers).map((s) => {
    if (text(s?.id) !== text(invite.swimmerId)) return s;
    return {
      ...s,
      swimmerAccountUsername: text(account.username),
      swimmerAccountEmail: text(account.email).toLowerCase(),
      accountLinkedAt: at,
      accountLinkInviteId: invite.id,
      accountLinkHistory: [...list(s.accountLinkHistory), { action: 'linked', at, username: text(account.username), inviteId: invite.id, by: 'athlete-invite' }],
    };
  });
  const invites = list(db[ATHLETE_INVITE_COLLECTION]).map((inv) => (inv.id === invite.id ? { ...inv, acceptedAt: at, acceptedBy: text(account.username) } : inv));
  return { ...db, swimmers, [ATHLETE_INVITE_COLLECTION]: invites };
}

export function revokeInvite(db = {}, inviteId, actor, now = new Date()) {
  const invite = list(db[ATHLETE_INVITE_COLLECTION]).find((inv) => text(inv.id) === text(inviteId));
  if (!invite) return { ok: false, status: 404, error: 'Invitation not found.' };
  const status = inviteStatus(invite, now.getTime());
  if (status === 'accepted') return { ok: false, status: 409, error: 'This invitation was already accepted. Use "Correct account link" instead.' };
  if (status === 'revoked') return { ok: true, already: true, invite };
  const invites = list(db[ATHLETE_INVITE_COLLECTION]).map((inv) => (inv.id === invite.id ? { ...inv, revokedAt: now.toISOString(), revokedBy: text(actor) } : inv));
  return { ok: true, invite, db: { ...db, [ATHLETE_INVITE_COLLECTION]: invites } };
}

// Authorised correction: removes the account link only. Every session, attendance, test, result,
// observation and analysis stays on the swimmer record; the history keeps who was linked and why.
export function unlinkAthleteAccount(db = {}, swimmerId, { actor, reason, now = new Date() } = {}) {
  if (text(reason).length < 5) return { ok: false, status: 400, error: 'Give a reason for correcting the link (at least 5 characters).' };
  const row = list(db.swimmers).find((s) => text(s?.id) === text(swimmerId));
  if (!row) return { ok: false, status: 404, error: 'Swimmer not found in this club.' };
  const previous = linkedAccountOf(row);
  if (!previous.username && !previous.email) return { ok: false, status: 409, error: 'This swimmer has no linked account.' };
  const at = now.toISOString();
  const swimmers = list(db.swimmers).map((s) => {
    if (text(s?.id) !== text(swimmerId)) return s;
    const next = { ...s, accountLinkHistory: [...list(s.accountLinkHistory), { action: 'unlinked', at, username: previous.username, by: text(actor), reason: text(reason) }] };
    delete next.swimmerAccountUsername; delete next.swimmerAccountEmail; delete next.accountLinkedAt; delete next.accountLinkInviteId;
    return next;
  });
  const invites = list(db[ATHLETE_INVITE_COLLECTION]).map((inv) => (text(inv.swimmerId) === text(swimmerId) && ['pending', 'awaiting-guardian'].includes(inviteStatus(inv, now.getTime()))
    ? { ...inv, revokedAt: at, revokedBy: `${text(actor)} (link corrected)` } : inv));
  return { ok: true, previous, db: { ...db, swimmers, [ATHLETE_INVITE_COLLECTION]: invites } };
}

// Whole-club saves (PUT /db) cannot touch server-owned data: the invitation collection and the
// account-link fields of swimmer rows always keep the stored values.
export function preserveServerOwnedAthleteData(nextShape = {}, existingShape = {}) {
  const out = { ...nextShape };
  for (const key of SERVER_OWNED_COLLECTIONS) {
    if (Array.isArray(existingShape?.[key])) out[key] = existingShape[key];
    else delete out[key];
  }
  if (Array.isArray(out.swimmers)) {
    const stored = new Map(list(existingShape?.swimmers).map((s) => [text(s?.id), s]));
    out.swimmers = out.swimmers.map((row) => {
      if (!row || typeof row !== 'object') return row;
      const prev = stored.get(text(row.id));
      const next = { ...row };
      for (const f of ATHLETE_LINK_FIELDS) {
        if (prev && prev[f] !== undefined) next[f] = prev[f];
        else delete next[f];
      }
      return next;
    });
  }
  return out;
}
