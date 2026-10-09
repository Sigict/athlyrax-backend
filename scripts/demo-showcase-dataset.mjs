import fs from 'node:fs';
import path from 'node:path';

const PREFIX = 'demo_showcase_';
const TENANT_ID = 'demo-company';
const ACCOUNT_SCOPE = 'demo.coach';
const ACCOUNT_ID = `${TENANT_ID}:${ACCOUNT_SCOPE}`;
const CREATED_AT = '2026-08-31T08:00:00.000Z';

const ownerScope = {
  ownerUsername: ACCOUNT_SCOPE,
  ownerTenantId: TENANT_ID,
  accountScope: ACCOUNT_SCOPE,
  tenantScope: TENANT_ID,
  accountId: ACCOUNT_ID,
  createdBy: ACCOUNT_SCOPE,
};

const iso = (value) => new Date(`${value}T12:00:00.000Z`).toISOString();
const dateKey = (date) => new Date(date).toISOString().slice(0, 10);
const addDays = (date, days) => {
  const next = new Date(`${date}T12:00:00.000Z`);
  next.setUTCDate(next.getUTCDate() + days);
  return dateKey(next);
};
const secToTime = (seconds) => {
  const whole = Math.round(seconds * 100) / 100;
  const minutes = Math.floor(whole / 60);
  const remainder = (whole - minutes * 60).toFixed(2).padStart(5, '0');
  return minutes > 0 ? `${minutes}:${remainder}` : remainder;
};
const asArray = (value) => Array.isArray(value) ? value : [];

const squadDefinitions = [
  { id: `${PREFIX}perf_a`, name: 'Performance A', code: 'PERF-A', category: 'Performance', trainingLevel: 'Performance', ageRange: '15–18', maxCapacity: 16, sortOrder: 1, order: 1 },
  { id: `${PREFIX}perf_b`, name: 'Performance B', code: 'PERF-B', category: 'Performance', trainingLevel: 'Competitive', ageRange: '13–16', maxCapacity: 18, sortOrder: 2, order: 2 },
  { id: `${PREFIX}development`, name: 'Development', code: 'DEV', category: 'Development', trainingLevel: 'Development', ageRange: '10–13', maxCapacity: 20, sortOrder: 3, order: 3 },
];

const coachDefinitions = [
  { id: `${PREFIX}coach_head`, firstName: 'Alex', lastName: 'Morgan', name: 'Alex Morgan', email: 'alex.morgan@demo.athlyrax.test', role: 'head-coach', qualification: 'Level 3 Coach', active: true },
  { id: `${PREFIX}coach_assistant`, firstName: 'Maya', lastName: 'Lewis', name: 'Maya Lewis', email: 'maya.lewis@demo.athlyrax.test', role: 'assistant-coach', qualification: 'Level 2 Coach', active: true },
  { id: `${PREFIX}coach_development`, firstName: 'Daniel', lastName: 'Reed', name: 'Daniel Reed', email: 'daniel.reed@demo.athlyrax.test', role: 'coach', qualification: 'Level 2 Coach', active: true },
];

const swimmerNames = {
  [`${PREFIX}perf_a`]: [
    // Final value is a canonical 100 Free-equivalent baseline used consistently
    // by Max tests and demo competition results. It is NOT the swimmer's main-event PB.
    ['Mia','Carter','Female','2010-02-14','100 Free',61.80],
    ['Noah','Bennett','Male','2009-09-22','100 Free',57.20],
    ['Sofia','Martinez','Female','2010-06-05','200 Free',63.80],
    ['Leo','Hughes','Male','2008-11-19','100 Fly',59.60],
    ['Amelia','Foster','Female','2009-04-03','100 Back',64.20],
    ['Ethan','Ward','Male','2009-12-30','200 IM',59.00],
    ['Isla','Murphy','Female','2010-01-27','100 Breast',65.40],
    ['Lucas','Price','Male','2008-07-11','50 Free',56.20],
  ],
  [`${PREFIX}perf_b`]: [
    ['Grace','Turner','Female','2011-03-17','100 Free',66.40],
    ['Oscar','Hall','Male','2011-01-08','100 Back',68.90],
    ['Emily','Cooper','Female','2011-08-23','200 Free',143.20],
    ['Jack','Evans','Male','2010-10-12','100 Fly',65.70],
    ['Chloe','Richardson','Female','2012-02-21','100 Breast',82.10],
    ['Henry','Bailey','Male','2011-05-29','200 IM',143.70],
  ],
  [`${PREFIX}development`]: [
    ['Lily','Scott','Female','2013-05-12','100 Free',76.30],
    ['Thomas','Green','Male','2013-01-19','100 Back',80.40],
    ['Ella','Adams','Female','2014-03-03','100 Free',79.80],
    ['James','Baker','Male','2013-08-28','100 Breast',91.20],
    ['Freya','Nelson','Female','2014-02-16','50 Free',35.70],
    ['William','King','Male','2013-11-06','100 Free',74.90],
  ],
};

