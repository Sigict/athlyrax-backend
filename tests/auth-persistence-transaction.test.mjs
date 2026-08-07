import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const source = fs.readFileSync(path.resolve('index.js'), 'utf8');

test('auth primary and backup persistence is paired, verified, and rollback guarded', () => {
  const start = source.indexOf('function persistAuthUsers()');
  const end = source.indexOf('\nfunction writeJsonFile(', start);
  assert.ok(start >= 0 && end > start, 'persistAuthUsers function bounds missing');
  const persistSource = source.slice(start, end);

  for (const token of [
    'ATHLYRAX_AUTH_PAIRED_PERSISTENCE_TRANSACTION',
    'Refusing to persist an empty or invalid authentication user store.',
    'Authentication primary/backup verification failed after persistence.',
    'restorePrevious(AUTH_USERS_PATH',
    'restorePrevious(AUTH_USERS_BACKUP_PATH',
    'rollback was incomplete',
  ]) assert.ok(persistSource.includes(token), `missing paired auth persistence protection: ${token}`);

  const backupWrite = persistSource.indexOf('writeAtomicJsonFile(AUTH_USERS_BACKUP_PATH, payload);');
  const primaryWrite = persistSource.indexOf('writeAtomicJsonFile(AUTH_USERS_PATH, payload);');
  const verification = persistSource.indexOf('const verifiedPrimary = normalizeAuthUserRows(readJsonFile(AUTH_USERS_PATH));');
  assert.ok(backupWrite >= 0, 'auth backup write missing');
  assert.ok(primaryWrite > backupWrite, 'auth primary must be written after backup');
  assert.ok(verification > primaryWrite, 'auth paired writes are not verified after persistence');
});

test('legacy unguarded paired auth persistence implementation is gone', () => {
  const legacy = `function persistAuthUsers() {\n\tconst payload = normalizeAuthUserRows(authUsers);\n\twriteAtomicJsonFile(AUTH_USERS_PATH, payload);\n\twriteAtomicJsonFile(AUTH_USERS_BACKUP_PATH, payload);\n}`;
  assert.equal(source.includes(legacy), false);
});
