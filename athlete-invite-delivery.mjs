// AthlyraX automated Athlete App invitations: contacts, bulk planning, email content and delivery state.
// Builds on athlete-account-invites.mjs (tokens, expiry, guardian consent, acceptance stay unchanged).
//
// - Invitation contacts live on the existing swimmer row in `athleteContacts` (server-owned: a
//   whole-club save cannot change them). Imported contact fields (email, parentEmail, ...) are only
//   read to pre-fill; they are never rewritten.
// - A saved address is replaced only with explicit confirmation; every change is kept in history.
// - Automatic invitations (delivery: 'email') never hand a link to the coach. Under-18 athletes get
//   only the parent/guardian link first; the athlete link is minted and emailed after consent.
// - Delivery records hold provider, message id and status only; never a token or code.
import crypto from 'node:crypto';
import { ATHLETE_INVITE_COLLECTION, inviteStatus, uniqueSwimmerRow, swimmerDisplayName, linkedAccountOf, guardianRequiredFor, swimmerAgeYears, maskEmail } from './athlete-account-invites.mjs';

export const CONTACT_FIELD = 'athleteContacts';
export const BULK_MAX_ITEMS = 60;
export const DELIVERY_MAX_RECORDS = 20;
export const RESEND_MIN_SECONDS = 60;
export const RESEND_MAX_SENDS = 5;
export const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const COACH_STATE_LABELS = Object.freeze({
  'not-invited': 'Not invited',
  'awaiting-guardian': 'Awaiting guardian consent',
  'awaiting-athlete-email': 'Consent given: athlete email needed',
  'invitation-sent': 'Invitation sent',
  linked: 'Linked',
  expired: 'Expired',
  revoked: 'Revoked',
  'delivery-failed': 'Email delivery failed',
});

const text = (v) => String(v ?? '').trim();
const list = (v) => (Array.isArray(v) ? v : []);
const sha256 = (v) => crypto.createHash('sha256').update(String(v)).digest('hex');
const newSecret = () => crypto.randomBytes(32).toString('base64url');
export const normalizeEmail = (v) => text(v).toLowerCase();
export const validEmail = (v) => EMAIL_PATTERN.test(text(v)) && text(v).length <= 254;

// ---------- contacts ----------
const LEGACY_ATHLETE_EMAIL = ['email', 'swimmerEmail'];
const LEGACY_GUARDIAN_EMAIL = ['parentGuardianEmail', 'parentEmail', 'guardianEmail', 'parent1Email', 'primaryGuardianEmail'];
const firstValid = (row, fields) => { for (const f of fields) { const v = normalizeEmail(row?.[f]); if (validEmail(v)) return { value: v, source: f }; } return { value: '', source: '' }; };

// Saved invitation contacts, then imported club fields as a suggestion (marked source: 'imported:<field>').
export function savedContacts(row = {}) {
  const c = row?.[CONTACT_FIELD] && typeof row[CONTACT_FIELD] === 'object' ? row[CONTACT_FIELD] : {};
  const a = validEmail(c.athleteEmail) ? { value: normalizeEmail(c.athleteEmail), source: 'saved' } : (() => { const l = firstValid(row, LEGACY_ATHLETE_EMAIL); return l.value ? { value: l.value, source: `imported:${l.source}` } : l; })();
  const g = validEmail(c.guardianEmail) ? { value: normalizeEmail(c.guardianEmail), source: 'saved' } : (() => { const l = firstValid(row, LEGACY_GUARDIAN_EMAIL); return l.value ? { value: l.value, source: `imported:${l.source}` } : l; })();
  return { athleteEmail: a.value, athleteSource: a.source, guardianEmail: g.value, guardianSource: g.source };
}

