import fs from 'node:fs';
import path from 'node:path';

const indexPath = path.resolve('index.js');
let source = fs.readFileSync(indexPath, 'utf8').replace(/\r\n/g, '\n');
const importLine = "import { installFeedbackRoutes } from './feedback-routes.mjs';";
const marker = '// ATHLYRAX_FEEDBACK_ROUTES_V1';

if (!source.includes(importLine)) {
  const anchor = "import nodemailer from 'nodemailer';";
  if (!source.includes(anchor)) throw new Error('Feedback install requires the canonical SMTP module import.');
  source = source.replace(anchor, anchor + '\n' + importLine);
}
if (!source.includes(marker)) {
  const anchor = 'const server = app.listen(PORT, () => {';
  if (!source.includes(anchor)) throw new Error('Could not identify exact backend app-listen anchor for feedback routes.');
  const registration = [
    marker,
    'installFeedbackRoutes(app, {',
    '  requireStrictAuth, requireSoftwareOwnerRole, requireAdminRateLimit,',
    '  resolveStoragePathsForAuth, isPrimarySoftwareOwnerAccount,',
    '  enqueueWrite, writeAtomicJsonFile, getAuthResetMailTransport,',
    "  storageRoot: STORAGE_ROOT, smtpHost: AUTH_SMTP_HOST, smtpFrom: AUTH_SMTP_FROM, validEmail: AUTH_EMAIL_PATTERN,",
    "  feedbackRecipient: String(process.env.FEEDBACK_NOTIFY_EMAIL || 'AthlyraX@outlook.com').trim(),",
    '});',
    '',
  ].join('\n');
  source = source.replace(anchor, registration + anchor);
}
for (const required of [marker, importLine, 'feedbackRecipient: String(process.env.FEEDBACK_NOTIFY_EMAIL']) {
  if (!source.includes(required)) throw new Error('Feedback route install is incomplete: ' + required);
}
fs.writeFileSync(indexPath, source, 'utf8');
console.log('ATHLYRAX_FEEDBACK_ROUTES_V1_OK');
