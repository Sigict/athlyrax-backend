import fs from 'node:fs';
import path from 'node:path';

const safetyPath = path.resolve('scripts/data-safety-preload.mjs');
let source = fs.readFileSync(safetyPath, 'utf8').replace(/\r\n/g, '\n');

const marker = '// ATHLYRAX_CANONICAL_DEMO_TENANT_METADATA_REPAIR';
const roundTripMarker = '// ATHLYRAX_DEMO_STALE_METADATA_ROUND_TRIP_REPAIR';
const original = `function assertTenantIdentity(payload, destination, env, label) {\n  const expected = expectedTenantIdForDbPath(destination, env);\n  if (!expected) return '';\n  const declaredRaw = String(payload?.__meta?.tenantId || '').trim();\n  if (!declaredRaw) return expected;\n  const declared = normalizeTenantId(declaredRaw);\n  if (!declared || declared !== expected) {\n    const error = new Error(\`${'${'}label} tenant identity does not match destination. Expected ${'${'}expected}, received ${'${'}declaredRaw || '(missing)'}.\`);\n    error.code = 'ATHLYRAX_DB_TENANT_IDENTITY_CONFLICT';\n    throw error;\n  }\n  return expected;\n}`;

const replacement = `function assertTenantIdentity(payload, destination, env, label) {\n  const expected = expectedTenantIdForDbPath(destination, env);\n  if (!expected) return '';\n  const declaredRaw = String(payload?.__meta?.tenantId || '').trim();\n  if (!declaredRaw) return expected;\n  const declared = normalizeTenantId(declaredRaw);\n  if (!declared || declared !== expected) {\n${marker}\n    if (label === 'Current database' && expected === 'demo-company') return expected;\n    const error = new Error(\`${'${'}label} tenant identity does not match destination. Expected ${'${'}expected}, received ${'${'}declaredRaw || '(missing)'}.\`);\n    error.code = 'ATHLYRAX_DB_TENANT_IDENTITY_CONFLICT';\n    throw error;\n  }\n  return expected;\n}\n\nfunction expectedTenantIdForIncomingDb(incoming, current, destination, env) {\n  const expected = expectedTenantIdForDbPath(destination, env);\n  if (expected !== 'demo-company' || !current) return assertTenantIdentity(incoming, destination, env, 'Incoming database');\n  const currentRaw = String(current?.__meta?.tenantId || '').trim();\n  const incomingRaw = String(incoming?.__meta?.tenantId || '').trim();\n  const currentCanonical = normalizeTenantId(currentRaw);\n  const incomingCanonical = normalizeTenantId(incomingRaw);\n  if (currentRaw && currentCanonical !== expected && incomingRaw === currentRaw && incomingCanonical === currentCanonical) {\n${roundTripMarker}\n    return expected;\n  }\n  return assertTenantIdentity(incoming, destination, env, 'Incoming database');\n}`;

if (!source.includes(marker)) {
  if (!source.includes(original)) throw new Error('Could not find tenant identity guard anchor.');
  source = source.replace(original, replacement);
}

const oldCall = `    const expectedTenantId = assertTenantIdentity(incoming, destination, env, 'Incoming database');\n    if (current) {`;
const newCall = `    const expectedTenantId = expectedTenantIdForIncomingDb(incoming, current, destination, env);\n    if (current) {`;
if (!source.includes(newCall)) {
  if (!source.includes(oldCall)) throw new Error('Could not find incoming tenant identity guard call.');
  source = source.replace(oldCall, newCall);
}

for (const required of [
  marker,
  roundTripMarker,
  `label === 'Current database' && expected === 'demo-company'`,
  `incomingRaw === currentRaw`,
  newCall.split('\n')[0].trim(),
  `error.code = 'ATHLYRAX_DB_TENANT_IDENTITY_CONFLICT'`,
]) {
  if (!source.includes(required)) throw new Error(`Demo tenant metadata repair contract missing: ${required}`);
}

fs.writeFileSync(safetyPath, source, 'utf8');
console.log('CANONICAL_DEMO_TENANT_METADATA_WRITE_PATCH_OK');
