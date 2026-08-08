import fs from 'node:fs';
import path from 'node:path';

const indexPath = path.resolve('index.js');
let source = fs.readFileSync(indexPath, 'utf8').replace(/\r\n/g, '\n');

const marker = '// ATHLYRAX_STRIPE_WEBHOOK_SIGNATURE_REQUIRED';
const legacyBlock = `\ttry {\n\t\tif (BILLING_STRIPE_WEBHOOK_SECRET && signature) {\n\t\t\tevent = stripeClient.webhooks.constructEvent(req.body, signature, BILLING_STRIPE_WEBHOOK_SECRET);\n\t\t} else {\n\t\t\tconst rawBody = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : String(req.body || '{}');\n\t\t\tevent = JSON.parse(rawBody);\n\t\t}\n\t} catch (error) {`;
const hardenedBlock = `\ttry {\n\t\t${marker}\n\t\tif (BILLING_STRIPE_WEBHOOK_SECRET) {\n\t\t\tif (!signature) {\n\t\t\t\tres.status(400).json({ error: 'Stripe webhook signature is required.' });\n\t\t\t\treturn;\n\t\t\t}\n\t\t\tevent = stripeClient.webhooks.constructEvent(req.body, signature, BILLING_STRIPE_WEBHOOK_SECRET);\n\t\t} else {\n\t\t\tif (IS_PRODUCTION) {\n\t\t\t\tres.status(503).json({ error: 'Stripe webhook verification is not configured.' });\n\t\t\t\treturn;\n\t\t\t}\n\t\t\tconst rawBody = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : String(req.body || '{}');\n\t\t\tevent = JSON.parse(rawBody);\n\t\t}\n\t} catch (error) {`;

if (!source.includes(marker)) {
  if (!source.includes(legacyBlock)) throw new Error('Stripe webhook verification anchor was not found.');
  source = source.replace(legacyBlock, hardenedBlock);
}

for (const token of [
  'ATHLYRAX_STRIPE_WEBHOOK_SIGNATURE_REQUIRED',
  "if (!signature) {",
  'Stripe webhook signature is required.',
  'Stripe webhook verification is not configured.',
  'stripeClient.webhooks.constructEvent(req.body, signature, BILLING_STRIPE_WEBHOOK_SECRET)',
]) if (!source.includes(token)) throw new Error(`Stripe webhook signature hardening missing: ${token}`);

if (source.includes('if (BILLING_STRIPE_WEBHOOK_SECRET && signature) {')) {
  throw new Error('Unsigned Stripe webhook fallback remains when a webhook secret is configured.');
}

fs.writeFileSync(indexPath, source, 'utf8');
console.log('STRIPE_WEBHOOK_SIGNATURE_HARDENING_OK');
