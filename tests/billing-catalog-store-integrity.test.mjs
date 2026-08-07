import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { validateBillingCatalogSemanticIntegrity } from '../scripts/billing-catalog-store-integrity.mjs';

function writeCatalog(value) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'athlyrax-billing-catalog-'));
  const filePath = path.join(root, 'billing-catalog.json');
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  return { billingCatalogPath: filePath };
}

test('valid persisted billing catalog passes semantic validation', () => {
  const configuration = writeCatalog({
    currency: 'GBP',
    settings: { enforceCharging: false, checkoutEnabled: true, baseTrialDays: 28, referralBonusDays: 14, pageVisibilityByTier: {} },
    plans: [
      { key: 'tier-1', amountMinor: 1800, stripePriceId: 'price_one', limits: { maxCoaches: 1, maxSwimmers: 24, maxSquads: 1 } },
      { key: 'tier-2', amountMinor: 2800, stripePriceId: 'price_two', limits: { maxCoaches: 1, maxSwimmers: 100, maxSquads: 4 } },
    ],
    addons: [{ key: 'extra-25', amountMinor: 1300, swimmers: 25 }],
  });
  assert.deepEqual(validateBillingCatalogSemanticIntegrity(configuration, process.env, fs), []);
});

test('duplicate Stripe prices and addon keys fail closed', () => {
  const configuration = writeCatalog({
    currency: 'GBP',
    plans: [
      { key: 'tier-1', amountMinor: 1800, stripePriceId: 'price_same' },
      { key: 'tier-2', amountMinor: 2800, stripePriceId: 'price_same' },
    ],
    addons: [
      { key: 'extra', amountMinor: 100, swimmers: 5 },
      { key: 'extra', amountMinor: 200, swimmers: 10 },
    ],
  });
  const failures = validateBillingCatalogSemanticIntegrity(configuration, process.env, fs).join('\n');
  assert.match(failures, /Stripe price ID is assigned to more than one billing plan/);
  assert.match(failures, /Billing addon key is duplicated/);
});

test('invalid money limits and settings fail closed', () => {
  const configuration = writeCatalog({
    currency: 'GB',
    settings: { enforceCharging: 'yes', checkoutEnabled: true, baseTrialDays: -1, pageVisibilityByTier: [] },
    plans: [{ key: 'tier-1', amountMinor: -1, limits: { maxCoaches: -2, maxSwimmers: 24.5, maxSquads: null } }],
    addons: [{ key: 'extra', amountMinor: -4, swimmers: -1 }],
  });
  const failures = validateBillingCatalogSemanticIntegrity(configuration, process.env, fs).join('\n');
  assert.match(failures, /currency is invalid/);
  assert.match(failures, /amountMinor/);
  assert.match(failures, /maxCoaches/);
  assert.match(failures, /maxSwimmers/);
  assert.match(failures, /enforceCharging must be boolean/);
  assert.match(failures, /baseTrialDays must be a non-negative integer/);
  assert.match(failures, /pageVisibilityByTier must be an object/);
});
