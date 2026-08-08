import fs from 'node:fs';
import path from 'node:path';

const indexPath = path.resolve('index.js');
let source = fs.readFileSync(indexPath, 'utf8').replace(/\r\n/g, '\n');

const marker = '// ATHLYRAX_PASSWORD_MINIMUM_12';
if (!source.includes(marker)) {
  source = source.replaceAll('if (password.length < 8) {', 'if (password.length < 12) {');
  source = source.replaceAll('if (nextPassword.length < 8) {', 'if (nextPassword.length < 12) {');
  source = source.replaceAll('Password must be at least 8 characters.', 'Password must be at least 12 characters.');
  source = `${marker}\n${source}`;
}

for (const required of [
  'ATHLYRAX_PASSWORD_MINIMUM_12',
  'if (password.length < 12) {',
  'if (nextPassword.length < 12) {',
  'Password must be at least 12 characters.',
]) if (!source.includes(required)) throw new Error(`Password policy hardening missing: ${required}`);

for (const forbidden of [
  'if (password.length < 8) {',
  'if (nextPassword.length < 8) {',
  'Password must be at least 8 characters.',
]) if (source.includes(forbidden)) throw new Error(`Legacy weak password policy remains: ${forbidden}`);

fs.writeFileSync(indexPath, source, 'utf8');
console.log('PASSWORD_POLICY_HARDENING_OK');
