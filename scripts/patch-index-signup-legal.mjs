import fs from 'node:fs';
import path from 'node:path';

const indexPath = path.resolve('index.js');
let source = fs.readFileSync(indexPath, 'utf8').replace(/\r\n/g, '\n');

const importLine = `import { installSignupLegalAcceptanceGuard } from './scripts/signup-legal-acceptance-preload.mjs';`;
const importAnchor = `import Stripe from 'stripe';`;
if (!source.includes(importLine)) {
  if (!source.includes(importAnchor)) {
    throw new Error('Could not find the backend import anchor for signup legal enforcement.');
  }
  source = source.replace(importAnchor, `${importAnchor}\n${importLine}`);
}

const appAnchor = `const app = express();`;
const guardedAppAnchor = `installSignupLegalAcceptanceGuard(express);\nconst app = express();`;
if (!source.includes(guardedAppAnchor)) {
  if (!source.includes(appAnchor)) {
    throw new Error('Could not find the backend Express application anchor for signup legal enforcement.');
  }
  source = source.replace(appAnchor, guardedAppAnchor);
}

for (const token of [importLine, 'installSignupLegalAcceptanceGuard(express);', appAnchor]) {
  if (!source.includes(token)) throw new Error(`Missing patched production signup guard token: ${token}`);
}

fs.writeFileSync(indexPath, source, 'utf8');
console.log('PRODUCTION_SIGNUP_LEGAL_ENTRYPOINT_PATCH_OK');
