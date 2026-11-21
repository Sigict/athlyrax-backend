// The two one-time repairs of the synthetic demonstration club for Robustness of Efficiency v3.2, applied together by
// the backend at production start (scripts/upgrade-demo-robustness-v32.mjs: backup first, then ONE atomic write), never
// by the browser:
//  1. demoProgrammeEnergyRepair.js — the 144 manifest records whose saved energy code contradicts the programme;
//  2. demoStrokeModelV2Upgrade.js — synthetic stroke counts regenerated with the documented demonstration model (after
//     1, because the model's fatigue follows each set's energy code).
// Each step has its own one-time marker in __meta.demoSeed, so the function is idempotent: on an already repaired club it
// returns the SAME object (changed: false). Pure: the input is never modified, so a failure leaves nothing half-done.
import { isSyntheticDemoDb } from './demoSetSendOffs.js';
import { upgradeDemoProgrammeEnergy, DEMO_PROGRAMME_ENERGY_REPAIR_VERSION } from './demoProgrammeEnergyRepair.js';
import { applyModelV2, STROKE_MODEL_V2_REPAIR_VERSION } from './demoStrokeModelV2Upgrade.js';
import { DEMO_ENERGY_MIX_VERSION } from './demoEnergyMix.js';

export const DEMO_ROBUSTNESS_V32_MARKERS = Object.freeze({ programmeEnergyRepairVersion: DEMO_PROGRAMME_ENERGY_REPAIR_VERSION, strokeModelV2Version: STROKE_MODEL_V2_REPAIR_VERSION });

export function demoRobustnessV32Pending(db) {
  const meta = db?.__meta?.demoSeed || {};
  return isSyntheticDemoDb(db) && Object.entries(DEMO_ROBUSTNESS_V32_MARKERS).some(([key, version]) => !(Number(meta[key]) >= version));
}

export function upgradeDemoRobustnessV32(db) {
  if (!isSyntheticDemoDb(db)) return { db, changed: false, reason: 'not-the-synthetic-demo-club' };
  if (Number(db?.__meta?.demoSeed?.energyMixVersion) < DEMO_ENERGY_MIX_VERSION) return { db, changed: false, reason: 'energy-mix-upgrade-not-applied' };
  if (!demoRobustnessV32Pending(db)) return { db, changed: false, reason: 'already-applied' };
  const afterEnergy = upgradeDemoProgrammeEnergy(db);
  const { next, stats } = applyModelV2(afterEnergy);
  return { db: next, changed: next !== db, reason: 'applied',
    energyRepaired: Number(next?.__meta?.demoSeed?.programmeEnergyRepaired ?? 0), stroke: stats };
}
