// One-time repair of the synthetic demonstration programme's energy codes (owner review 21-11-2026, item 1).
//
// DEFECT (found in the live Demo Coach club, revision 2519): 144 demo showcase sets carry a saved Planner `energy` code
// that contradicts BOTH their own `energySystem` field AND the programme that generated them (set name, phase and
// structure) — e.g. "12x100 Aerobic Warm Up" energy EN2 / energySystem EN1, "16x25 Speed …" EN2 / SP, "12x50 Power /
// Breakout" EN2 / LP, "8x100 Recovery Control" EN3 / EN1. The canonical resolver deliberately prefers the saved `energy`
// (canonicalTrainingEnergyAuthority.js), so every classification rule (ROE-S1, DUR-S1, ENERGY, Training demand) read
// the wrong intensity. The records were last changed on 17-11-2026 with no attribution; the writer cannot be traced
// from the data. The repository's demo seed (scripts/build-demo-tenant-dataset.mjs) is correct.
//
// RULE: the energy code of each demo programme set is the one the demo programme defines for its phase, set slot and
// name (DEMO_PROGRAMME_ENERGY, identical to the seed — checked by a regression test). A set is repaired ONLY when
//  1. it is listed in DEMO_PROGRAMME_ENERGY_REPAIR_MANIFEST (the 144 records found in the read-only snapshot), AND
//  2. it still holds exactly the two conflicting saved values recorded there (any later edit — by a coach or anything
//     else — is left untouched), AND
//  3. its two saved fields disagree with each other and `energy` differs from the programme (re-derived here, and the
//     manifest's replacement must equal it).
// Version-gated and one-time; a repaired row no longer matches the manifest, so a second run changes nothing. Other
// demo generators and real clubs are never touched. The previous values are kept on the row.
import { isSyntheticDemoDb } from './demoSetSendOffs.js';
import { DEMO_PROGRAMME_ENERGY_REPAIR_MANIFEST } from '../data/demoProgrammeEnergyRepairManifest.js';

export const DEMO_PROGRAMME_ENERGY_REPAIR_VERSION = 1;
const DEMO_SET_PREFIX = 'demo_showcase_set_';
const code = (value) => String(value ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');

// phase | set slot (id suffix) | set name -> energy code, as defined by the demo programme (seed builder).
export const DEMO_PROGRAMME_ENERGY = Object.freeze({
  'INTRO|warm|12x100 Aerobic Warm Up': 'EN1',
  'INTRO|main|20x100 Technical Aerobic': 'EN1',
  'INTRO|skill|12x100 Skill Transfer': 'EN1',
  'INTRO|kick|8x50 Kick / Skills': 'EN1',
  'INTRO|speed|16x25 Speed Skills': 'SP',
  'AEROBIC|warm|12x100 EN1 Build': 'EN1',
  'AEROBIC|main|32x100 Aerobic Capacity': 'EN1',
  'AEROBIC|threshold|16x100 Threshold Control': 'EN2',
  'AEROBIC|skill|8x50 Technical Control': 'EN1',
  'AEROBIC|speed|16x25 Speed Maintenance': 'SP',
  'SPECIFIC|warm|10x100 EN1 Preparation': 'EN1',
  'SPECIFIC|main|28x100 Race Specific Aerobic': 'EN2',
  'SPECIFIC|pace|14x100 Race Pace': 'EN3',
  'SPECIFIC|power|12x50 Power / Breakout': 'LP',
  'SPECIFIC|speed|16x25 Speed Expression': 'SP',
  'TAPER|warm|8x100 EN1 Preparation': 'EN1',
  'TAPER|pace|18x100 Race Pace Quality': 'EN3',
  'TAPER|easy|8x100 Recovery Control': 'EN1',
  'TAPER|power|10x50 Power': 'LP',
  'TAPER|speed|16x25 Speed Expression': 'SP',
});

export const demoProgrammeKey = (set) => {
  const id = String(set?.id ?? '');
  return `${String(set?.phase ?? '').trim().toUpperCase()}|${id.slice(id.lastIndexOf('_') + 1)}|${String(set?.setName ?? '').trim()}`;
};

const MANIFEST = new Map(DEMO_PROGRAMME_ENERGY_REPAIR_MANIFEST.map(([id, energy, energySystem, replacement]) => [id, { energy, energySystem, replacement }]));

/** The programme's code when this set conflicts with itself and with the programme (rule 3 only), otherwise null. */
export function programmeConflictEnergy(set) {
  if (!String(set?.id ?? '').startsWith(DEMO_SET_PREFIX) || set?.isTestSet === true) return null;
  const programme = DEMO_PROGRAMME_ENERGY[demoProgrammeKey(set)];
  if (!programme) return null;
  const energy = code(set?.energy); const system = code(set?.energySystem);
  if (!energy || !system || energy === system) return null; // consistent (or single-field) rows are never changed
  return energy === programme ? null : programme;
}

/** The programme's energy code when this set may be repaired (rules 1–3), otherwise null. */
export function repairedDemoProgrammeEnergy(set) {
  const listed = MANIFEST.get(String(set?.id ?? ''));
  if (!listed || set?.energy !== listed.energy || set?.energySystem !== listed.energySystem) return null;
  const programme = programmeConflictEnergy(set);
  return programme && programme === listed.replacement ? programme : null;
}

/** One-time upgrade of the synthetic demo tenant (no-op for real clubs and after it has run). */
export function upgradeDemoProgrammeEnergy(db) {
  if (!isSyntheticDemoDb(db) || Number(db?.__meta?.demoSeed?.programmeEnergyRepairVersion) >= DEMO_PROGRAMME_ENERGY_REPAIR_VERSION) return db;
  const sets = Array.isArray(db?.trainingSessionSets) ? db.trainingSessionSets : [];
  let repaired = 0;
  const next = sets.map((set) => {
    const energy = repairedDemoProgrammeEnergy(set);
    if (!energy) return set;
    repaired += 1;
    return { ...set, energy, energySystem: energy, energyBeforeRepair: { energy: set.energy, energySystem: set.energySystem },
      energySource: 'synthetic-demo-programme' };
  });
  return { ...db, trainingSessionSets: next,
    __meta: { ...(db.__meta || {}), demoSeed: { ...(db.__meta?.demoSeed || {}), programmeEnergyRepairVersion: DEMO_PROGRAMME_ENERGY_REPAIR_VERSION, programmeEnergyRepaired: repaired } } };
}