// Applies the coach's "save" choices to one swimmer row. A different saved address is replaced only
// when confirmReplace is set; otherwise a conflict is returned and nothing changes.
export function applyContactChoice(row = {}, { athleteEmail = '', guardianEmail = '', saveAthlete = false, saveGuardian = false, confirmReplaceAthlete = false, confirmReplaceGuardian = false, actor = '', now = new Date() } = {}) {
  const c = row?.[CONTACT_FIELD] && typeof row[CONTACT_FIELD] === 'object' ? row[CONTACT_FIELD] : {};
  const next = { ...c }; const history = list(c.history).slice(-49); const conflicts = []; let changed = false;
  const at = now.toISOString();
  const step = (kind, value, save, confirm) => {
    if (!save) return;
    const v = normalizeEmail(value);
    if (!validEmail(v)) return;
    const key = kind === 'athlete' ? 'athleteEmail' : 'guardianEmail';
    const prev = normalizeEmail(c[key]);
    if (prev === v) return;
    if (prev && !confirm) { conflicts.push({ kind, saved: prev, proposed: v }); return; }
    next[key] = v;
    history.push({ field: key, from: prev, to: v, at, by: text(actor), action: prev ? 'replaced' : 'saved' });
    changed = true;
  };
  step('athlete', athleteEmail, saveAthlete, confirmReplaceAthlete);
  step('guardian', guardianEmail, saveGuardian, confirmReplaceGuardian);
  if (conflicts.length) return { ok: false, conflicts, row };
  if (!changed) return { ok: true, changed: false, row };
  return { ok: true, changed: true, row: { ...row, [CONTACT_FIELD]: { ...next, updatedAt: at, updatedBy: text(actor), history } } };
}

// ---------- coach-facing state ----------
export function lastDelivery(invite = {}) { const d = list(invite.deliveries); return d.length ? d[d.length - 1] : null; }
const failedDelivery = (d) => d && ['failed', 'bounced'].includes(d.status);

export function latestInviteFor(db = {}, swimmerId) {
  return list(db[ATHLETE_INVITE_COLLECTION]).filter((i) => text(i?.swimmerId) === text(swimmerId))
    .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt))).pop() || null;
}

export function coachInviteState(row = {}, invite = null, now = Date.now()) {
  const linked = linkedAccountOf(row);
  if (linked.username || linked.email) return 'linked';
  if (!invite) return 'not-invited';
  const s = inviteStatus(invite, now);
  if (s === 'accepted') return 'not-invited'; // accepted then unlinked by a correction
  if (s === 'revoked') return 'revoked';
  if (s === 'expired') return 'expired';
  if (failedDelivery(lastDelivery(invite))) return 'delivery-failed';
  if (s === 'awaiting-guardian') return 'awaiting-guardian';
  if (invite.delivery === 'email' && !invite.targetEmail) return 'awaiting-athlete-email';
  return 'invitation-sent';
}

const active = (row) => row && text(row.status).toLowerCase() !== 'deleted' && !row.deletedAt;

const squadName = (db, row) => { const id = text(row.currentSquadId || row.squadId); const sq = list(db.squads).find((q) => text(q?.id) === id); return text(sq?.name || row.squad || row.squadName || id); };

export function overviewRow(db, row, now = new Date()) {
  const invite = latestInviteFor(db, row.id);
  const contacts = savedContacts(row);
  const d = invite ? lastDelivery(invite) : null;
  const state = coachInviteState(row, invite, now.getTime());
  return {
    swimmerId: text(row.id), name: swimmerDisplayName(row), squadId: text(row.currentSquadId || row.squadId), squad: squadName(db, row),
    age: swimmerAgeYears(row, now), guardianRequired: guardianRequiredFor(row, now),
    ...contacts, state, stateLabel: COACH_STATE_LABELS[state],
    linkedUsername: linkedAccountOf(row).username,
    invite: invite ? {
      id: text(invite.id), status: inviteStatus(invite, now.getTime()), delivery: text(invite.delivery) || 'link', createdAt: text(invite.createdAt), expiresAt: text(invite.expiresAt),
      targetEmail: text(invite.targetEmail), guardianEmail: text(invite.guardianEmail), guardianConsentAt: text(invite.guardianConsent?.at),
      lastDelivery: d ? { kind: d.kind, to: maskEmail(d.to), status: d.status, at: d.at, updatedAt: d.updatedAt || d.at, error: text(d.error) } : null,
    } : null,
  };
}

export function clubOverview(db = {}, now = new Date()) {
  return list(db.swimmers).filter(active).map((row) => overviewRow(db, row, now));
}