function buildSwimmers() {
  const rows = [];
  for (const squad of squadDefinitions) {
    swimmerNames[squad.id].forEach((entry, index) => {
      const [firstName,lastName,gender,dob,mainEvent,baseline100] = entry;
      const id = `${PREFIX}swimmer_${squad.code.toLowerCase().replace(/[^a-z0-9]+/g,'_')}_${index + 1}`;
      const height = squad.id.endsWith('perf_a') ? 170 + index * 1.7 : squad.id.endsWith('perf_b') ? 163 + index * 1.6 : 150 + index * 1.4;
      rows.push({
        id, firstName, lastName, name: `${firstName} ${lastName}`, fullName: `${firstName} ${lastName}`,
        gender, dob, active: true, currentSquadId: squad.id, squadId: squad.id,
        mainEvent, pathway: 'club', status: 'Active',
        physicalMeasurements: squad.id.endsWith('perf_a') ? [
          { id: `${id}_measure_1`, date: '2026-09-01', heightCm: Number(height.toFixed(1)), weightKg: Number((55 + index * 2.1).toFixed(1)), armSpanCm: Number((height + 2.2).toFixed(1)), sittingHeightCm: Number((height * 0.52).toFixed(1)) },
          { id: `${id}_measure_2`, date: '2026-10-05', heightCm: Number((height + (index < 4 ? 0.4 : 0.2)).toFixed(1)), weightKg: Number((55.5 + index * 2.1).toFixed(1)), armSpanCm: Number((height + 2.5).toFixed(1)), sittingHeightCm: Number((height * 0.52 + 0.2).toFixed(1)) },
        ] : [],
        demoBaseline100: baseline100,
        ...ownerScope, createdAt: CREATED_AT, updatedAt: CREATED_AT,
      });
    });
  }
  return rows;
}

function buildSquads(swimmers) {
  return squadDefinitions.map((squad, index) => ({
    ...squad,
    coachIds: index === 0 ? [coachDefinitions[0].id, coachDefinitions[1].id] : index === 1 ? [coachDefinitions[1].id] : [coachDefinitions[2].id],
    swimmerIds: swimmers.filter((row) => row.currentSquadId === squad.id).map((row) => row.id),
    ...ownerScope, createdAt: CREATED_AT, updatedAt: CREATED_AT,
  }));
}

function phaseForWeek(index) {
  if (index === 0) return { phase: 'INTRO', block: 'INTRO — Week 1/1' };
  if (index <= 4) return { phase: 'AEROBIC', block: `AEROBIC — Block 1 — Week ${index}/4` };
  if (index <= 8) return { phase: 'SPECIFIC', block: `SPECIFIC — Block 1 — Week ${index - 4}/4` };
  return { phase: 'TAPER', block: `TAPER — Week ${index - 8}/3` };
}

function buildPlannerWeeks() {
  return Array.from({ length: 12 }, (_, index) => {
    const weekStart = addDays('2026-08-31', index * 7);
    const phase = phaseForWeek(index);
    return {
      id: `${PREFIX}planner_week_${index + 1}`, squadId: squadDefinitions[0].id, weekStart, weekStartKey: weekStart,
      phase: phase.phase, cyclePhase: phase.phase, automaticCycleBlock: phase.block, cycleBlock: phase.block,
      plannedVolume: index === 0 ? 20800 : index <= 4 ? 27200 : index <= 8 ? 24800 : 17200,
      targetCompetition: index >= 8 ? 'AthlyraX Autumn Target Meet' : '',
      ...ownerScope, createdAt: iso(weekStart), updatedAt: iso(weekStart),
    };
  });
}

function buildTimetable() {
  const ttId = `${PREFIX}timetable_main`;
  const venues = [
    { id: `${PREFIX}venue_main`, name: 'AthlyraX Performance Pool', code: 'APP', city: 'Demo City', active: true, ...ownerScope },
    { id: `${PREFIX}venue_secondary`, name: 'AthlyraX Training Pool', code: 'ATP', city: 'Demo City', active: true, ...ownerScope },
  ];
  const slots = [
    ['Monday','06:00','07:30',0,0],['Tuesday','18:00','20:00',0,1],['Thursday','18:00','20:00',0,0],['Saturday','07:00','09:00',0,1],
    ['Monday','18:00','19:30',1,1],['Wednesday','18:00','19:30',1,1],['Friday','18:00','19:30',1,1],
    ['Tuesday','17:00','18:15',2,2],['Thursday','17:00','18:15',2,2],['Saturday','09:15','10:30',2,2],
  ].map((row,index) => {
    const [dayLabel,startTime,endTime,squadIndex,coachIndex] = row;
    return {
      id: `${PREFIX}slot_${index + 1}`, timetableId: ttId, name: `${squadDefinitions[squadIndex].name} ${dayLabel}`,
      dayLabel, day: dayLabel, startTime, endTime, squadId: squadDefinitions[squadIndex].id, squadIds: [squadDefinitions[squadIndex].id],
      coachId: coachDefinitions[coachIndex].id, coachIds: [coachDefinitions[coachIndex].id],
      venueId: venues[squadIndex === 2 ? 1 : 0].id, sessionTypeId: 'stype_swim', active: true,
      ...ownerScope,
    };
  });
  return {
    timetables: [{ id: ttId, name: 'Demo Club Main Timetable', description: 'Three-squad demonstration timetable', active: true, ...ownerScope }],
    timetableSlots: slots,
    venues,
    sessionTypes: [{ id: 'stype_swim', name: 'Swim' }, { id: 'stype_land', name: 'Land' }],
  };
}

