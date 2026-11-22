// One-time copy of the Demo Coach club into the Software Owner's own database (owner decision 22-11-2026):
// the owner works, tests and edits on an independent copy while Demo Coach stays a protected, view-only
// demonstration. Same safety as the demo repairs: runs once (marker), nothing written unless pending, verified
// backup of the owner's database first, one atomic write, read back; never stops the server; Demo Coach is only read.
// Rollback: copy the backup over storage/db.json.
//
// The copy is the demo club as it is, with only its ownership stamps moved to the Software Owner (the app counts
// a row only for the account that owns it). Not copied: Athlete App invitations and the links of demo swimmers
// to athlete sign-ins (personal contact data; those athletes stay with Demo Coach). Kept from the owner's own
// database: website documents and any collection the demo club does not have.
import fs from 'node:fs';
import path from 'node:path';

export const OWNER_WORKSPACE_COPY_VERSION = 1;
// The primary Software Owner's username comes from the same setting the server uses (default softwareowner).
export function primaryOwnerUsername(env = process.env) {
  return String(env?.AUTH_PRIMARY_SOFTWARE_OWNER_USERNAME || 'softwareowner').trim().toLowerCase() || 'softwareowner';
}
const stampsFor = (ownerUsername) => new Map([
  ['demo-company:demo.coach', `global-owner:${ownerUsername}`],
  ['demo.coach', ownerUsername],
  ['demo-company', 'global-owner'],
]);
// Fields that name the owning account or club (every field holding these values in the demo club).
export const OWNERSHIP_FIELDS = new Set([
  'tenantId', 'ownerTenantId', 'tenantScope', 'tenantKey', 'tenant', 'activeTenantId',
  'accountId', 'ownerAccountId', 'accountScope', 'activeAccountId', 'expectedAccountIds', 'primaryAccount',
  'ownerUsername', 'owner', 'ownerUserId', 'createdBy', 'createdByUserId', 'updatedBy', 'updatedByUserId',
  'by', 'revokedBy', 'ownershipUpdatedBy',
]);
const ATHLETE_LINK_FIELDS = ['swimmerAccountUsername', 'swimmerAccountEmail', 'accountLinkedAt', 'accountLinkInviteId', 'accountLinkHistory'];

function restamper(stamps) {
  const restampValue = (value) => (typeof value === 'string' && stamps.has(value) ? stamps.get(value) : value);
  const restamp = (node) => {
    if (Array.isArray(node)) return node.map(restamp);
    if (!node || typeof node !== 'object') return node;
    const out = {};
    for (const [key, value] of Object.entries(node)) {
      if (OWNERSHIP_FIELDS.has(key)) out[key] = Array.isArray(value) ? value.map(restampValue) : (typeof value === 'string' ? restampValue(value) : restamp(value));
      else out[key] = restamp(value);
    }
    return out;
  };
  return restamp;
}

export function ownerWorkspaceCopyPending(ownerDb) {
  return !(Number(ownerDb?.__meta?.ownerWorkspaceCopy?.version) >= OWNER_WORKSPACE_COPY_VERSION);
}

/** Pure: the owner's new database from the demo club and the owner's current database. Inputs are not modified. */
export function buildOwnerWorkspace(demoDb = {}, ownerDb = {}, { now = new Date(), ownerUsername = 'softwareowner' } = {}) {
  const restamp = restamper(stampsFor(String(ownerUsername || 'softwareowner').trim().toLowerCase()));
  const { __meta: demoMeta = {}, ...demoCollections } = demoDb || {};
  const { demoSeed, ...demoMetaRest } = demoMeta || {};
  const copy = restamp(demoCollections);
  copy.athleteAccountInvites = [];
  copy.swimmers = (Array.isArray(copy.swimmers) ? copy.swimmers : []).map((row) => {
    const next = { ...row };
    for (const field of ATHLETE_LINK_FIELDS) delete next[field];
    return next;
  });
  const owner = ownerDb && typeof ownerDb === 'object' ? ownerDb : {};
  const keptFromOwner = Object.fromEntries(Object.entries(owner).filter(([key]) => key !== '__meta' && !(key in demoCollections)));
  const revision = Math.max(Number(owner?.__meta?.storageRevision) || 0, Number(demoMeta?.storageRevision) || 0) + 1;
  return {
    ...copy,
    ...keptFromOwner,
    documents: Array.isArray(owner.documents) ? owner.documents : (Array.isArray(copy.documents) ? copy.documents : []),
    __meta: {
      ...(owner.__meta || {}),
      ...restamp(demoMetaRest),
      // The demo marker stays as it is, so the copy follows exactly the same calculation paths as Demo Coach.
      ...(demoSeed ? { demoSeed } : {}),
      storageRevision: revision,
      storageUpdatedAt: now.toISOString(),
      ownerWorkspaceCopy: { version: OWNER_WORKSPACE_COPY_VERSION, copiedAt: now.toISOString(), fromTenant: 'demo-company', ownerUsername: String(ownerUsername || 'softwareowner').trim().toLowerCase(), fromRevision: Number(demoMeta?.storageRevision) || 0, keptOwnerCollections: Object.keys(keptFromOwner).sort() },
    },
  };
}

