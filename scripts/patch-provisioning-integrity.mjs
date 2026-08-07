import fs from 'node:fs';
import path from 'node:path';

const dataSafetyPath = path.resolve('scripts', 'data-safety-preload.mjs');
let safetySource = fs.readFileSync(dataSafetyPath, 'utf8').replace(/\r\n/g, '\n');

const unsafeProvisioning = `\tif (!destinationExists && isProduction) {\n\t\tconst provisionedBy = String(incoming?.__meta?.provisionedBy || '').trim();\n\t\tconst provisioningToken = String(incoming?.__meta?.provisioningToken || '').trim();\n\t\tconst explicitProvisioning = provisionedBy === 'auth-register' && Boolean(provisioningToken);\n\t\tif (!explicitProvisioning) {`;
const safeProvisioning = `\tif (!destinationExists && isProduction) {\n\t\tconst provisionedBy = String(incoming?.__meta?.provisionedBy || '').trim();\n\t\tconst provisioningToken = String(incoming?.__meta?.provisioningToken || '').trim();\n\t\tconst authSecret = String(env.AUTH_SECRET || '');\n\t\tconst expectedProvisioningToken = crypto.createHmac('sha256', authSecret).update(destination).digest('hex');\n\t\tconst tokenBytes = Buffer.from(provisioningToken);\n\t\tconst expectedBytes = Buffer.from(expectedProvisioningToken);\n\t\tconst tokenMatches = tokenBytes.length === expectedBytes.length && crypto.timingSafeEqual(tokenBytes, expectedBytes);\n\t\tconst explicitProvisioning = provisionedBy === 'auth-register' && authSecret.length >= 32 && tokenMatches;\n\t\tif (!explicitProvisioning) {`;
if (safetySource.includes(unsafeProvisioning)) safetySource = safetySource.replace(unsafeProvisioning, safeProvisioning);
if (!safetySource.includes(`crypto.createHmac('sha256', authSecret).update(destination).digest('hex')`)) {
  throw new Error('Could not install cryptographic tenant provisioning verification.');
}

const unsafeRevisionWriter = `function writeRevisionToIncoming(sourcePath, payload, revision, fsModule = fs) {\n\tconst updated = {\n\t\t...payload,\n\t\t__meta: {\n\t\t\t...(payload?.__meta && typeof payload.__meta === 'object' ? payload.__meta : {}),\n\t\t\tstorageRevision: revision,\n\t\t\tstorageUpdatedAt: new Date().toISOString(),\n\t\t},\n\t};`;
const safeRevisionWriter = `function writeRevisionToIncoming(sourcePath, payload, revision, fsModule = fs) {\n\tconst rawMeta = payload?.__meta && typeof payload.__meta === 'object' ? payload.__meta : {};\n\tconst { provisioningToken: _discardedProvisioningToken, ...safeMeta } = rawMeta;\n\tconst updated = {\n\t\t...payload,\n\t\t__meta: {\n\t\t\t...safeMeta,\n\t\t\tstorageRevision: revision,\n\t\t\tstorageUpdatedAt: new Date().toISOString(),\n\t\t},\n\t};`;
if (safetySource.includes(unsafeRevisionWriter)) safetySource = safetySource.replace(unsafeRevisionWriter, safeRevisionWriter);
if (!safetySource.includes('discardedProvisioningToken')) throw new Error('Could not install one-time provisioning-token stripping.');

fs.writeFileSync(dataSafetyPath, safetySource, 'utf8');

const indexPath = path.resolve('index.js');
let indexSource = fs.readFileSync(indexPath, 'utf8').replace(/\r\n/g, '\n');
const randomToken = `\tconst registrationTenantProvisioningToken = crypto.randomUUID();`;
const boundToken = `\tconst registrationTenantProvisioningToken = crypto.createHmac('sha256', AUTH_SECRET).update(path.resolve(registrationTenantStorage.dbPath)).digest('hex');`;
if (indexSource.includes(randomToken)) indexSource = indexSource.replace(randomToken, boundToken);
if (!indexSource.includes(boundToken)) throw new Error('Could not bind registration provisioning token to server secret and tenant path.');

const oldRollback = `\t\tif (registrationTenantDbCreated && registrationTenantStorage.dbPath !== DB_PATH && fs.existsSync(registrationTenantStorage.dbPath)) {\n\t\t\ttry {\n\t\t\t\tconst provisioned = readJsonFile(registrationTenantStorage.dbPath);\n\t\t\t\tif (String(provisioned?.__meta?.provisioningToken || '') === registrationTenantProvisioningToken) {\n\t\t\t\t\tfs.unlinkSync(registrationTenantStorage.dbPath);\n\t\t\t\t}\n\t\t\t} catch {}\n\t\t}`;
const safeRollback = `\t\tif (registrationTenantDbCreated && registrationTenantStorage.dbPath !== DB_PATH && fs.existsSync(registrationTenantStorage.dbPath)) {\n\t\t\ttry { fs.unlinkSync(registrationTenantStorage.dbPath); } catch {}\n\t\t}`;
if (indexSource.includes(oldRollback)) indexSource = indexSource.replace(oldRollback, safeRollback);
if (indexSource.includes(`String(provisioned?.__meta?.provisioningToken || '') === registrationTenantProvisioningToken`)) {
  throw new Error('Registration rollback still depends on persisted provisioning token.');
}

fs.writeFileSync(indexPath, indexSource, 'utf8');
console.log('PROVISIONING_INTEGRITY_PATCH_OK');
