import fs from 'node:fs';
import path from 'node:path';

const indexPath = path.resolve('index.js');
let source = fs.readFileSync(indexPath, 'utf8').replace(/\r\n/g, '\n');

const marker = '// ATHLYRAX_STRIPE_WEBHOOK_PROCESSING_AVAILABLE';
const legacy = `\tif (!stripeClient) {\n\t\tres.status(200).json({ ok: true, skipped: 'stripe_not_configured' });\n\t\treturn;\n\t}`;
const hardened = `\tif (!stripeClient) {\n\t\t// ${marker}\n\t\tif (IS_PRODUCTION) {\n\t\t\tres.status(503).json({ error: 'Stripe webhook processing is temporarily unavailable.' });\n\t\t\treturn;\n\t\t}\n\t\tres.status(200).json({ ok: true, skipped: 'stripe_not_configured' });\n\t\treturn;\n\t}`;

if (!source.includes(marker)) {
  if (!source.includes(legacy)) throw new Error('Stripe webhook unavailable-client anchor missing.');
  source = source.replace(legacy, hardened);
}

for (const required of [
  'ATHLYRAX_STRIPE_WEBHOOK_PROCESSING_AVAILABLE',
  'if (IS_PRODUCTION) {',
  "res.status(503).json({ error: 'Stripe webhook processing is temporarily unavailable.' });",
  "res.status(200).json({ ok: true, skipped: 'stripe_not_configured' });",
]) if (!source.includes(required)) throw new Error(`Stripe webhook availability hardening missing: ${required}`);

const routeStart = source.indexOf("app.post('/billing/webhook'");
const routeEnd = source.indexOf('\napp.', routeStart + 1);
if (routeStart < 0) throw new Error('Stripe webhook route missing.');
const route = source.slice(routeStart, routeEnd >= 0 ? routeEnd : source.length);
if (!route.includes(marker)) throw new Error('Stripe webhook availability marker is outside the webhook route.');
if (route.includes(`if (!stripeClient) {\n\t\tres.status(200).json({ ok: true, skipped: 'stripe_not_configured' });`)) {
  throw new Error('Production Stripe webhook can still acknowledge an unprocessed event.');
}

fs.writeFileSync(indexPath, source, 'utf8');
console.log('STRIPE_WEBHOOK_PROCESSING_AVAILABILITY_OK');