// ---------- email content ----------
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtDate = (iso) => { const d = new Date(iso); return Number.isFinite(d.getTime()) ? d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }) : ''; };

// kind: 'guardian' | 'athlete'. link is null for a preview (shown as a placeholder).
export function buildInviteEmail({ kind, clubName, coachName, swimmerName, link, expiresAt, replyTo }) {
  const club = text(clubName) || 'Your club'; const coach = text(coachName) || 'your coach';
  const swimmer = text(swimmerName) || 'the athlete'; const first = swimmer.split(' ')[0];
  const url = link || '[secure invitation link]'; const until = fmtDate(expiresAt);
  const isGuardian = kind === 'guardian';
  const subject = isGuardian
    ? `${club}: please authorise ${first}'s AthlyraX Athlete App access`
    : `${club} has invited you to the AthlyraX Athlete App`;
  const purpose = isGuardian
    ? [`${coach} at ${club} has invited ${swimmer} to the AthlyraX Athlete App, where ${first} can see their club training, tests and progress.`,
      `Because ${first} is under 18 (or no date of birth is recorded), a parent or guardian must authorise this first. Open the secure link, confirm a one-time code that we email to this address, and give consent. Nothing is shared with ${first} until you do.`]
    : [`${coach} at ${club} has invited you (${swimmer}) to the AthlyraX Athlete App. It links your login to your existing club swimmer record, so you can see your club sessions, tests and progress.`,
      'Your private diary and personal notes are never shared with the club automatically.'];
  const lines = [
    ...purpose, '',
    `Secure link (works once): ${url}`,
    until ? `The link expires on ${until}.` : '',
    '',
    replyTo ? `Questions? Reply to this email to contact ${club}.` : `Questions? Contact ${club} or your coach directly.`,
    'If you did not expect this email, you can ignore it; nothing happens unless the link is used.',
    '', 'AthlyraX, sent on behalf of ' + club + '. This is a one-off service email, not a marketing subscription.',
  ].filter((l, i, a) => !(l === '' && a[i - 1] === ''));
  const html = `<!doctype html><html><body style="font-family:Arial,Helvetica,sans-serif;color:#0f172a;line-height:1.5;max-width:560px">`
    + `<p style="font-size:12px;color:#475569;margin:0 0 12px">AthlyraX · ${esc(club)}</p>`
    + purpose.map((p) => `<p>${esc(p)}</p>`).join('')
    + `<p><a href="${esc(url)}" style="display:inline-block;background:#0284c7;color:#fff;padding:10px 16px;border-radius:6px;text-decoration:none">${isGuardian ? 'Review and authorise' : 'Accept invitation'}</a></p>`
    + `<p style="font-size:13px;color:#475569">The link works once${until ? ` and expires on ${esc(until)}` : ''}. If the button does not work, copy this address into your browser:<br><span style="word-break:break-all">${esc(url)}</span></p>`
    + `<p style="font-size:13px;color:#475569">${replyTo ? `Questions? Reply to this email to contact ${esc(club)}.` : `Questions? Contact ${esc(club)} or your coach directly.`} If you did not expect this email, ignore it; nothing happens unless the link is used.</p>`
    + `<p style="font-size:12px;color:#64748b">AthlyraX, sent on behalf of ${esc(club)}. This is a one-off service email, not a marketing subscription.</p></body></html>`;
  return { subject, text: lines.join('\n'), html };
}

// ---------- invites created for automatic delivery ----------
export function markAutoDelivery(db = {}, inviteId, { requestId = '' } = {}) {
  const invites = list(db[ATHLETE_INVITE_COLLECTION]).map((inv) => (inv.id === inviteId ? { ...inv, delivery: 'email', bulkRequestId: text(requestId), deliveries: list(inv.deliveries) } : inv));
  return { ...db, [ATHLETE_INVITE_COLLECTION]: invites };
}