function sessionSetResults(swimmers, weekIndex, sessionIndex) {
  const result = {};
  swimmers.forEach((swimmer, swimmerIndex) => {
    const base = Number(swimmer.demoBaseline100 || 62);
    const adaptation = Math.min(2.8, weekIndex * 0.22);
    const fatigue = sessionIndex === 3 ? 0.7 : 0;
    const first = base + 4.5 - adaptation + swimmerIndex * 0.08 + fatigue;
    result[swimmer.id] = {
      reps: Array.from({ length: 6 }, (_, rep) => ({
        rep: rep + 1,
        time: secToTime(first + rep * (0.22 + swimmerIndex * 0.015)),
        strokeCount: 34 + swimmerIndex + Math.floor(rep / 2),
      })),
      overallTime: secToTime(first),
      overallStrokeCount: 35 + swimmerIndex,
    };
  });
  return result;
}

function buildSessions(mainSwimmers) {
  const schedule = [];
  const trainingSessions = [];
  const trainingSessionSets = [];
  const attendance = [];
  const start = '2026-08-31';

  for (let week = 0; week < 12; week += 1) {
    const phase = phaseForWeek(week);
    const mainOffsets = [0,1,3,5];
    mainOffsets.forEach((offset, sessionIndex) => {
      const date = addDays(start, week * 7 + offset);
      const scheduleId = `${PREFIX}schedule_perf_a_w${week + 1}_s${sessionIndex + 1}`;
      const sessionId = `${PREFIX}session_perf_a_w${week + 1}_s${sessionIndex + 1}`;
      const plannedVolume = phase.phase === 'INTRO' ? 5200 : phase.phase === 'AEROBIC' ? 6800 : phase.phase === 'SPECIFIC' ? 6200 : 4300;
      schedule.push({
        id: scheduleId, scheduleDate: date, date, startTime: sessionIndex === 0 ? '06:00' : sessionIndex === 3 ? '07:00' : '18:00',
        endTime: sessionIndex === 0 ? '07:30' : sessionIndex === 3 ? '09:00' : '20:00',
        venueId: `${PREFIX}venue_main`, coachIds: sessionIndex % 2 ? [coachDefinitions[1].id] : [coachDefinitions[0].id],
        squadIds: [squadDefinitions[0].id], squadNames: [squadDefinitions[0].name], timetableId: `${PREFIX}timetable_main`,
        source: 'Main', status: date <= '2026-10-09' ? 'Completed' : 'Planned', sessionTypeId: 'stype_swim', trainingSessionId: sessionId,
        phase: phase.phase, cyclePhase: phase.phase, automaticCycleBlock: phase.block,
        ...ownerScope, createdAt: iso(date), updatedAt: iso(date),
      });
      trainingSessions.push({
        id: sessionId, scheduleId, scheduleDate: date, date, squadIds: [squadDefinitions[0].id],
        swimmerIds: mainSwimmers.map((row) => row.id), timetable: 'Demo Club Main Timetable',
        mainFocus: phase.phase === 'AEROBIC' ? 'Aerobic Capacity' : phase.phase === 'SPECIFIC' ? 'Race Specific' : phase.phase === 'TAPER' ? 'Quality / Race Pace' : 'Technical Control',
        secondaryFocus: sessionIndex % 2 ? 'Skills' : 'Efficiency', phase: phase.phase, cyclePhase: phase.phase,
        status: date <= '2026-10-09' ? 'Completed' : 'Planned', totalVolume: plannedVolume, totalTime: 110,
        notes: `${phase.block} · connected demonstration session`, ...ownerScope, createdAt: iso(date), updatedAt: iso(date),
      });

      const resultMap = sessionSetResults(mainSwimmers, week, sessionIndex);
      const setTemplates = phase.phase === 'INTRO'
        ? [
          { suffix: 'warm', setName: '12x100 Aerobic Warm Up', reps: 12, distance: 100, stroke: 'Free', energy: 'EN1', setType: 'main' },
          { suffix: 'main', setName: '20x100 Technical Aerobic', reps: 20, distance: 100, stroke: 'Free', energy: 'EN2', setType: 'main' },
          { suffix: 'skill', setName: '12x100 Skill Transfer', reps: 12, distance: 100, stroke: 'Choice', energy: 'EN1', setType: 'main' },
          { suffix: 'kick', setName: '8x50 Kick / Skills', reps: 8, distance: 50, stroke: 'Choice', energy: 'EN2', setType: 'main' },
          { suffix: 'speed', setName: '16x25 Speed Skills', reps: 16, distance: 25, stroke: 'Free', energy: 'SP', setType: 'main' },
        ]
        : phase.phase === 'AEROBIC'
        ? [
          { suffix: 'warm', setName: '12x100 EN1 Build', reps: 12, distance: 100, stroke: 'Free', energy: 'EN1', setType: 'main' },
          { suffix: 'main', setName: '32x100 Aerobic Capacity', reps: 32, distance: 100, stroke: 'Free', energy: 'EN2', setType: 'main' },
          { suffix: 'threshold', setName: '16x100 Threshold Control', reps: 16, distance: 100, stroke: 'Free', energy: 'EN3', setType: 'main' },
          { suffix: 'skill', setName: '8x50 Technical Control', reps: 8, distance: 50, stroke: 'Choice', energy: 'EN1', setType: 'main' },
          { suffix: 'speed', setName: '16x25 Speed Maintenance', reps: 16, distance: 25, stroke: 'Free', energy: 'SP', setType: 'main' },
        ]
        : phase.phase === 'SPECIFIC'
        ? [
          { suffix: 'warm', setName: '10x100 EN1 Preparation', reps: 10, distance: 100, stroke: 'Free', energy: 'EN1', setType: 'main' },
          { suffix: 'main', setName: '28x100 Race Specific Aerobic', reps: 28, distance: 100, stroke: 'Free', energy: 'EN3', setType: 'main' },
          { suffix: 'pace', setName: '14x100 Race Pace', reps: 14, distance: 100, stroke: 'Free', energy: 'EN3', setType: 'main' },
          { suffix: 'power', setName: '12x50 Power / Breakout', reps: 12, distance: 50, stroke: 'Choice', energy: 'LP', setType: 'main' },
          { suffix: 'speed', setName: '16x25 Speed Expression', reps: 16, distance: 25, stroke: 'Free', energy: 'SP', setType: 'main' },
        ]
        : [
          { suffix: 'warm', setName: '8x100 EN1 Preparation', reps: 8, distance: 100, stroke: 'Free', energy: 'EN1', setType: 'main' },
          { suffix: 'pace', setName: '18x100 Race Pace Quality', reps: 18, distance: 100, stroke: 'Free', energy: 'EN3', setType: 'main' },
          { suffix: 'easy', setName: '8x100 Recovery Control', reps: 8, distance: 100, stroke: 'Choice', energy: 'EN1', setType: 'main' },
          { suffix: 'power', setName: '10x50 Power', reps: 10, distance: 50, stroke: 'Choice', energy: 'LP', setType: 'main' },
          { suffix: 'speed', setName: '16x25 Speed Expression', reps: 16, distance: 25, stroke: 'Free', energy: 'SP', setType: 'main' },
        ];
      if (date === '2026-09-05' || date === '2026-10-03') {
        trainingSessionSets.push({
          id: `${PREFIX}set_w${week + 1}_s${sessionIndex + 1}_test_battery`,
          sessionId, trainingSessionId: sessionId,
          scheduleId, trainingScheduleId: scheduleId,
          squadId: squadDefinitions[0].id, squadIds: [squadDefinitions[0].id],
          setName: date === '2026-09-05' ? 'Start-of-cycle Test Battery' : 'Specific-phase Retest Battery',
          description: 'Canonical AthlyraX test battery marker linked to recorded test results',
          setType: 'test', isTestSet: true, isTest: true,
          phase: phase.phase, stroke: 'Free', modality: 'Swim', rounds: 1, reps: 0, distance: 0,
          plannedVolume: 0, totalVolume: 0, setTimeSeconds: 0, totalTimeSec: 0,
          scheduleDate: date, date, energy: '', energySystem: '',
          resultsBySwimmer: {},
          ...ownerScope, createdAt: iso(date), updatedAt: iso(date),
        });
      }

      setTemplates.forEach((set, setIndex) => {
        trainingSessionSets.push({
          id: `${PREFIX}set_w${week + 1}_s${sessionIndex + 1}_${set.suffix}`, sessionId, trainingSessionId: sessionId,
          scheduleId, trainingScheduleId: scheduleId, squadId: squadDefinitions[0].id, squadIds: [squadDefinitions[0].id],
          setName: set.setName, description: `${phase.phase} demonstration evidence`, setType: set.setType, isTestSet: false,
          phase: phase.phase, stroke: set.stroke, modality: 'Swim', rounds: 1, reps: set.reps, distance: set.distance,
          setTimeSeconds: setIndex === 1 ? 105 : setIndex === 2 ? 45 : 60, totalTimeSec: set.reps * (setIndex === 1 ? 105 : setIndex === 2 ? 45 : 60),
          scheduleDate: date, date, energy: set.energy, energySystem: set.energy,
          resultsBySwimmer: date <= '2026-10-09' && setIndex === 1 ? resultMap : {},
          ...ownerScope, createdAt: iso(date), updatedAt: iso(date),
        });
      });

      mainSwimmers.forEach((swimmer, swimmerIndex) => {
        const isShowcaseSwimmer = String(swimmer?.firstName || '').trim() === 'Amelia' && String(swimmer?.lastName || '').trim() === 'Foster';
        if (date > '2026-10-09' && !isShowcaseSwimmer) return;
        const missed = !isShowcaseSwimmer && (
          (week === 1 && swimmerIndex === 1 && sessionIndex === 2)
          || (week === 2 && swimmerIndex === 3 && sessionIndex === 0)
          || (week === 3 && swimmerIndex === 2 && sessionIndex === 1)
          || (week === 4 && swimmerIndex === 0 && sessionIndex === 3)
          || (week === 5 && swimmerIndex === 5 && sessionIndex === 3)
        );
        const partial = !isShowcaseSwimmer && (
          (week === 2 && swimmerIndex === 6 && sessionIndex === 1)
          || (week === 4 && swimmerIndex === 6 && sessionIndex === 2)
          || (week === 5 && swimmerIndex === 7 && sessionIndex === 0)
        );
        attendance.push({
          id: `${PREFIX}att_w${week + 1}_s${sessionIndex + 1}_${swimmerIndex + 1}`, swimmerId: swimmer.id, scheduleId, sessionId,
          status: missed ? 'Absent' : partial ? 'Partial' : 'Present', present: !missed, attended: !missed,
          volumeSwam: missed ? 0 : partial ? Math.round(plannedVolume * 0.62) : isShowcaseSwimmer ? plannedVolume : Math.max(0, plannedVolume - (((swimmerIndex + week + sessionIndex) % 5) * 150)),
          volumeTotal: plannedVolume, date, notes: missed ? 'Demo absence' : partial ? 'Left early — demo variation' : '',
          ...ownerScope, createdAt: iso(date), updatedAt: iso(date),
        });
      });
    });
  }

  const secondary = [
    { squad: squadDefinitions[1], coach: coachDefinitions[1], offsets: [0,2,4], start: '18:00', end: '19:30' },
    { squad: squadDefinitions[2], coach: coachDefinitions[2], offsets: [1,3,5], start: '17:00', end: '18:15' },
  ];
  secondary.forEach((group) => {
    for (let week = 0; week < 12; week += 1) {
      group.offsets.forEach((offset, index) => {
        const date = addDays(start, week * 7 + offset);
        const slug = group.squad.code.toLowerCase().replace(/[^a-z0-9]/g,'');
        const scheduleId = `${PREFIX}schedule_${slug}_w${week + 1}_s${index + 1}`;
        const sessionId = `${PREFIX}session_${slug}_w${week + 1}_s${index + 1}`;
        schedule.push({
          id: scheduleId, scheduleDate: date, date, startTime: group.start, endTime: group.end,
          venueId: group.squad.id.endsWith('development') ? `${PREFIX}venue_secondary` : `${PREFIX}venue_main`,
          coachIds: [group.coach.id], squadIds: [group.squad.id], squadNames: [group.squad.name], timetableId: `${PREFIX}timetable_main`,
          source: 'Main', status: date <= '2026-10-09' ? 'Completed' : 'Planned', sessionTypeId: 'stype_swim', trainingSessionId: sessionId,
          ...ownerScope, createdAt: iso(date), updatedAt: iso(date),
        });
        trainingSessions.push({
          id: sessionId, scheduleId, scheduleDate: date, date, squadIds: [group.squad.id],
          mainFocus: group.squad.id.endsWith('development') ? 'Skills & Technique' : 'Aerobic Development',
          status: date <= '2026-10-09' ? 'Completed' : 'Planned', totalVolume: group.squad.id.endsWith('development') ? 3200 : 4800,
          totalTime: 85, notes: 'Demo club scheduled session', ...ownerScope, createdAt: iso(date), updatedAt: iso(date),
        });
      });
    }
  });

  return { schedule, trainingSessions, trainingSessionSets, attendance };
}

