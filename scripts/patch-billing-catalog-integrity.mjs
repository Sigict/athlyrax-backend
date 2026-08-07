import fs from 'node:fs';
import path from 'node:path';

const indexPath = path.resolve('index.js');
let source = fs.readFileSync(indexPath, 'utf8').replace(/\r\n/g, '\n');

const oldBlock = `\tconst normalized = normalizeBillingCatalog(payload);\n\tif (!Array.isArray(normalized?.plans) || normalized.plans.length < 1) {\n\t\tres.status(400).json({ error: 'At least one billing plan is required.' });\n\t\treturn;\n\t}\n\n\tconst payloadHasPageVisibilityByTier = payload?.settings`;
const newBlock = `\t// ATHLYRAX_BILLING_CATALOG_PARTIAL_UPDATE_PRESERVES_STATE\n\tconst payloadHasPlans = Object.prototype.hasOwnProperty.call(payload, 'plans');\n\tconst payloadHasAddons = Object.prototype.hasOwnProperty.call(payload, 'addons');\n\tconst payloadHasSettings = payload?.settings && typeof payload.settings === 'object' && !Array.isArray(payload.settings);\n\tif (payloadHasPlans && (!Array.isArray(payload.plans) || payload.plans.length < 1)) {\n\t\tres.status(400).json({ error: 'At least one billing plan is required.' });\n\t\treturn;\n\t}\n\tif (payloadHasAddons && !Array.isArray(payload.addons)) {\n\t\tres.status(400).json({ error: 'Billing addons must be an array.' });\n\t\treturn;\n\t}\n\tconst normalized = normalizeBillingCatalog({\n\t\t...billingCatalog,\n\t\t...payload,\n\t\tcurrency: Object.prototype.hasOwnProperty.call(payload, 'currency') ? payload.currency : billingCatalog?.currency,\n\t\tplans: payloadHasPlans ? payload.plans : getBillingPlansCatalog(),\n\t\taddons: payloadHasAddons ? payload.addons : (Array.isArray(billingCatalog?.addons) ? billingCatalog.addons : []),\n\t\tsettings: payloadHasSettings ? { ...getBillingPolicy(), ...payload.settings } : getBillingPolicy(),\n\t});\n\tif (!Array.isArray(normalized?.plans) || normalized.plans.length < 1) {\n\t\tres.status(400).json({ error: 'At least one billing plan is required.' });\n\t\treturn;\n\t}\n\tconst planKeys = normalized.plans.map((plan) => String(plan?.key || '').trim());\n\tif (new Set(planKeys).size !== planKeys.length) {\n\t\tres.status(400).json({ error: 'Billing plan keys must be unique.' });\n\t\treturn;\n\t}\n\tconst configuredPriceIds = normalized.plans.map((plan) => String(plan?.stripePriceId || '').trim()).filter(Boolean);\n\tif (new Set(configuredPriceIds).size !== configuredPriceIds.length) {\n\t\tres.status(400).json({ error: 'Each configured Stripe price ID may belong to only one billing plan.' });\n\t\treturn;\n\t}\n\tconst addonKeys = (Array.isArray(normalized?.addons) ? normalized.addons : []).map((addon) => String(addon?.key || '').trim()).filter(Boolean);\n\tif (new Set(addonKeys).size !== addonKeys.length) {\n\t\tres.status(400).json({ error: 'Billing addon keys must be unique.' });\n\t\treturn;\n\t}\n\n\tconst payloadHasPageVisibilityByTier = payload?.settings`;

if (!source.includes('ATHLYRAX_BILLING_CATALOG_PARTIAL_UPDATE_PRESERVES_STATE')) {
  if (!source.includes(oldBlock)) throw new Error('Billing catalog validation anchor was not found.');
  source = source.replace(oldBlock, newBlock);
}

for (const token of [
  'ATHLYRAX_BILLING_CATALOG_PARTIAL_UPDATE_PRESERVES_STATE',
  'Billing plan keys must be unique.',
  'Each configured Stripe price ID may belong to only one billing plan.',
  'Billing addon keys must be unique.',
]) if (!source.includes(token)) throw new Error(`Billing catalog integrity token is missing: ${token}`);

fs.writeFileSync(indexPath, source, 'utf8');
console.log('BILLING_CATALOG_INTEGRITY_OK');
