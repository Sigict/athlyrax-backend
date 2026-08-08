import fs from 'node:fs';
import path from 'node:path';

const indexPath = path.resolve('index.js');
let source = fs.readFileSync(indexPath, 'utf8').replace(/\r\n/g, '\n');

const marker = '// ATHLYRAX_AUTH_PAIRED_PERSISTENCE_TRANSACTION';
const ownershipMarker = '// ATHLYRAX_AUTH_PERSISTENCE_SINGLE_OWNER';
if (!source.includes(marker) || !source.includes(ownershipMarker)) {
  const oldFunction = `function persistAuthUsers() {\n\tconst payload = normalizeAuthUserRows(authUsers);\n\twriteAtomicJsonFile(AUTH_USERS_PATH, payload);\n\twriteAtomicJsonFile(AUTH_USERS_BACKUP_PATH, payload);\n}`;
  const existingHardenedStart = `function persistAuthUsers() {\n\t${marker}`;
  const newFunction = `function persistAuthUsers() {\n\t${marker}\n\t${ownershipMarker}\n\tconst payload = normalizeAuthUserRows(authUsers);\n\tif (!Array.isArray(payload) || payload.length < 1) {\n\t\tthrow new Error('Refusing to persist an empty or invalid authentication user store.');\n\t}\n\n\tconst primaryExisted = fs.existsSync(AUTH_USERS_PATH);\n\tconst backupExisted = fs.existsSync(AUTH_USERS_BACKUP_PATH);\n\tconst previousPrimary = primaryExisted ? readJsonFile(AUTH_USERS_PATH) : null;\n\tconst previousBackup = backupExisted ? readJsonFile(AUTH_USERS_BACKUP_PATH) : null;\n\tif (primaryExisted && !Array.isArray(previousPrimary)) throw new Error('Authentication primary store is unreadable or invalid before persistence.');\n\tif (backupExisted && !Array.isArray(previousBackup)) throw new Error('Authentication backup store is unreadable or invalid before persistence.');\n\n\tconst restorePrevious = (filePath, existed, previousValue) => {\n\t\tif (existed) {\n\t\t\twriteAtomicJsonFile(filePath, previousValue);\n\t\t\treturn;\n\t\t}\n\t\tif (fs.existsSync(filePath)) fs.unlinkSync(filePath);\n\t};\n\n\ttry {\n\t\t// Write the backup first. If the primary write then fails, the catch path restores both.\n\t\twriteAtomicJsonFile(AUTH_USERS_BACKUP_PATH, payload);\n\t\twriteAtomicJsonFile(AUTH_USERS_PATH, payload);\n\n\t\tconst verifiedPrimary = normalizeAuthUserRows(readJsonFile(AUTH_USERS_PATH));\n\t\tconst verifiedBackup = normalizeAuthUserRows(readJsonFile(AUTH_USERS_BACKUP_PATH));\n\t\tconst expected = JSON.stringify(payload);\n\t\tif (JSON.stringify(verifiedPrimary) !== expected || JSON.stringify(verifiedBackup) !== expected) {\n\t\t\tthrow new Error('Authentication primary/backup verification failed after persistence.');\n\t\t}\n\t} catch (error) {\n\t\tconst rollbackErrors = [];\n\t\ttry { restorePrevious(AUTH_USERS_PATH, primaryExisted, previousPrimary); } catch (rollbackError) { rollbackErrors.push(\`primary: \${rollbackError instanceof Error ? rollbackError.message : 'unknown rollback error'}\`); }\n\t\ttry { restorePrevious(AUTH_USERS_BACKUP_PATH, backupExisted, previousBackup); } catch (rollbackError) { rollbackErrors.push(\`backup: \${rollbackError instanceof Error ? rollbackError.message : 'unknown rollback error'}\`); }\n\t\tif (rollbackErrors.length > 0) {\n\t\t\tthrow new Error(\`Authentication persistence failed and rollback was incomplete (\${rollbackErrors.join('; ')}). Original error: \${error instanceof Error ? error.message : 'unknown persistence error'}\`);\n\t\t}\n\t\tthrow error;\n\t}\n}`;

  if (source.includes(oldFunction)) {
    source = source.replace(oldFunction, newFunction);
  } else if (source.includes(existingHardenedStart) && !source.includes(ownershipMarker)) {
    source = source.replace(existingHardenedStart, `${existingHardenedStart}\n\t${ownershipMarker}`);
  } else if (!source.includes(marker) || !source.includes(ownershipMarker)) {
    throw new Error('Auth persistence transaction anchor not found.');
  }
}

for (const required of [
  'ATHLYRAX_AUTH_PAIRED_PERSISTENCE_TRANSACTION',
  'ATHLYRAX_AUTH_PERSISTENCE_SINGLE_OWNER',
  'Refusing to persist an empty or invalid authentication user store.',
  'writeAtomicJsonFile(AUTH_USERS_BACKUP_PATH, payload);',
  'writeAtomicJsonFile(AUTH_USERS_PATH, payload);',
  'Authentication primary/backup verification failed after persistence.',
  'restorePrevious(AUTH_USERS_PATH',
  'restorePrevious(AUTH_USERS_BACKUP_PATH',
  'rollback was incomplete',
]) if (!source.includes(required)) throw new Error(`Auth persistence transaction hardening missing: ${required}`);

const backupWrite = source.indexOf('writeAtomicJsonFile(AUTH_USERS_BACKUP_PATH, payload);', source.indexOf(marker));
const primaryWrite = source.indexOf('writeAtomicJsonFile(AUTH_USERS_PATH, payload);', source.indexOf(marker));
if (backupWrite < 0 || primaryWrite <= backupWrite) throw new Error('Auth persistence write ordering is not backup-first then primary.');

fs.writeFileSync(indexPath, source, 'utf8');
console.log('AUTH_PERSISTENCE_TRANSACTION_PATCH_OK');