function buildTests(mainSwimmers) {
  const testDates = ['2026-09-05','2026-10-03'];
  const rows = [];
  mainSwimmers.forEach((swimmer, swimmerIndex) => {
    testDates.forEach((date, blockIndex) => {
      const improvement = blockIndex * (0.7 + swimmerIndex * 0.04);
      const base = Number(swimmer.demoBaseline100);
      const specs = [
        { testName:'M25 · 1x25 Max Effort', templateId:'builtin-test-max', templateName:'Max', testType:'Max Test', distance:25, reps:1, seconds:Math.max(11.4, base * 0.215 - improvement * 0.12) },
        { testName:'M50 · 1x50 Max Effort', templateId:'builtin-test-max', templateName:'Max', testType:'Max Test', distance:50, reps:1, seconds:Math.max(23.8, base * 0.47 - improvement * 0.30) },
        { testName:'M100 · 1x100 Max Effort', templateId:'builtin-test-max', templateName:'Max', testType:'Max Test', distance:100, reps:1, seconds:base - improvement },
        { testName:'M200 · 1x200 Max Effort', templateId:'builtin-test-max', templateName:'Max', testType:'Max Test', distance:200, reps:1, seconds:base * 2.12 - improvement * 1.7 },
        { testName:'M400 · 1x400 Max Effort', templateId:'builtin-test-max', templateName:'Max', testType:'Max Test', distance:400, reps:1, seconds:base * 4.45 - improvement * 3.0 },
        { testName:'8x25 Repeatability', templateId:'builtin-test-repeatability', templateName:'Repeatability', testType:'Repeatability Test', distance:25, reps:8, seconds:Math.max(12.0, base * 0.23 - improvement * 0.10) },
        { testName:'8x50 Repeatability', templateId:'builtin-test-repeatability', templateName:'Repeatability', testType:'Repeatability Test', distance:50, reps:8, seconds:Math.max(27.0, base * 0.51 - improvement * 0.24) },
        { testName:'8x100 Repeatability', templateId:'builtin-test-repeatability', templateName:'Repeatability', testType:'Repeatability Test', distance:100, reps:8, seconds:base + 4.2 - improvement * 0.55 },
        { testName:'5x400 Aerobic / Durability Check', templateId:'builtin-test-aerobic-durability', templateName:'Aerobic / Durability Check', testType:'Aerobic / Durability Check', distance:400, reps:5, seconds:base * 4.62 - improvement * 2.2 },
      ];
      specs.forEach((spec, testIndex) => {
        const plannerWeek = blockIndex === 0 ? 1 : 5;
        const linkedScheduleId = `${PREFIX}schedule_perf_a_w${plannerWeek}_s4`;
        const linkedSessionId = `${PREFIX}session_perf_a_w${plannerWeek}_s4`;
        const repCount = Math.max(1, Number(spec.reps || 1));
        const repDrift = spec.templateName === 'Repeatability'
          ? (0.18 + swimmerIndex * 0.01)
          : (spec.templateName === 'Aerobic / Durability Check' ? (0.75 + swimmerIndex * 0.04) : 0);
        const repResults = Array.from({ length: repCount }, (_, rep) => ({
          rep: rep + 1,
          overallTime: secToTime(spec.seconds + rep * repDrift),
          overallStrokeCount: Math.max(12, Math.round((spec.distance / 25) * (8.5 + swimmerIndex * 0.22) + (rep > 0 ? Math.floor(rep / 2) : 0))),
        }));
        rows.push({
          id: `${PREFIX}test_${swimmerIndex + 1}_${blockIndex + 1}_${testIndex + 1}`,
          swimmerId: swimmer.id,
          swimmerName: swimmer.name || swimmer.fullName || [swimmer.firstName, swimmer.lastName].filter(Boolean).join(' '),
          squadId: squadDefinitions[0].id,
          squadIds: [squadDefinitions[0].id],
          scheduleId: linkedScheduleId,
          trainingScheduleId: linkedScheduleId,
          sessionId: linkedSessionId,
          trainingSessionId: linkedSessionId,
          date,
          category: 'Swimming',
          templateId: spec.templateId,
          templateName: spec.templateName,
          testType: spec.testType,
          testName: spec.testName,
          metric: spec.testName,
          distance: spec.distance,
          plannedReps: repCount,
          resultTime: secToTime(spec.seconds),
          resultValue: secToTime(spec.seconds),
          resultUnit: 'time',
          repResults,
          attendeeIds: [swimmer.id],
          notes: blockIndex === 0 ? 'Start-of-cycle benchmark' : 'Specific-phase retest',
          ...ownerScope,
          createdAt: iso(date),
          updatedAt: iso(date),
        });
      });
    });
  });
  return rows;
}

