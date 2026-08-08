import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const REQUIRED_SIGNUP_LEGAL_VERSIONS = Object.freeze({
  terms: '2026-08-06',
  dataProcessingAgreement: '2026-08-06',
  clubDataProtection: '2026-08-06',
});

const PATCH_MARKER = Symbol.for('athlyrax.signupLegalAcceptanceGuardInstalled');

function cleanText(value, maxLength = 250) {
  return String(value || '').trim().slice(0, maxLength);
}

function normalizeTenantPart(value, fallback) {
  const normalized = cleanText(value, 160)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return normalized || fallback;
}

function resolveRequestIp(req) {
  const forwarded = cleanText(req?.headers?.['x-forwarded-for'], 300)
    .split(',')
    .map((value) => value.trim())
    .find(Boolean);
  return forwarded || cleanText(req?.ip || req?.socket?.remoteAddress, 120);
}

function resolveStorageRoot() {
  const overridePath = cleanText(process.env.ATHLYRAX_STORAGE_ROOT, 1000);
  return overridePath ? path.resolve(overridePath) : path.resolve('storage');
}

function resolveAcceptancePath() {
  const canonicalPath = path.join(resolveStorageRoot(), 'legal-acceptances.jsonl');
  const configuredPath = cleanText(process.env.AUTH_LEGAL_ACCEPTANCE_PATH, 1000);
  if (configuredPath && path.resolve(configuredPath) !== canonicalPath) {
    throw new Error(`AUTH_LEGAL_ACCEPTANCE_PATH must equal the canonical path: ${canonicalPath}`);
  }
  return canonicalPath;
}

function resolveSafetyAcceptancePath() {
  const production = cleanText(process.env.NODE_ENV, 40).toLowerCase() === 'production';
  const safetyRoot = cleanText(process.env.ATHLYRAX_SAFETY_BACKUP_ROOT, 1000);
  if (!safetyRoot) {
    if (production) throw new Error('ATHLYRAX_SAFETY_BACKUP_ROOT is required to persist production legal acceptance evidence.');
    return '';
  }
  return path.join(path.resolve(safetyRoot), 'legal-acceptances', 'legal-acceptances.jsonl');
}

function versionMatches(actual, expected) {
  return cleanText(actual, 40) === expected;
}

export function validateSignupLegalAcceptance(body) {
  const source = body && typeof body === 'object' ? body : {};
  const versions = source?.legalDocumentVersions && typeof source.legalDocumentVersions === 'object'
    ? source.legalDocumentVersions
    : {};
  const swimClub = cleanText(source?.swimClub, 180);
  const teamName = cleanText(source?.teamName, 180);

  if (!swimClub || !teamName) {
    return {
      ok: false,
      error: 'Swim club and team name are required for the Data Processing Agreement.',
    };
  }

  if (source.dpaAccepted !== true || source.clubDataProtectionConfirmed !== true) {
    return {
      ok: false,
      error: 'You must accept the AthlyraX Data Processing Agreement and confirm the club data-protection requirements.',
    };
  }

  const versionsValid = Object.entries(REQUIRED_SIGNUP_LEGAL_VERSIONS)
    .every(([key, expected]) => versionMatches(versions?.[key], expected));
  if (!versionsValid) {
    return {
      ok: false,
      error: 'The legal documents changed. Reload the signup page, review the current documents and confirm them again.',
    };
  }

  return { ok: true, versions: { ...REQUIRED_SIGNUP_LEGAL_VERSIONS } };
}

export function buildSignupLegalAcceptanceRecord({ req, responsePayload, acceptedAt, stage = 'completed' } = {}) {
  const body = req?.body && typeof req.body === 'object' ? req.body : {};
  const responseUser = responsePayload?.user && typeof responsePayload.user === 'object'
    ? responsePayload.user
    : {};
  const username = cleanText(responseUser?.username || body?.username, 80).toLowerCase();
  const swimClub = cleanText(responseUser?.swimClub || body?.swimClub, 180);
  const teamName = cleanText(responseUser?.teamName || body?.teamName, 180);
  const tenantId = cleanText(responseUser?.tenantId, 180)
    || `${normalizeTenantPart(swimClub, 'club')}__${normalizeTenantPart(teamName, `user-${normalizeTenantPart(username, 'unknown')}`)}`;
  const timestamp = cleanText(acceptedAt, 60) || new Date().toISOString();

  return {
    eventId: `legal_${crypto.randomUUID()}`,
    eventType: 'signup-data-protection-acceptance',
    stage: cleanText(stage, 40) || 'completed',
    acceptedAt: timestamp,
    username,
    email: cleanText(responseUser?.email || body?.email, 254).toLowerCase(),
    tenantId,
    swimClub,
    teamName,
    role: cleanText(responseUser?.role, 80),
    documentVersions: { ...REQUIRED_SIGNUP_LEGAL_VERSIONS },
    confirmations: {
      authorisedClubRepresentativeAndDpa: true,
      clubLawfulBasisAndPrivacyInformation: true,
    },
    ipAddress: resolveRequestIp(req),
    userAgent: cleanText(req?.headers?.['user-agent'], 500),
  };
}

