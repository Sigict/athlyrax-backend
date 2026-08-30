import fs from 'node:fs';
import path from 'node:path';

const safetyPath = path.resolve('scripts/data-safety-preload.mjs');
let source = fs.readFileSync(safetyPath, 'utf8').replace(/\r\n/g, '\n');

const marker = '// ATHLYRAX_CANONICAL_DEMO_TENANT_METADATA_REPAIR';
const original = `function assertTenantIdentity(payload, destination, env, label) {\n  const expected = expectedTenantIdForDbPath(destination, env);\n  if (!expected) return '';\n  const declaredRaw = String(payload?.__meta?.tenantId || '').trim();\n  if (!declaredRaw) return expected;\n  const declared = normalizeTenantId(declaredRaw);\n  if (!declared || declared !== expected) {\n    const error = new Error(\`${'${'}label} tenant identity does not match destination. Expected ${'${'}expected}, received ${'${'}declaredRaw || '(missing)'}.\`);\n    error.code = 'ATHLYRAX_DB_TENANT_IDENTITY_CONFLICT';\n    throw error;\n  }\n  return expected;\n}`;

const replacement = `function assertTenantIdentity(payload, destination, env, label) {\n  const expected = expectedTenantIdForDbPath(destination, env);\n  if (!expected) return '';\n  const declaredRaw = String(payload?.__meta?.tenantId || '').trim();\n  if (!declaredRaw) return expected;\n  const declared = normalizeTenantId(declaredRaw);\n  if (!declared || declared !== expected) {\n${marker}\n    // The canonical production demo account has always been routed to the\n    // demo-company path. Older demo databases can still carry stale tenant\n    // metadata from before that canonical route existed. Only the CURRENT\n    // database at this one canonical destination may self-repair; incoming\n    // payloads and every normal tenant remain fail-closed. The guarded commit\n    // rewrites the incoming __meta.tenantId from the destination authority.\n    if (label === 'Current database' && expected === 'demo-company') return expected;\n    const error = new Error(\`${'${'}label} tenant identity does not match destination. Expected ${'${'}expected}, received ${'${'}declaredRaw || '(missing)'}.\`);\n    error.code = 'ATHLYRAX_DB_TENANT_IDENTITY_CONFLICT';\n    throw error;\n  }\n  return expected;\n}`;

if (!source.includes(marker)) {
  if (!source.includes(original)) throw new Error('Could not find tenant identity guard anchor.');
  source = source.replace(original, replacement);
}

for (const required of [
  marker,
  `label === 'Current database' && expected === 'demo-company'`,
  `error.code = 'ATHLYRAX_DB_TENANT_IDENTITY_CONFLICT'`,
]) {
  if (!source.includes(required)) throw new Error(`Demo tenant metadata repair contract missing: ${required}`);
}

if (source.includes(`label === 'Incoming database' && expected === 'demo-company'`)) {
  throw new Error('Incoming demo tenant identity must remain fail-closed.');
}

fs.writeFileSync(safetyPath, source, 'utf8');
console.log('CANONICAL_DEMO_TENANT_METADATA_WRITE_PATCH_OK');