function buildCompetitions(mainSwimmers) {
  const meets = [
    { id:'benchmark', name:'Early Season Benchmark Meet', date:'2026-09-13', delta:0.15, main:false },
    { id:'prep', name:'Autumn Preparation Meet', date:'2026-10-04', delta:-0.65, main:false },
    { id:'target', name:'AthlyraX Autumn Target Meet', date:'2026-11-15', delta:-1.25, main:true },
  ];
  return meets.map((meet, meetIndex) => {
    const events = [
      { id: `${PREFIX}event_${meet.id}_100free`, event: '100 Free', eventLabel: '100 Free', distance: 100, stroke: 'Free' },
      { id: `${PREFIX}event_${meet.id}_50free`, event: '50 Free', eventLabel: '50 Free', distance: 50, stroke: 'Free' },
    ].map((event, eventIndex) => {
      const resultsBySwimmer = {};
      mainSwimmers.forEach((swimmer, swimmerIndex) => {
        const base100 = Number(swimmer.demoBaseline100);
        const variation = swimmerIndex === 4 && meetIndex === 1 ? 0.75 : swimmerIndex === 6 ? 0.25 : 0;
        const seconds = event.distance === 100
          ? base100 + meet.delta + variation
          : base100 * 0.47 + meet.delta * 0.38 + variation * 0.25;
        const firstHalf = event.distance === 100 ? seconds * 0.485 : seconds;
        const resultTime = secToTime(seconds);
        resultsBySwimmer[swimmer.id] = {
          time: resultTime, result: resultTime, resultTime, resultValue: resultTime,
          pb: meetIndex > 0 && seconds < (event.distance === 100 ? base100 : base100 * 0.47),
          rank: String(1 + ((swimmerIndex + eventIndex + meetIndex) % 6)),
          splits: event.distance === 100 ? [secToTime(firstHalf), secToTime(seconds)] : [secToTime(seconds)],
          segmentTimes: event.distance === 100 ? [secToTime(firstHalf), secToTime(seconds - firstHalf)] : [secToTime(seconds)],
          strokeCount: event.distance === 100 ? 76 + swimmerIndex * 2 : 36 + swimmerIndex,
          strokeRate: 44 + swimmerIndex,
          breakoutTime: event.distance === 100 ? 5.9 + swimmerIndex * 0.05 : 5.7 + swimmerIndex * 0.04,
          breakoutDistance: 11.5 + (swimmerIndex % 3) * 0.4,
          observations: meetIndex === 0 ? 'Benchmark execution.' : meetIndex === 1 ? 'Improved middle-race control.' : 'Target-meet expression.',
        };
      });
      return { ...event, date: meet.date, attendeeIds: mainSwimmers.map((row) => row.id), resultsBySwimmer };
    });
    return {
      id: `${PREFIX}fixture_${meet.id}`, name: meet.name, startDate: meet.date, endDate: meet.date,
      competitionType: 'Competition', venue: 'Regional Aquatics Centre', startTime: '09:00', endTime: '18:00',
      isMainEvent: meet.main, targetCompetition: meet.main, squadIds: [squadDefinitions[0].id],
      coachIds: [coachDefinitions[0].id, coachDefinitions[1].id], attendeeIds: mainSwimmers.map((row) => row.id),
      events, galaEvents: [], notes: meet.main ? 'Primary target competition for the demo cycle.' : 'Development competition evidence.',
      ...ownerScope, createdAt: iso(meet.date), updatedAt: iso(meet.date),
    };
  });
}

