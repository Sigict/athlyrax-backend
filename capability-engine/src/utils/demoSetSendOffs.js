// Send-offs for the synthetic demonstration programme only. They are coach
// prescriptions labelled 'synthetic-demo', set by energy system and repetition
// distance; the main EN1/EN2 100s tighten across the season (1:45 -> 1:35,
// 1:35 -> 1:25) so the demo shows recovery changing. Real clubs and edited rows are never touched.
const DEMO_SET_PREFIX = 'demo_showcase_set_';
export const DEMO_SEND_OFF_VERSION = 1;

const text = (value) => String(value ?? '').trim();
const formatSendOff = (seconds) => `${Math.floor(seconds / 60)}:${String(Math.round(seconds % 60)).padStart(2, '0')}`;
const repSeconds = (value) => {
  const parts = text(value).split(':').map(Number);
  if (!parts.length || parts.some((n) => !Number.isFinite(n))) return null;
  return parts.reduce((total, n) => total * 60 + n, 0);
};

export function demoSendOffSeconds(set) {
  const week = Number((text(set?.id).match(/_set_w(\d+)_/) || [])[1]) || 1;
  const energy = text(set?.energy || set?.energySystem).toUpperCase();
  const distance = Number(set?.distance) || 0;
  const choice = /choice/i.test(text(set?.stroke));
  let seconds;
  if (distance === 100) {
    seconds = energy === 'EN2' ? Math.max(85, 96 - week)
      : energy === 'EN3' ? 110
        : choice ? 105
          // EN1 freestyle 100s also tighten across the season (1:45 -> 1:35).
          : energy === 'EN1' ? Math.max(95, 106 - week) : 100;
  } else if (distance === 50) seconds = energy === 'LP' ? 60 : energy === 'EN2' ? 70 : 60;
  else if (distance === 25) seconds = 45;
  else if (distance > 0) seconds = Math.round(distance + 15);
  else return null;
  // Never shorter than a recorded repetition: rest is send-off minus swim time.
  const recorded = Object.values(set?.resultsBySwimmer || {})
    .flatMap((result) => (Array.isArray(result?.reps) ? result.reps : []))
    .map((rep) => repSeconds(rep?.overallTime || rep?.time)).filter((n) => Number.isFinite(n) && n > 0);
  const slowest = recorded.length ? Math.max(...recorded) : 0;
  if (slowest && seconds < slowest + 5) seconds = Math.ceil(slowest + 5);
  return seconds;
}

export function withDemoSendOff(set) {
  if (!text(set?.id).startsWith(DEMO_SET_PREFIX) || set?.isTestSet === true || text(set?.setType).toLowerCase() === 'test') return set;
  if (text(set?.sendOff)) return set;
  const seconds = demoSendOffSeconds(set);
  return seconds ? { ...set, sendOff: formatSendOff(seconds), sendOffSource: 'synthetic-demo' } : set;
}

// The synthetic demonstration dataset, under whichever tenant it was installed.
export const isSyntheticDemoDb = (db) => text(db?.__meta?.demoSeed?.prefix) === 'demo_showcase_';

/** One-time upgrade of the synthetic demo tenant: adds send-offs where none is set. */
export function upgradeDemoSetSendOffs(db) {
  if (!isSyntheticDemoDb(db) || Number(db?.__meta?.demoSeed?.sendOffVersion) >= DEMO_SEND_OFF_VERSION) return db;
  const sets = Array.isArray(db?.trainingSessionSets) ? db.trainingSessionSets : [];
  return {
    ...db,
    trainingSessionSets: sets.map(withDemoSendOff),
    __meta: { ...(db.__meta || {}), demoSeed: { ...(db.__meta?.demoSeed || {}), sendOffVersion: DEMO_SEND_OFF_VERSION } },
  };
}