function appendDurableLine(targetPath, line, label) {
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  const beforeSize = fs.existsSync(targetPath) ? fs.statSync(targetPath).size : 0;
  let fileHandle = null;
  try {
    fileHandle = fs.openSync(targetPath, 'a', 0o600);
    fs.writeSync(fileHandle, line, null, 'utf8');
    fs.fsyncSync(fileHandle);
  } finally {
    if (fileHandle !== null) fs.closeSync(fileHandle);
  }
  const stat = fs.statSync(targetPath);
  if (!Number.isFinite(stat.size) || stat.size < beforeSize + Buffer.byteLength(line)) {
    throw new Error(`${label} append verification failed.`);
  }
  try { fs.chmodSync(targetPath, 0o600); } catch {}
  try {
    const directoryHandle = fs.openSync(path.dirname(targetPath), 'r');
    try { fs.fsyncSync(directoryHandle); } finally { fs.closeSync(directoryHandle); }
  } catch {}
}

export function appendSignupLegalAcceptanceRecord(record) {
  const targetPath = resolveAcceptancePath();
  const safetyPath = resolveSafetyAcceptancePath();
  const line = `${JSON.stringify(record)}\n`;

  // ATHLYRAX_LEGAL_ACCEPTANCE_DUAL_DURABLE_JOURNAL
  // Production signup evidence must survive loss of either the primary journal
  // or its independent safety copy. A pre-registration write fails closed if
  // either durable append cannot be verified.
  appendDurableLine(targetPath, line, 'Legal acceptance primary journal');
  if (safetyPath) appendDurableLine(safetyPath, line, 'Legal acceptance safety journal');
  return targetPath;
}

function signupLegalAcceptanceMiddleware(req, res, next) {
  const validation = validateSignupLegalAcceptance(req?.body);
  if (!validation.ok) {
    res.status(400).json({ error: validation.error });
    return;
  }

  try {
    appendSignupLegalAcceptanceRecord(buildSignupLegalAcceptanceRecord({ req, stage: 'pre-registration' }));
  } catch (error) {
    console.error('[auth] Could not persist pre-registration legal acceptance record:', error?.message || error);
    res.status(503).json({ error: 'Registration is temporarily unavailable because legal acceptance could not be recorded.' });
    return;
  }

  let responsePayload = null;
  const originalJson = typeof res?.json === 'function' ? res.json.bind(res) : null;
  if (originalJson) {
    res.json = (payload) => {
      responsePayload = payload;
      return originalJson(payload);
    };
  }

  res.once?.('finish', () => {
    const statusCode = Number(res?.statusCode || 0);
    if (statusCode < 200 || statusCode >= 300) return;
    try {
      appendSignupLegalAcceptanceRecord(buildSignupLegalAcceptanceRecord({ req, responsePayload, stage: 'completed' }));
    } catch (error) {
      console.error('[auth] Could not persist completed signup legal acceptance record:', error?.message || error);
    }
  });

  next();
}

export function installSignupLegalAcceptanceGuard(expressModule) {
  const application = expressModule?.application;
  if (!application || typeof application.post !== 'function') {
    throw new Error('Express application.post is unavailable for signup legal acceptance guard.');
  }
  if (application[PATCH_MARKER]) return;

  const originalPost = application.post;
  application.post = function patchedPost(routePath, ...handlers) {
    if (String(routePath || '') === '/auth/register') {
      return originalPost.call(this, routePath, signupLegalAcceptanceMiddleware, ...handlers);
    }
    return originalPost.call(this, routePath, ...handlers);
  };
  Object.defineProperty(application, PATCH_MARKER, { value: true, configurable: false });
}
