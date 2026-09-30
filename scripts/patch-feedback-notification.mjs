import fs from 'node:fs';

const filename = 'index.js';
let source = fs.readFileSync(filename, 'utf8').replace(/\r\n/g, '\n');
const importLine = "import { installFeedbackRoutes } from './feedback-routes.mjs';";
const importAnchor = "import Stripe from 'stripe';";
if (!source.includes(importLine)) {
  if (!source.includes(importAnchor)) throw new Error('Feedback import anchor missing.');
  source = source.replace(importAnchor, importAnchor + '\n' + importLine);
}
const marker = '// ATHLYRAX_FEEDBACK_ROUTES_V1';
const installBlock = [
  marker,
  'installFeedbackRoutes({',
  '  app, requireStrictAuth, resolveStoragePathsForAuth,',
  '  isPrimarySoftwareOwnerAccount, enqueueWrite, writeAtomicJsonFile,',
  '  getAuthResetMailTransport, smtpHost: AUTH_SMTP_HOST, smtpFrom: AUTH_SMTP_FROM,',
  '  storageRoot: STORAGE_ROOT, authUserLookup: findAuthUser, appendAuthAuditEvent,',
  '});',
].join('\n');
const startupAnchor = 'const server = app.listen(PORT, () => {';
if (!source.includes(marker)) {
  if (!source.includes(startupAnchor)) throw new Error('Feedback install anchor missing.');
  source = source.replace(startupAnchor, installBlock + '\n\n' + startupAnchor);
}
if (!source.includes(importLine) || !source.includes(installBlock)) throw new Error('Feedback runtime installation incomplete.');
fs.writeFileSync(filename, source, 'utf8');
console.log('ATHLYRAX_FEEDBACK_ROUTES_INSTALLED');
