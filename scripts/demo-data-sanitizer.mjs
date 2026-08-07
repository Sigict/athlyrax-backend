import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

function clean(value) { return String(value ?? '').trim(); }

function writeDurableJson(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  let handle = null;
  try {
    handle = fs.openSync(tempPath, 'wx', 0o600);
    fs.writeFileSync(handle, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    fs.fsyncSync(handle);
  } finally {
    if (handle !== null) fs.closeSync(handle);
  }
  try {
    fs.renameSync(tempPath, filePath);
  } catch (error) {
    try { fs.unlinkSync(tempPath); } catch {}
    throw error;
  }
  try {
    const directoryHandle = fs.openSync(path.dirname(filePath), 'r');
    try { fs.fsyncSync(directoryHandle); } finally { fs.closeSync(directoryHandle); }
  } catch {
    // Some hosted filesystems do not permit directory fsync.
  }
}

function preserveOriginal(sourcePath, backupRoot) {
  if (!backupRoot) throw new Error('A safety backup root is required before demo sanitization.');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const destination = path.join(path.resolve(backupRoot), 'demo-pre-sanitization', `${stamp}-demo-company.json`);
  const sourceBytes = fs.readFileSync(sourcePath);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const tempPath = `${destination}.${process.pid}.${Date.now()}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  let handle = null;
  try {
    handle = fs.openSync(tempPath, 'wx', 0o600);
    fs.writeFileSync(handle, sourceBytes);
    fs.fsyncSync(handle);
  } finally {
    if (handle !== null) fs.closeSync(handle);
  }
  fs.renameSync(tempPath, destination);
  const copied = fs.readFileSync(destination);
  if (!sourceBytes.equals(copied)) throw new Error('Demo pre-sanitization backup verification failed.');
  return destination;
}

function syntheticDob(value) {
  const raw = clean(value);
  const match = raw.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
  if (!match) return '';
  return `${match[1]}-07-01`;
}

function isPersonLike(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = new Set(Object.keys(value).map((key) => key.toLowerCase()));
  return ['firstname', 'lastname', 'fullname', 'email', 'phone', 'dob', 'dateofbirth', 'asn', 'membershipnumber', 'emergencycontact'].some((key) => keys.has(key));
}

function sanitizeObject(value, state) {
  if (Array.isArray(value)) return value.map((entry) => sanitizeObject(entry, state));
  if (!value || typeof value !== 'object') return value;

  const personLike = isPersonLike(value);
  let personNumber = 0;
  if (personLike) {
    state.personCount += 1;
    personNumber = state.personCount;
  }

  const output = {};
  for (const [key, original] of Object.entries(value)) {
    const lower = key.toLowerCase();

    if (personLike && lower === 'firstname') { output[key] = 'Demo'; continue; }
    if (personLike && lower === 'lastname') { output[key] = `Person ${personNumber}`; continue; }
    if (personLike && (lower === 'fullname' || lower === 'name')) { output[key] = `Demo Person ${personNumber}`; continue; }
    if (lower === 'email' || lower.endsWith('email')) { output[key] = personLike ? `demo.person.${personNumber}@example.invalid` : ''; continue; }
    if (lower === 'phone' || lower.endsWith('phone') || lower.includes('telephone') || lower.includes('mobile')) { output[key] = ''; continue; }
    if (lower === 'address' || lower.endsWith('address') || lower === 'postcode' || lower === 'postalcode') { output[key] = ''; continue; }
    if (lower === 'asn' || lower.includes('membershipnumber') || lower === 'membershipno') { output[key] = ''; continue; }
    if (lower === 'notes' || lower === 'medicalnotes' || lower === 'emergencycontact') { output[key] = ''; continue; }
    if (lower === 'dob' || lower === 'dateofbirth' || lower === 'birthdate') { output[key] = syntheticDob(original); continue; }

    output[key] = sanitizeObject(original, state);
  }
  return output;
}

function containsObviousContactData(value) {
  if (Array.isArray(value)) return value.some(containsObviousContactData);
  if (!value || typeof value !== 'object') return false;
  for (const [key, item] of Object.entries(value)) {
    const lower = key.toLowerCase();
    if ((lower === 'email' || lower.endsWith('email')) && clean(item) && !String(item).endsWith('@example.invalid')) return true;
    if ((lower === 'phone' || lower.endsWith('phone') || lower.includes('telephone') || lower.includes('mobile')) && clean(item)) return true;
    if ((lower === 'address' || lower.endsWith('address') || lower === 'postcode' || lower === 'postalcode') && clean(item)) return true;
    if ((lower === 'asn' || lower.includes('membershipnumber') || lower === 'membershipno') && clean(item)) return true;
    if (containsObviousContactData(item)) return true;
  }
  return false;
}

export function sanitizeDemoTenantDatabase({ filePath, backupRoot, logger = console } = {}) {
  const resolved = path.resolve(clean(filePath));
  if (!clean(filePath) || !fs.existsSync(resolved)) throw new Error(`Demo database is missing: ${resolved}`);
  let payload;
  try { payload = JSON.parse(fs.readFileSync(resolved, 'utf8')); }
  catch { throw new Error(`Demo database is not valid JSON: ${resolved}`); }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) || Object.keys(payload).length === 0) {
    throw new Error(`Demo database is empty or invalid: ${resolved}`);
  }

  if (payload?.__meta?.tenantId === 'demo-company' && payload?.__meta?.demoDataSynthetic === true && !containsObviousContactData(payload)) {
    return { sanitized: false, reason: 'already-sanitized', filePath: resolved };
  }

  const backupPath = preserveOriginal(resolved, backupRoot);
  const state = { personCount: 0 };
  const sanitized = sanitizeObject(payload, state);
  sanitized.__meta = {
    ...(sanitized.__meta && typeof sanitized.__meta === 'object' ? sanitized.__meta : {}),
    tenantId: 'demo-company',
    demoDataSynthetic: true,
    demoSanitizedAt: new Date().toISOString(),
  };

  if (containsObviousContactData(sanitized)) {
    throw new Error('Demo sanitization verification failed: contact/identifier data remains.');
  }

  writeDurableJson(resolved, sanitized);
  const verified = JSON.parse(fs.readFileSync(resolved, 'utf8'));
  if (verified?.__meta?.tenantId !== 'demo-company' || verified?.__meta?.demoDataSynthetic !== true || containsObviousContactData(verified)) {
    throw new Error('Demo sanitization verification failed after durable write.');
  }

  logger.info(`[demo-safety] Sanitized ${state.personCount} person-like records before demo activation. Original preserved at ${backupPath}.`);
  return { sanitized: true, filePath: resolved, backupPath, personCount: state.personCount };
}