export function copyDemoToOwnerWorkspace({ storageRoot, backupRoot, logger = console, fsModule = fs, now = () => new Date(), ownerUsername = primaryOwnerUsername() } = {}) {
  if (!storageRoot || !backupRoot) throw new Error('copyDemoToOwnerWorkspace requires storageRoot and backupRoot');
  const ownerPath = path.resolve(storageRoot, 'db.json');
  const demoPath = path.resolve(storageRoot, 'tenants', 'demo-company', 'db.json');
  if (!fsModule.existsSync(demoPath)) return { changed: false, reason: 'missing-demo-db' };
  let demoDb;
  try { demoDb = JSON.parse(fsModule.readFileSync(demoPath, 'utf8')); } catch { return { changed: false, reason: 'unreadable-demo-db' }; }
  if (!Array.isArray(demoDb?.swimmers) || !demoDb.swimmers.length) return { changed: false, reason: 'empty-demo-db' };
  const ownerExists = fsModule.existsSync(ownerPath);
  let original = null; let ownerDb = {};
  if (ownerExists) {
    try { original = fsModule.readFileSync(ownerPath); ownerDb = JSON.parse(original.toString('utf8')); } catch { return { changed: false, reason: 'unreadable-owner-db' }; }
  }
  if (!ownerWorkspaceCopyPending(ownerDb)) return { changed: false, reason: 'already-copied' };
  let backupPath = '';
  if (ownerExists) {
    const backupDir = path.resolve(backupRoot, 'owner-workspace-copy'); fsModule.mkdirSync(backupDir, { recursive: true });
    backupPath = path.join(backupDir, `global-owner-before-demo-copy-${now().toISOString().replace(/[:.]/g, '-')}.json`);
    fsModule.copyFileSync(ownerPath, backupPath);
    if (!fsModule.readFileSync(backupPath).equals(original)) throw new Error('owner backup verification failed; nothing written');
  }
  const next = buildOwnerWorkspace(demoDb, ownerDb, { now: now(), ownerUsername });
  const tmp = `${ownerPath}.tmp-owner-copy-${process.pid}-${Date.now()}`;
  try {
    const fd = fsModule.openSync(tmp, 'w');
    try { fsModule.writeFileSync(fd, `${JSON.stringify(next, null, 2)}\n`, 'utf8'); fsModule.fsyncSync(fd); } finally { fsModule.closeSync(fd); }
    fsModule.renameSync(tmp, ownerPath);
  } catch (error) { try { fsModule.rmSync(tmp, { force: true }); } catch {} throw error; }
  const readBack = JSON.parse(fsModule.readFileSync(ownerPath, 'utf8'));
  if (ownerWorkspaceCopyPending(readBack) || readBack.swimmers?.length !== demoDb.swimmers.length) throw new Error(`owner copy verification failed after write; restore from ${backupPath || '(no previous owner database)'}`);
  logger.log?.(`[owner-workspace] Demo Coach club copied to the Software Owner (${demoDb.swimmers.length} swimmers, demo revision ${next.__meta.ownerWorkspaceCopy.fromRevision}; backup ${backupPath || 'none: no previous owner database'})`);
  return { changed: true, backupPath, swimmers: demoDb.swimmers.length, revision: next.__meta.storageRevision };
}

export function runOwnerWorkspaceCopyAtStart(options = {}) {
  const logger = options.logger || console;
  try { const r = copyDemoToOwnerWorkspace(options); if (!r.changed) logger.log?.(`[owner-workspace] not applied: ${r.reason}`); return r; }
  catch (error) { logger.error?.(`[owner-workspace] FAILED, both accounts left unchanged: ${error?.message || error}`); return { changed: false, reason: 'failed', error: String(error?.message || error) }; }
}
