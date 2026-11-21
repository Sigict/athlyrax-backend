// One classification for Training Data, the Training radar and ISP report.
// The coach's stored/overridden energy code is authoritative. Only when a
// source is unset/AUTO may the derived Planner classification supply a code.
export const CANONICAL_TRAINING_ENERGY_CODES = Object.freeze(['EN1','EN2','EN3','LP','LT','SP','Unclassified']);
const clean = input => String(input ?? '').trim().toUpperCase().replace(/[\s_-]+/g,'');
const aliases = Object.freeze({SPEED:'SP',SPRINT:'SP',LACTATEPRODUCTION:'LP',LACTATETOLERANCE:'LT'});
const classified = input => {
  const token=clean(input);
  const resolved=aliases[token] || token;
  return CANONICAL_TRAINING_ENERGY_CODES.includes(resolved) && resolved!=='Unclassified' ? resolved : '';
};
export function resolveCanonicalTrainingEnergy(row={}) {
  // Explicit manual override wins. The saved Planner prescription `energy`
  // precedes the auxiliary `energySystem` field: legacy hydration can populate
  // that auxiliary field from an automatic classifier even when the coach saved
  // SP (or LP/LT) as the actual set code. Never silently turn SP into EN2.
  const sources=[
    ['override',row?.energySystemOverride],
    ['persisted',row?.energy],
    ['persisted',row?.energySystem],
    ['derived',row?.__finalEnergySystem],
  ];
  for(const [source,input] of sources){
    const energySystem=classified(input);
    if(energySystem) return {energySystem,source};
  }
  return {energySystem:'Unclassified',source:'missing'};
}
export function canonicalTrainingWeekStart(input) {
  const s=String(input ?? '').trim();
  let year,month,day;
  const iso=s.match(/^(\d{4})-(\d{2})-(\d{2})(?:$|T)/);
  // UK dates are dd-MM-yyyy; never feed these to Date.parse (US mm-dd).
  const uk=s.match(/^(\d{2})[-/](\d{2})[-/](\d{4})$/);
  if(iso){year=+iso[1];month=+iso[2];day=+iso[3];}
  else if(uk){year=+uk[3];month=+uk[2];day=+uk[1];}
  else {
    const n=Date.parse(s);
    if(!Number.isFinite(n))return '';
    const d=new Date(n);year=d.getUTCFullYear();month=d.getUTCMonth()+1;day=d.getUTCDate();
  }
  const d=new Date(Date.UTC(year,month-1,day,12));
  if(d.getUTCFullYear()!==year||d.getUTCMonth()!==month-1||d.getUTCDate()!==day)return '';
  d.setUTCDate(d.getUTCDate()-(d.getUTCDay()+6)%7);
  return d.toISOString().slice(0,10);
}
