import fs from 'node:fs';
import path from 'node:path';

const filePath = path.resolve('index.js');
let source = fs.readFileSync(filePath,'utf8').replace(/\r\n/g,'\n');
const marker = '// ATHLYRAX_OWNER_FEEDBACK_EMAIL_V1';
const importLine = "import { registerFeedbackRoutes } from './feedback-routes.mjs';\n";
if (!source.includes(importLine)) {
  if (!source.includes("import nodemailer from 'nodemailer';\n")) throw new Error('Feedback: expected Nodemailer import is absent');
  source = source.replace("import nodemailer from 'nodemailer';\n", "import nodemailer from 'nodemailer';\n"+importLine);
}
const anchor = 'const server = app.listen(PORT, () => {';
const inserted = [
  marker,
  'registerFeedbackRoutes({',
  '  app, requireStrictAuth, requireAdminRateLimit, isPrimarySoftwareOwnerAccount,',
  '  resolveStoragePathsForAuth, readJsonFile, writeAtomicJsonFile, enqueueWrite,',
  '  appendAuthAuditEvent, storageRoot: STORAGE_ROOT,',
  '  getMailTransport: getAuthResetMailTransport,',
  '  smtpHost: AUTH_SMTP_HOST, smtpFrom: AUTH_SMTP_FROM,',
  "  notifyTo: String(process.env.FEEDBACK_NOTIFY_TO || 'AthlyraX@outlook.com').trim(),",
  '});',
  '',
  '',
].join('\n');
if (!source.includes(marker)) {
  if (!source.includes(anchor)) throw new Error('Feedback: server-start anchor missing');
  source = source.replace(anchor,inserted+anchor);
}
if (!source.includes(importLine)||!source.includes(inserted)) throw new Error('Feedback route registration incomplete');
fs.writeFileSync(filePath,source,'utf8');
console.log('ATHLYRAX_OWNER_FEEDBACK_EMAIL_V1_OK');
