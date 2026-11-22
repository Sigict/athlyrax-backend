// One-time wording correction of the demonstration club (owner decision 22-11-2026: the word "synthetic" appears on no
// screen). The demo club's training-set descriptions and session notes carry one of twelve fixed generated phrases that
// end with "(synthetic demonstration)" / "· synthetic demonstration"; that ending is removed. Only these exact phrases,
// only in the demonstration club, only once (demoSeed.wordingCorrectionVersion). No other field and no number changes.
// Applied by the backend at production start (backup first, one atomic write) once the owner approves it.
import { isSyntheticDemoDb } from './demoSetSendOffs.js';

export const DEMO_WORDING_CORRECTION_VERSION = 1;
const PHASES = ['INTRO', 'AEROBIC', 'SPECIFIC', 'TAPER'];
const SQUADS = ['County', 'International'];
export const DEMO_WORDING_REPLACEMENTS = Object.freeze({
  description: Object.freeze(Object.fromEntries(SQUADS.flatMap((squad) => PHASES.map((phase) => [
    `Demonstration · ${squad} · ${phase} squad programme (synthetic demonstration)`, `Demonstration · ${squad} · ${phase} squad programme`])))),
  notes: Object.freeze(Object.fromEntries(PHASES.map((phase) => [`${phase} · squad programme · synthetic demonstration`, `${phase} · squad programme`]))),
});

export function demoWordingCorrectionPending(db) {
  return isSyntheticDemoDb(db) && !(Number(db?.__meta?.demoSeed?.wordingCorrectionVersion) >= DEMO_WORDING_CORRECTION_VERSION);
}

/** Pure: returns { db, changed, sets, sessions }; the input is never modified; a corrected club returns the same object. */
export function correctDemoWording(db) {
  if (!demoWordingCorrectionPending(db)) return { db, changed: false, sets: 0, sessions: 0 };
  let sets = 0; let sessions = 0;
  const trainingSessionSets = (Array.isArray(db.trainingSessionSets) ? db.trainingSessionSets : []).map((row) => {
    const next = DEMO_WORDING_REPLACEMENTS.description[row?.description];
    if (next === undefined) return row;
    sets += 1; return { ...row, description: next };
  });
  const trainingSessions = (Array.isArray(db.trainingSessions) ? db.trainingSessions : []).map((row) => {
    const next = DEMO_WORDING_REPLACEMENTS.notes[row?.notes];
    if (next === undefined) return row;
    sessions += 1; return { ...row, notes: next };
  });
  const out = { ...db,
    ...(Array.isArray(db.trainingSessionSets) ? { trainingSessionSets } : {}),
    ...(Array.isArray(db.trainingSessions) ? { trainingSessions } : {}),
    __meta: { ...(db.__meta || {}), demoSeed: { ...(db.__meta?.demoSeed || {}), wordingCorrectionVersion: DEMO_WORDING_CORRECTION_VERSION, wordingCorrected: { sets, sessions } } } };
  return { db: out, changed: true, sets, sessions };
}