function buildCoachEvidence(mainSwimmers) {
  const observations = [];
  const analyses = [];
  mainSwimmers.forEach((swimmer, index) => {
    observations.push(
      {
        id: `${PREFIX}obs_${index + 1}_1`, swimmerId: swimmer.id, squadId: squadDefinitions[0].id, date: '2026-09-07',
        focus: 'Technical Control', rating: 3 + (index % 2), notes: index % 3 === 0 ? 'Good line and timing; loses length under fatigue.' : 'Stable mechanics with scope to improve breakout-to-stroke transition.',
        coachId: coachDefinitions[0].id, ...ownerScope, createdAt: iso('2026-09-07'), updatedAt: iso('2026-09-07'),
      },
      {
        id: `${PREFIX}obs_${index + 1}_2`, swimmerId: swimmer.id, squadId: squadDefinitions[0].id, date: '2026-10-05',
        focus: 'Race Specific', rating: 4, notes: index === 4 ? 'Training progress is stronger than latest race conversion; retain race execution focus.' : 'Improved repeatability and pace control visible in specific work.',
        coachId: coachDefinitions[1].id, ...ownerScope, createdAt: iso('2026-10-05'), updatedAt: iso('2026-10-05'),
      },
    );
    analyses.push({
      id: `${PREFIX}analysis_${index + 1}`, swimmerId: swimmer.id, squadId: squadDefinitions[0].id, reviewDate: '2026-10-06',
      strengths: index % 2 ? 'Aerobic stability; technical repeatability' : 'Speed expression; race-specific control',
      limitations: index === 4 ? 'Competition conversion under pressure' : index % 3 === 0 ? 'Efficiency late in longer sets' : 'Breakout consistency',
      shortTermGoal: 'Hold technical quality through the final third of race-specific work.',
      mediumTermGoal: 'Convert training/test progress into target-meet performance.',
      longTermGoal: 'Sustain year-on-year development across training, testing and competition.',
      confidenceLevel: 'Good', currentPhase: 'SPECIFIC', reviewer: coachDefinitions[0].name, reviewStatus: 'Reviewed',
      coachNarrativeSummary: index === 4
        ? 'Training and testing evidence are improving, but competition expression is lagging. Maintain capability work and sharpen race execution.'
        : 'Training, test and competition evidence are moving in the same direction. Continue current progression with targeted technical detail.',
      ...ownerScope, createdAt: iso('2026-10-06'), updatedAt: iso('2026-10-06'),
    });
  });
  return { coachObservations: observations, swimmerAnalyses: analyses };
}

