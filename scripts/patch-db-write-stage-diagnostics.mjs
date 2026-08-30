import fs from 'node:fs';
import path from 'node:path';

const indexPath = path.resolve('index.js');
let source = fs.readFileSync(indexPath, 'utf8').replace(/\r\n/g, '\n');

const marker = '// ATHLYRAX_DB_WRITE_STAGE_DIAGNOSTICS_V1';
const routeStart = "app.put('/db', requireAuth, requireWriteRole, requireBillingWriteAccess, (req, res) => {";
const routeEnd = '\nconst server = app.listen(PORT, () => {';

if (!source.includes(marker)) {
  const startIndex = source.indexOf(routeStart);
  const endIndex = source.indexOf(routeEnd, startIndex);
  if (startIndex < 0 || endIndex < 0) throw new Error('Could not locate canonical /db PUT route for write diagnostics.');

  const helpers = `${marker}\nfunction tagDbWriteFailure(error, stage) {\n\tif (error && typeof error === 'object') {\n\t\ttry { error.athlyraxDbWriteStage = String(stage || 'unknown'); } catch {}\n\t}\n\treturn error;\n}\n\nfunction classifyDbWriteFailureCode(error) {\n\tconst code = String(error?.code || '').trim().toUpperCase();\n\tconst allowed = new Set(['ENOSPC', 'EACCES', 'EPERM', 'EROFS', 'EIO', 'EMFILE', 'ENFILE', 'ENOENT', 'EXDEV', 'EBUSY']);\n\tif (allowed.has(code)) return code;\n\tconst message = String(error?.message || '');\n\tif (/ATHLYRAX_|tenant|revision|safety|backup/i.test(message)) return 'DATA_SAFETY_GUARD';\n\treturn 'UNKNOWN';\n}\n\n`;

  source = `${source.slice(0, startIndex)}${helpers}${source.slice(startIndex)}`;

  const shiftedStart = source.indexOf(routeStart);
  const shiftedEnd = source.indexOf(routeEnd, shiftedStart);
  let route = source.slice(shiftedStart, shiftedEnd);

  const setupAnchor = `\tenqueueWrite(async () => {\n\t\tensureStorageLayout(storagePaths);\n\t\twriteDbSnapshotIfPossible(storagePaths.dbPath, storagePaths.snapshotDir);`;
  const setupReplacement = `\tenqueueWrite(async () => {\n\t\ttry {\n\t\t\tensureStorageLayout(storagePaths);\n\t\t} catch (error) {\n\t\t\tthrow tagDbWriteFailure(error, 'storage_layout');\n\t\t}\n\t\ttry {\n\t\t\twriteDbSnapshotIfPossible(storagePaths.dbPath, storagePaths.snapshotDir);\n\t\t} catch (error) {\n\t\t\tthrow tagDbWriteFailure(error, 'prewrite_snapshot');\n\t\t}`;
  if (!route.includes(setupAnchor)) throw new Error('Could not locate /db pre-write snapshot anchor.');
  route = route.replace(setupAnchor, setupReplacement);

  const primaryAnchor = `\t\twriteAtomicJsonFile(storagePaths.dbPath, ownershipStampedBody);`;
  const primaryReplacement = `\t\ttry {\n\t\t\twriteAtomicJsonFile(storagePaths.dbPath, ownershipStampedBody);\n\t\t} catch (error) {\n\t\t\tthrow tagDbWriteFailure(error, 'primary_db_write');\n\t\t}`;
  if (!route.includes(primaryAnchor)) throw new Error('Could not locate /db primary write anchor.');
  route = route.replace(primaryAnchor, primaryReplacement);

  const backupAnchor = `\t\twriteAtomicJsonFile(storagePaths.backupPath, nextBackup);`;
  const backupReplacement = `\t\ttry {\n\t\t\twriteAtomicJsonFile(storagePaths.backupPath, nextBackup);\n\t\t} catch (error) {\n\t\t\tthrow tagDbWriteFailure(error, 'planner_backup_write');\n\t\t}`;
  if (!route.includes(backupAnchor)) throw new Error('Could not locate /db Planner backup write anchor.');
  route = route.replace(backupAnchor, backupReplacement);

  const catchAnchor = `\t\t\tres.status(500).json({\n\t\t\t\terror: 'Could not write db.json',\n\t\t\t\t...(IS_PRODUCTION ? {} : { details: error instanceof Error ? error.message : 'Unknown error' }),\n\t\t\t});`;
  const catchReplacement = `\t\t\tconst failureStage = String(error?.athlyraxDbWriteStage || 'unknown');\n\t\t\tconst failureCode = classifyDbWriteFailureCode(error);\n\t\t\tconsole.error(\`[db-write] failed stage=\${failureStage} code=\${failureCode}\`);\n\t\t\tres.status(500).json({\n\t\t\t\terror: 'Could not write db.json',\n\t\t\t\tfailureStage,\n\t\t\t\tfailureCode,\n\t\t\t\t...(IS_PRODUCTION ? {} : { details: error instanceof Error ? error.message : 'Unknown error' }),\n\t\t\t});`;
  if (!route.includes(catchAnchor)) throw new Error('Could not locate production-redacted /db 500 response anchor.');
  route = route.replace(catchAnchor, catchReplacement);

  source = `${source.slice(0, shiftedStart)}${route}${source.slice(shiftedEnd)}`;
}

for (const required of [
  marker,
  "'storage_layout'",
  "'prewrite_snapshot'",
  "'primary_db_write'",
  "'planner_backup_write'",
  'failureStage,',
  'failureCode,',
  '[db-write] failed stage=',
]) {
  if (!source.includes(required)) throw new Error(`DB write diagnostics marker missing: ${required}`);
}

fs.writeFileSync(indexPath, source, 'utf8');
console.log('DB_WRITE_STAGE_DIAGNOSTICS_OK');
