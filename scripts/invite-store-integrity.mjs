import fs from 'node:fs';

const ALLOWED_INVITE_ROLES = new Set(['assistant-coach', 'viewer', 'swimmer', 'head-coach']);
const TENANT_PATTERN = /^[a-z0-9_-]+$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function clean(value) { return String(value ?? '').trim(); }
function readJson(filePath, fsModule = fs) {
  try { return { ok: true, value: JSON.parse(fsModule.readFileSync(filePath, 'utf8')) }; }
  catch (error) { return { ok: false, error }; }
}

export function validateInviteStoreSemanticIntegrity(configuration, _env = process.env, fsModule = fs) {
  const filePath = configuration?.authInvitesPath;
  if (!filePath) return ['Authentication invite store path is not configured.'];
  if (!fsModule.existsSync(filePath)) return [`Authentication invite store is missing: ${filePath}`];
  const parsed = readJson(filePath, fsModule);
  if (!parsed.ok || !Array.isArray(parsed.value)) return [`Authentication invite store must contain a valid JSON array: ${filePath}`];

  const failures = [];
  const codes = new Set();
  for (const [index, row] of parsed.value.entries()) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) {
      failures.push(`Authentication invite row ${index} is invalid.`);
      continue;
    }
    const code = clean(row.code).toUpperCase();
    const role = clean(row.role || 'assistant-coach').toLowerCase();
    const tenantId = clean(row.tenantId);
    const expiresAt = clean(row.expiresAt);
    const targetEmail = clean(row.targetEmail).toLowerCase();
    const maxUses = Number(row.maxUses ?? 1);
    const usedCount = Number(row.usedCount ?? 0);

    if (!code) failures.push(`Authentication invite row ${index} has no code.`);
    else if (codes.has(code)) failures.push(`Authentication invite code is duplicated: ${code}.`);
    else codes.add(code);
    if (!ALLOWED_INVITE_ROLES.has(role)) failures.push(`Authentication invite ${code || index} has unsupported role: ${role || '(missing)'}.`);
    if (!tenantId || !TENANT_PATTERN.test(tenantId) || tenantId !== tenantId.toLowerCase() || tenantId === 'global-owner') {
      failures.push(`Authentication invite ${code || index} has invalid tenantId: ${tenantId || '(missing)'}.`);
    }
    if (!expiresAt || !Number.isFinite(Date.parse(expiresAt))) failures.push(`Authentication invite ${code || index} has invalid expiresAt.`);
    if (targetEmail && !EMAIL_PATTERN.test(targetEmail)) failures.push(`Authentication invite ${code || index} has invalid target email.`);
    if (!Number.isInteger(maxUses) || maxUses < 1) failures.push(`Authentication invite ${code || index} has invalid maxUses.`);
    if (!Number.isInteger(usedCount) || usedCount < 0 || usedCount > maxUses) failures.push(`Authentication invite ${code || index} has invalid usedCount.`);
    if (Object.prototype.hasOwnProperty.call(row, 'disabled') && typeof row.disabled !== 'boolean') failures.push(`Authentication invite ${code || index} has non-boolean disabled state.`);
  }
  return failures;
}