// Replaces the secret of an automatic invitation and returns the new token once (old links stop
// working). Used for resend, and to mint the athlete link only after guardian consent.
export function rotateInviteToken(db = {}, inviteId, kind, { now = new Date(), targetEmail } = {}) {
  const invite = list(db[ATHLETE_INVITE_COLLECTION]).find((i) => text(i.id) === text(inviteId));
  if (!invite) return { ok: false, status: 404, error: 'Invitation not found.' };
  if (invite.delivery !== 'email') return { ok: false, status: 409, error: 'This invitation was shared as a link; create a new one to send it by email.' };
  const status = inviteStatus(invite, now.getTime());
  if (!['pending', 'awaiting-guardian'].includes(status)) return { ok: false, status: 409, error: `This invitation is ${status}.` };
  if (kind === 'athlete' && status === 'awaiting-guardian') return { ok: false, status: 403, error: 'The athlete link is sent only after parent/guardian consent.' };
  if (kind === 'guardian' && status !== 'awaiting-guardian') return { ok: false, status: 409, error: 'Parent/guardian consent is already recorded.' };
  const s = newSecret();
  const patch = kind === 'athlete' ? { tokenHash: sha256(s) } : { guardianTokenHash: sha256(s) };
  if (kind === 'athlete' && targetEmail !== undefined) patch.targetEmail = normalizeEmail(targetEmail);
  const invites = list(db[ATHLETE_INVITE_COLLECTION]).map((inv) => (inv.id === invite.id ? { ...inv, ...patch } : inv));
  const prefix = kind === 'athlete' ? 'AXA1' : 'AXG1';
  return { ok: true, invite: { ...invite, ...patch }, token: `${prefix}.${invite.tenantKey}.${invite.id}.${s}`, db: { ...db, [ATHLETE_INVITE_COLLECTION]: invites } };
}

// Resend limits per invitation and kind.
export function resendAllowed(invite = {}, kind, now = new Date()) {
  const sends = list(invite.deliveries).filter((d) => d.kind === kind);
  if (sends.length >= RESEND_MAX_SENDS) return { ok: false, status: 429, error: 'This invitation has been sent the maximum number of times. Withdraw it and create a new one.' };
  const last = sends.filter((d) => d.status !== 'failed').pop(); // a failed attempt can be retried at once
  if (last && now.getTime() - Date.parse(last.at) < RESEND_MIN_SECONDS * 1000) return { ok: false, status: 429, error: 'Please wait a minute before sending again.' };
  return { ok: true };
}

// ---------- delivery records ----------
export const newDeliveryId = () => `dl_${crypto.randomBytes(6).toString('hex')}`;

// Updates one delivery after the provider answered (queued -> sent | failed).
export function updateDelivery(db = {}, inviteId, deliveryId, { provider, messageId, status, error = '', now = new Date() }) {
  const invites = list(db[ATHLETE_INVITE_COLLECTION]).map((inv) => (inv.id !== inviteId ? inv : { ...inv, deliveries: list(inv.deliveries).map((d) => (d.id !== deliveryId ? d : {
    ...d, provider: text(provider) || d.provider, messageId: text(messageId) || d.messageId, status: RANK[d.status] > RANK[status] ? d.status : status, updatedAt: now.toISOString(), error: safeError(error),
  })) }));
  return { ...db, [ATHLETE_INVITE_COLLECTION]: invites };
}
const safeError = (e) => text(e).replace(/AX[AG]1\.[^\s]+/g, '[link]').replace(/\b\d{6}\b/g, '[code]').slice(0, 160);

export function recordDelivery(db = {}, inviteId, { id = '', kind, to, provider, messageId = '', status, error = '', now = new Date() }) {
  const at = now.toISOString();
  const entry = { id: text(id) || newDeliveryId(), kind, to: normalizeEmail(to), provider: text(provider), messageId: text(messageId), status, at, updatedAt: at, error: safeError(error), events: [] };
  const invites = list(db[ATHLETE_INVITE_COLLECTION]).map((inv) => (inv.id === inviteId ? { ...inv, deliveries: [...list(inv.deliveries), entry].slice(-DELIVERY_MAX_RECORDS) } : inv));
  return { ...db, [ATHLETE_INVITE_COLLECTION]: invites };
}

