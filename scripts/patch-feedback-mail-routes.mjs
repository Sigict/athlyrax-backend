import fs from 'node:fs';
import path from 'node:path';
const indexPath = path.resolve('index.js');
let source = fs.readFileSync(indexPath, 'utf8').replace(/\r\n/g, '\n');
const marker = '// ATHLYRAX_FEEDBACK_MAIL_ROUTES_V1';
const anchor = 'const server = app.listen(PORT, () => {';
const registration = [
  marker,
  "const { registerFeedbackRoutes } = await import('./feedback-routes.mjs');",
  'registerFeedbackRoutes({',
  '  app, fs, path, crypto, storageRoot: STORAGE_ROOT, tenantsDir: DB_TENANTS_DIR,',
  '  resolveStoragePathsForAuth, isPrimarySoftwareOwnerAccount, requireStrictAuth, requireAdminRateLimit,',
  '  enqueueWrite, getAuthResetMailTransport,',
  '  smtp: { host: AUTH_SMTP_HOST, from: AUTH_SMTP_FROM },',
  '  appendAuthAuditEvent,',
  '});',
  '',
  '',
].join('\n');
if (!fs.existsSync(path.resolve('feedback-routes.mjs'))) throw new Error('Feedback implementation module missing.');
if (!source.includes(marker)) {
  if (!source.includes(anchor)) throw new Error('Backend listener anchor not found for feedback route registration.');
  source = source.replace(anchor, registration + anchor);
  fs.writeFileSync(indexPath, source, 'utf8');
}
if (!source.includes('registerFeedbackRoutes({') || !source.includes(marker)) throw new Error('Feedback route registration failed.');
console.log('FEEDBACK_MAIL_ROUTES_INSTALLED');
