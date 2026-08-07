import fs from 'node:fs';
import path from 'node:path';

const indexPath = path.resolve('index.js');
let source = fs.readFileSync(indexPath, 'utf8').replace(/\r\n/g, '\n');

const oldBlock = `function requireCsrf(req, res, next) {
\tconst method = String(req.method || '').toUpperCase();
\tif (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return next();`;

const newBlock = `function requireCsrf(req, res, next) {
\tconst method = String(req.method || '').toUpperCase();
\tif (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return next();
\tconst requestPath = String(req.path || req.originalUrl || '').split('?')[0];
\t// Logout only destroys the authenticated session. Do not let a stale/missing
\t// CSRF token trap a user inside the application when the session cookie is valid.
\tif (requestPath === '/auth/logout') return next();`;

if (!source.includes(newBlock)) {
  if (!source.includes(oldBlock)) {
    throw new Error('requireCsrf block not found; refusing to patch logout behavior.');
  }
  source = source.replace(oldBlock, newBlock);
}

for (const token of [
  `const requestPath = String(req.path || req.originalUrl || '').split('?')[0];`,
  `if (requestPath === '/auth/logout') return next();`,
  `app.post('/auth/logout', requireStrictAuth`,
]) {
  if (!source.includes(token)) {
    throw new Error(`Logout CSRF patch verification failed: ${token}`);
  }
}

fs.writeFileSync(indexPath, source, 'utf8');
console.log('LOGOUT_CSRF_PATCH_OK');
