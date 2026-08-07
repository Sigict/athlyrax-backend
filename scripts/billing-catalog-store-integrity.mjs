import fs from 'node:fs';

function clean(value) { return String(value ?? '').trim(); }
function finiteNonNegativeInteger(value) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 0;
}
function validLimit(value) {
  return value === null || value === undefined || finiteNonNegativeInteger(value);
}

export function validateBillingCatalogSemanticIntegrity(configuration, _env = process.env, fsModule = fs) {
  if (!configuration || typeof configuration !== 'object') throw new Error('Storage configuration is required.');
  const filePath = configuration.billingCatalogPath;
  if (!filePath || !fsModule.existsSync(filePath)) return [`Billing catalog is missing: ${filePath || '(unknown path)'}`];

  let catalog;
  try { catalog = JSON.parse(fsModule.readFileSync(filePath, 'utf8')); }
  catch { return [`Billing catalog is not valid JSON: ${filePath}`]; }

  const failures = [];
  if (!catalog || typeof catalog !== 'object' || Array.isArray(catalog)) return [`Billing catalog must contain a JSON object: ${filePath}`];
  if (!Array.isArray(catalog.plans) || catalog.plans.length < 1) return [`Billing catalog must contain at least one plan: ${filePath}`];

  const currency = clean(catalog.currency || 'GBP').toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) failures.push(`Billing catalog currency is invalid: ${clean(catalog.currency)}.`);

  const planKeys = new Set();
  const priceIds = new Set();
  for (const [index, plan] of catalog.plans.entries()) {
    if (!plan || typeof plan !== 'object' || Array.isArray(plan)) {
      failures.push(`Billing plan row ${index} is invalid.`);
      continue;
    }
    const key = clean(plan.key);
    if (!key) failures.push(`Billing plan row ${index} is missing a key.`);
    else if (planKeys.has(key)) failures.push(`Billing plan key is duplicated: ${key}.`);
    else planKeys.add(key);

    const priceId = clean(plan.stripePriceId);
    if (priceId) {
      if (priceIds.has(priceId)) failures.push(`Stripe price ID is assigned to more than one billing plan: ${priceId}.`);
      else priceIds.add(priceId);
    }

    if (!finiteNonNegativeInteger(plan.amountMinor ?? 0)) failures.push(`Billing plan ${key || index} has invalid amountMinor.`);
    const limits = plan.limits;
    if (limits !== undefined && (!limits || typeof limits !== 'object' || Array.isArray(limits))) {
      failures.push(`Billing plan ${key || index} has invalid limits.`);
    } else if (limits) {
      for (const field of ['maxCoaches', 'maxSwimmers', 'maxSquads']) {
        if (!validLimit(limits[field])) failures.push(`Billing plan ${key || index} has invalid ${field}.`);
      }
    }
  }

  const addonKeys = new Set();
  const addons = catalog.addons === undefined ? [] : catalog.addons;
  if (!Array.isArray(addons)) failures.push('Billing catalog addons must be an array.');
  else {
    for (const [index, addon] of addons.entries()) {
      if (!addon || typeof addon !== 'object' || Array.isArray(addon)) {
        failures.push(`Billing addon row ${index} is invalid.`);
        continue;
      }
      const key = clean(addon.key);
      if (!key) failures.push(`Billing addon row ${index} is missing a key.`);
      else if (addonKeys.has(key)) failures.push(`Billing addon key is duplicated: ${key}.`);
      else addonKeys.add(key);
      if (!finiteNonNegativeInteger(addon.amountMinor ?? 0)) failures.push(`Billing addon ${key || index} has invalid amountMinor.`);
      if (!finiteNonNegativeInteger(addon.swimmers ?? 0)) failures.push(`Billing addon ${key || index} has invalid swimmers value.`);
    }
  }

  const settings = catalog.settings;
  if (settings !== undefined && (!settings || typeof settings !== 'object' || Array.isArray(settings))) {
    failures.push('Billing catalog settings must be an object.');
  } else if (settings) {
    for (const field of ['enforceCharging', 'checkoutEnabled']) {
      if (Object.prototype.hasOwnProperty.call(settings, field) && typeof settings[field] !== 'boolean') failures.push(`Billing catalog setting ${field} must be boolean.`);
    }
    for (const field of ['baseTrialDays', 'referralBonusDays']) {
      if (Object.prototype.hasOwnProperty.call(settings, field) && !finiteNonNegativeInteger(settings[field])) failures.push(`Billing catalog setting ${field} must be a non-negative integer.`);
    }
    if (Object.prototype.hasOwnProperty.call(settings, 'pageVisibilityByTier') && (!settings.pageVisibilityByTier || typeof settings.pageVisibilityByTier !== 'object' || Array.isArray(settings.pageVisibilityByTier))) {
      failures.push('Billing catalog pageVisibilityByTier must be an object.');
    }
  }

  return failures;
}