export function buildDemoTenantSeed() {
  const swimmers = buildSwimmers();
  const squads = buildSquads(swimmers);
  const mainSwimmers = swimmers.filter((row) => row.currentSquadId === squadDefinitions[0].id);
  const timetable = buildTimetable();
  const sessions = buildSessions(mainSwimmers);
  const evidence = buildCoachEvidence(mainSwimmers);
  return {
    __meta: {
      tenantId: TENANT_ID,
      tenant: TENANT_ID,
      primaryAccount: ACCOUNT_SCOPE,
      owner: ACCOUNT_SCOPE,
      demoSeed: { version: 2, tenantId: TENANT_ID, generatedAt: '2026-10-09T14:30:00.000Z', prefix: PREFIX },
      updatedAt: '2026-10-09T11:45:00.000Z',
    },
    squads,
    coaches: coachDefinitions.map((row) => ({ ...row, ...ownerScope, createdAt: CREATED_AT, updatedAt: CREATED_AT })),
    swimmers,
    venues: timetable.venues,
    sessionTypes: timetable.sessionTypes,
    timetables: timetable.timetables,
    timetableSlots: timetable.timetableSlots,
    seasons: [
      { id: `${PREFIX}season_2025`, year: 2025, label: '2025/26', name: '2025/26', startDate: '2025-09-01', endDate: '2026-08-31', ...ownerScope },
      { id: `${PREFIX}season_2026`, year: 2026, label: '2026/27', name: '2026/27', startDate: '2026-09-01', endDate: '2027-08-31', ...ownerScope },
    ],
    trainingPlannerWeeks: buildPlannerWeeks(),
    schedule: sessions.schedule,
    trainingSessions: sessions.trainingSessions,
    trainingSessionSets: sessions.trainingSessionSets,
    attendance: sessions.attendance,
    tests: buildTests(mainSwimmers),
    fixtures: buildCompetitions(mainSwimmers),
    coachObservations: evidence.coachObservations,
    swimmerAnalyses: evidence.swimmerAnalyses,
  };
}

