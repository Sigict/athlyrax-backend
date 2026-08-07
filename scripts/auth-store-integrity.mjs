import fs from 'node:fs';

const USERNAME_PATTERN = /^[a-zA-Z0-9._-]{3,32}$/;
const ALLOWED_ROLES = new Set(['software-owner', 'head-coach', 'assistant-coach', 'viewer', 'swimmer']);
const CANONICAL_TENANT_PATTERN = /^[a-z0-9_-]+$/;

function clean(value) { return String(value ?? '').trim(); }
function usersFrom(value) { return Array.isArray(value) ? value : (value && Array.isArray(value.users) ? value.users : null); }
function readJson(filePath, label, fsModule = fs) {
  if (!fsModule.existsSync(filePath)) throw new Error(`${label} is missing: ${filePath}`);
  let value;
  try { value = JSON.parse(fsModule.readFileSync(filePath, 'utf8')); }
  catch { throw new Error(`${label} is not valid JSON: ${filePath}`); }
  return value;
}
function validScryptHash(value) {
  const raw = clean(value);
  if (!raw.startsWith('scrypt$')) return false;
  const parts = raw.split('$');
  if (parts.length !== 3 || !parts[1] || !parts[2]) return false;
  try {
    const salt = Buffer.from(parts[1], 'base64');
    const derived = Buffer.from(parts[2], 'base64');
    return salt.length >= 16 && derived.length >= 32;
  } catch { return false; }
}
function canonicalTenant(value) {
  const raw = clean(value);
  return !raw || (CANONICAL_TENANT_PATTERN.test(raw) && raw === raw.toLowerCase());
}

export function validateAuthStoreSemanticIntegrity(configuration, env = process.env, fsModule = fs) {
  if (!configuration || typeof configuration !== 'object') throw new Error('Storage configuration is required.');
  const primaryValue = readJson(configuration.authUsersPath, 'Authentication user store', fsModule);
  const backupValue = readJson(configuration.authUsersBackupPath, 'Authentication user backup', fsModule);
  const primary = usersFrom(primaryValue);
  const backup = usersFrom(backupValue);
  const failures = [];
  if (!primary || primary.length < 1) failures.push('Authentication user store must contain at least one user.');
  if (!backup || backup.length < 1) failures.push('Authentication user backup must contain at least one user.');
  if (failures.length) return failures;

  const primaryOwner = clean(env.AUTH_PRIMARY_SOFTWARE_OWNER_USERNAME || 'softwareowner').toLowerCase();
  const usernames = new Set();
  const emails = new Set();
  let primaryOwnerCount = 0;

  for (const [index, user] of primary.entries()) {
    if (!user || typeof user !== 'object' || Array.isArray(user)) {
      failures.push(`Authentication user row ${index} is invalid.`);
      continue;
    }
    const usernameRaw = clean(user.username);
    const username = usernameRaw.toLowerCase();
    const role = clean(user.role).toLowerCase();
    const email = clean(user.email).toLowerCase();
    const tenantId = clean(user.tenantId);

    if (!USERNAME_PATTERN.test(usernameRaw)) failures.push(`Authentication username is invalid: ${usernameRaw || `(row ${index})`}.`);
    if (usernames.has(username)) failures.push(`Authentication username is duplicated case-insensitively: ${usernameRaw}.`);
    else if (username) usernames.add(username);

    if (!ALLOWED_ROLES.has(role)) failures.push(`Authentication user ${usernameRaw || index} has unsupported role: ${role || '(missing)'}.`);
    if (!validScryptHash(user.passwordHash)) failures.push(`Authentication user ${usernameRaw || index} has a missing or invalid scrypt passwordHash.`);
    if (Object.prototype.hasOwnProperty.call(user, 'password') && clean(user.password)) failures.push(`Authentication user ${usernameRaw || index} contains a plaintext password field.`);
    if (!canonicalTenant(tenantId)) failures.push(`Authentication user ${usernameRaw || index} has noncanonical tenantId: ${tenantId}.`);

    if (email) {
      if (emails.has(email)) failures.push(`Authentication email is duplicated: ${email}.`);
      else emails.add(email);
    }

    if (username === primaryOwner) {
      primaryOwnerCount += 1;
      if (role !== 'software-owner') failures.push(`Primary software owner ${usernameRaw} must have role software-owner.`);
      if (tenantId && tenantId !== 'global-owner') failures.push(`Primary software owner ${usernameRaw} must not be bound to tenant ${tenantId}.`);
    }
    if (username === 'demo.coach' && tenantId !== 'demo-company') failures.push('demo.coach must be explicitly bound to demo-company.');
    if (clean(user.createdVia).toLowerCase() === 'snapshot-self-signup' && (role !== 'swimmer' || tenantId !== 'snapshot-public')) {
      failures.push(`Snapshot self-signup user ${usernameRaw || index} must be swimmer/snapshot-public.`);
    }
  }
  if (primaryOwnerCount !== 1) failures.push(`Authentication store must contain exactly one configured primary software owner (${primaryOwner}).`);

  // Backup must be a byte-semantically equivalent user set, not merely the same count.
  const canonical = (value) => {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
    return value;
  };
  if (JSON.stringify(canonical(primary)) !== JSON.stringify(canonical(backup))) failures.push('Authentication primary and backup stores differ semantically.');
  return failures;
}
