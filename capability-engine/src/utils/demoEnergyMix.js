// One-time correction of the synthetic demonstration programme: the older
// demo seed labelled about half of its metres as hard work (EN3/LP/SP), far
// from published elite practice (roughly 75% easy, 18% moderate, 7% hard;
// González-Ravé et al. 2021). Aerobic-named demo sets are relabelled to the
// energy system their name describes. Real clubs and edited rows are never
// touched; relabelled rows keep a record of the original label.
import { isSyntheticDemoDb } from './demoSetSendOffs.js';

export const DEMO_ENERGY_MIX_VERSION = 1;
const DEMO_SET_PREFIX = 'demo_showcase_set_';
const text = (value) => String(value ?? '').trim();
// phase | id suffix -> [label in the old seed, corrected label]
const RELABEL = Object.freeze({
  'INTRO|main': ['EN2', 'EN1'],
  'INTRO|kick': ['EN2', 'EN1'],
  'AEROBIC|main': ['EN2', 'EN1'],
  'AEROBIC|threshold': ['EN3', 'EN2'],
  'SPECIFIC|main': ['EN3', 'EN2'],
});

export function correctedDemoEnergy(set) {
  const id = text(set?.id);
  if (!id.startsWith(DEMO_SET_PREFIX)) return null;
  const suffix = id.slice(id.lastIndexOf('_') + 1);
  const rule = RELABEL[`${text(set?.phase).toUpperCase()}|${suffix}`];
  const current = text(set?.energy || set?.energySystem).toUpperCase();
  return rule && current === rule[0] ? rule[1] : null;
}

/** One-time upgrade of the synthetic demo tenant's energy labels. */
export function upgradeDemoEnergyMix(db) {
  if (!isSyntheticDemoDb(db) || Number(db?.__meta?.demoSeed?.energyMixVersion) >= DEMO_ENERGY_MIX_VERSION) return db;
  const sets = Array.isArray(db?.trainingSessionSets) ? db.trainingSessionSets : [];
  return {
    ...db,
    trainingSessionSets: sets.map((set) => {
      const energy = correctedDemoEnergy(set);
      return energy ? { ...set, energy, energySystem: energy, energySeedLabel: text(set.energy || set.energySystem), energySource: 'synthetic-demo-relabelled' } : set;
    }),
    __meta: { ...(db.__meta || {}), demoSeed: { ...(db.__meta?.demoSeed || {}), energyMixVersion: DEMO_ENERGY_MIX_VERSION } },
  };
}