const COLLECTION_KEYS = [
  'squads','coaches','swimmers','venues','sessionTypes','timetables','timetableSlots','seasons','trainingPlannerWeeks',
  'schedule','trainingSessions','trainingSessionSets','attendance','tests','fixtures','coachObservations','swimmerAnalyses',
];

const isDemoSeedRow = (row) => String(row?.id || '').startsWith(PREFIX);

export function mergeDemoTenantSeed(currentDb = {}) {
  const seed = buildDemoTenantSeed();
  const next = { ...(currentDb && typeof currentDb === 'object' ? currentDb : {}) };
  for (const key of COLLECTION_KEYS) {
    const preserved = asArray(next[key]).filter((row) => !isDemoSeedRow(row));
    next[key] = [...preserved, ...asArray(seed[key])];
  }
  next.__meta = {
    ...(next.__meta || {}),
    ...(seed.__meta || {}),
    demoSeed: seed.__meta.demoSeed,
  };
  return next;
}

export function demoSeedSummary(db = buildDemoTenantSeed()) {
  const perfA = db.squads.find((row) => row.id === `${PREFIX}perf_a`);
  return {
    tenantId: db.__meta?.tenantId,
    squads: asArray(db.squads).length,
    coaches: asArray(db.coaches).length,
    swimmers: asArray(db.swimmers).length,
    timetableSlots: asArray(db.timetableSlots).length,
    schedule: asArray(db.schedule).length,
    trainingSessions: asArray(db.trainingSessions).length,
    trainingSessionSets: asArray(db.trainingSessionSets).length,
    attendance: asArray(db.attendance).length,
    tests: asArray(db.tests).length,
    fixtures: asArray(db.fixtures).length,
    coachObservations: asArray(db.coachObservations).length,
    mainSquadSwimmers: asArray(perfA?.swimmerIds).length,
  };
}

function cli() {
  const writeIndex = process.argv.indexOf('--write');
  if (writeIndex < 0) return false;
  const targetArg = process.argv[writeIndex + 1];
  if (!targetArg) throw new Error('Usage: node scripts/build-demo-tenant-dataset.mjs --write <db.json>');
  const targetPath = path.resolve(process.cwd(), targetArg);
  const currentDb = fs.existsSync(targetPath) ? JSON.parse(fs.readFileSync(targetPath, 'utf8')) : {};
  const merged = mergeDemoTenantSeed(currentDb);
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  const backupPath = fs.existsSync(targetPath) ? `${targetPath}.before-demo-seed-${Date.now()}.bak` : '';
  if (backupPath) fs.copyFileSync(targetPath, backupPath);
  const tmp = `${targetPath}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(merged, null, 2)}\n`);
  fs.renameSync(tmp, targetPath);
  process.stdout.write(`${JSON.stringify({ ok: true, targetPath, backupPath, summary: demoSeedSummary(merged) }, null, 2)}\n`);
  return true;
}

cli();
