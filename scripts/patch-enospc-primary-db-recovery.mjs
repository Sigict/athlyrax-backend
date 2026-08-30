import fs from 'node:fs';
import path from 'node:path';

const indexPath = path.resolve('index.js');
let source = fs.readFileSync(indexPath, 'utf8').replace(/\r\n/g, '\n');
const marker = '// ATHLYRAX_ENOSPC_PRIMARY_DB_RECOVERY_V1';

if (!source.includes(marker)) {
  const helperAnchor = `function classifyDbWriteFailureCode(error) {`;
  const helperIndex = source.indexOf(helperAnchor);
  if (helperIndex < 0) throw new Error('DB write diagnostics helper must exist before ENOSPC recovery patch.');
  const helper = `${marker}\nfunction pruneOldestFiles(dirPath, keepNewest = 2) {\n\ttry {\n\t\tif (!fs.existsSync(dirPath)) return 0;\n\t\tconst files = fs.readdirSync(dirPath, { withFileTypes: true })\n\t\t\t.filter((entry) => entry.isFile())\n\t\t\t.map((entry) => {\n\t\t\t\tconst fullPath = path.join(dirPath, entry.name);\n\t\t\t\tlet mtimeMs = 0;\n\t\t\t\ttry { mtimeMs = fs.statSync(fullPath).mtimeMs; } catch {}\n\t\t\t\treturn { fullPath, mtimeMs };\n\t\t\t})\n\t\t\t.sort((a, b) => b.mtimeMs - a.mtimeMs);\n\t\tlet removed = 0;\n\t\tfor (const file of files.slice(Math.max(0, keepNewest))) {\n\t\t\ttry { fs.unlinkSync(file.fullPath); removed += 1; } catch {}\n\t\t}\n\t\treturn removed;\n\t} catch {\n\t\treturn 0;\n\t}\n}\n\nfunction reclaimRecoverableStorageForDbWrite(storagePaths) {\n\tlet removed = 0;\n\tcleanupStaleAtomicTemps(storagePaths.dbPath);\n\tcleanupStaleAtomicTemps(storagePaths.backupPath);\n\tremoved += pruneOldestFiles(storagePaths.snapshotDir, 2);\n\tremoved += pruneOldestFiles(AUTH_AUDIT_BACKUP_DIR, 3);\n\tremoved += pruneOldestFiles(BILLING_CATALOG_BACKUP_DIR, 3);\n\tconsole.warn(\`[db-write] ENOSPC recovery pruned recoverable files=\${removed}\`);\n\treturn removed;\n}\n\n`;
  source = `${source.slice(0, helperIndex)}${helper}${source.slice(helperIndex)}`;

  const primary = `\t\ttry {\n\t\t\twriteAtomicJsonFile(storagePaths.dbPath, ownershipStampedBody);\n\t\t} catch (error) {\n\t\t\tthrow tagDbWriteFailure(error, 'primary_db_write');\n\t\t}`;
  const replacement = `\t\ttry {\n\t\t\twriteAtomicJsonFile(storagePaths.dbPath, ownershipStampedBody);\n\t\t} catch (error) {\n\t\t\tif (String(error?.code || '').toUpperCase() === 'ENOSPC') {\n\t\t\t\treclaimRecoverableStorageForDbWrite(storagePaths);\n\t\t\t\ttry {\n\t\t\t\t\twriteAtomicJsonFile(storagePaths.dbPath, ownershipStampedBody);\n\t\t\t\t} catch (retryError) {\n\t\t\t\t\tthrow tagDbWriteFailure(retryError, 'primary_db_write');\n\t\t\t\t}\n\t\t\t} else {\n\t\t\t\tthrow tagDbWriteFailure(error, 'primary_db_write');\n\t\t\t}\n\t\t}`;
  if (!source.includes(primary)) throw new Error('Could not locate diagnostic primary DB write block.');
  source = source.replace(primary, replacement);
}

for (const required of [marker, 'reclaimRecoverableStorageForDbWrite(storagePaths)', "=== 'ENOSPC'", 'pruneOldestFiles(storagePaths.snapshotDir, 2)', 'pruneOldestFiles(AUTH_AUDIT_BACKUP_DIR, 3)', 'pruneOldestFiles(BILLING_CATALOG_BACKUP_DIR, 3)']) {
  if (!source.includes(required)) throw new Error(`ENOSPC recovery marker missing: ${required}`);
}
fs.writeFileSync(indexPath, source, 'utf8');
console.log('ENOSPC_PRIMARY_DB_RECOVERY_OK');