// Provider event -> delivery status. Opens and clicks are not tracked.
const EVENT_STATUS = {
  request: 'sent', sent: 'sent', delivered: 'delivered', deferred: 'deferred', soft_bounce: 'deferred', softbounce: 'deferred',
  hard_bounce: 'bounced', hardbounce: 'bounced', blocked: 'failed', invalid_email: 'bounced', invalid: 'bounced', error: 'failed', spam: 'failed', complaint: 'failed',
};
const RANK = { queued: 0, sent: 1, deferred: 2, delivered: 3, bounced: 4, failed: 4 };
export function eventStatus(event) { return EVENT_STATUS[text(event).toLowerCase().replace(/\s+/g, '_')] || ''; }

export function applyDeliveryEvent(db = {}, { messageId, event, at, reason = '' }) {
  const id = text(messageId).replace(/^<|>$/g, '');
  const status = eventStatus(event);
  if (!id || !status) return { ok: false };
  let hit = false;
  const invites = list(db[ATHLETE_INVITE_COLLECTION]).map((inv) => {
    const ds = list(inv.deliveries);
    if (!ds.some((d) => d.messageId && d.messageId.replace(/^<|>$/g, '') === id)) return inv;
    hit = true;
    return { ...inv, deliveries: ds.map((d) => {
      if (!d.messageId || d.messageId.replace(/^<|>$/g, '') !== id) return d;
      const keep = RANK[d.status] > RANK[status] && !(d.status === 'deferred' && status !== 'deferred');
      return { ...d, status: keep ? d.status : status, updatedAt: text(at) || new Date().toISOString(), error: status === 'bounced' || status === 'failed' ? safeError(reason || event) : d.error, events: [...list(d.events), { event: text(event).toLowerCase(), at: text(at) }].slice(-10) };
    }) };
  });
  return hit ? { ok: true, db: { ...db, [ATHLETE_INVITE_COLLECTION]: invites } } : { ok: false };
}

// ---------- bulk planning ----------
// Validates one review row against the club data. Returns a plan (what will be sent) or a skip reason.
export function planBulkItem(db = {}, item = {}, now = new Date()) {
  const swimmerId = text(item.swimmerId);
  const { row, duplicate } = uniqueSwimmerRow(db, swimmerId);
  const name = row ? swimmerDisplayName(row) : '';
  const skip = (code, message) => ({ ok: false, swimmerId, name, code, message });
  if (duplicate) return skip('duplicate-record', 'This swimmer id appears more than once in the club data.');
  if (!row || !active(row)) return skip('not-found', 'Swimmer not found in this club.');
  const linked = linkedAccountOf(row);
  if (linked.username || linked.email) return skip('already-linked', 'Already linked to an Athlete App login.');
  const open = list(db[ATHLETE_INVITE_COLLECTION]).find((i) => text(i.swimmerId) === swimmerId && ['pending', 'awaiting-guardian'].includes(inviteStatus(i, now.getTime())));
  if (open) return skip('already-invited', 'An invitation is already open. Use Resend or Withdraw.');
  const athleteEmail = normalizeEmail(item.athleteEmail); const guardianEmail = normalizeEmail(item.guardianEmail);
  if (athleteEmail && !validEmail(athleteEmail)) return skip('invalid-athlete-email', 'The athlete email is not valid.');
  if (guardianEmail && !validEmail(guardianEmail)) return skip('invalid-guardian-email', 'The parent/guardian email is not valid.');
  const guardianRequired = guardianRequiredFor(row, now);
  if (guardianRequired && !guardianEmail) return skip('missing-guardian-email', 'Under 18 or no date of birth: a parent/guardian email is required.');
  if (guardianRequired && athleteEmail && athleteEmail === guardianEmail) return skip('same-email', 'The parent/guardian email must differ from the athlete email.');
  if (!guardianRequired && !athleteEmail) return skip('missing-athlete-email', 'An athlete email is required.');
  return { ok: true, swimmerId, name, row, athleteEmail, guardianEmail: guardianRequired ? guardianEmail : '', guardianRequired, sendTo: guardianRequired ? 'guardian' : 'athlete' };
}

export function dedupeBulkItems(items = []) {
  const seen = new Set(); const out = []; const dupes = [];
  for (const it of list(items)) { const id = text(it?.swimmerId); if (!id) continue; if (seen.has(id)) { dupes.push(id); continue; } seen.add(id); out.push(it); }
  return { items: out, dupes };
}
