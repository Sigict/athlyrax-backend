// Vendored from Sigict/athlyrax-v6-private src/utils/testTemplateCatalog.js @ 00008432 (no changes).
export function buildFixedTestTemplateRows() {
  return [
    { id: 'max-25', category: 'max', label: 'M25 · 1x25 Max Effort', reps: 1, distance: 25, sendOff: '1:30', stroke: 'free', recurrenceEveryWeeks: 4, guidance: 'Start from water. Maximum or near-maximum effort. Collect splits and stroke information where practical.' },
    { id: 'max-50', category: 'max', label: 'M50 · 1x50 Max Effort', reps: 1, distance: 50, sendOff: '3:00', stroke: 'free', recurrenceEveryWeeks: 4, guidance: 'Start from water. Maximum or near-maximum effort. Collect splits and stroke information where practical.' },
    { id: 'max-100', category: 'max', label: 'M100 · 1x100 Max Effort', reps: 1, distance: 100, sendOff: '5:00', stroke: 'free', recurrenceEveryWeeks: 4, guidance: 'Maximum or near-maximum effort with pacing and technical context recorded.' },
    { id: 'max-200', category: 'max', label: 'M200 · 1x200 Max Effort', reps: 1, distance: 200, sendOff: '8:00', stroke: 'free', recurrenceEveryWeeks: 4, guidance: 'Maximum or near-maximum 200m effort. Record splits, rhythm and technical control.' },
    { id: 'max-400', category: 'max', label: 'M400 · 1x400 Max Effort', reps: 1, distance: 400, sendOff: '12:00', stroke: 'free', recurrenceEveryWeeks: 4, guidance: 'Maximum or near-maximum 400m effort. Record pacing, stroke control and aerobic organisation.' },
    { id: 'rep-25', category: 'repeat', label: '8x25 Repeatability', reps: 8, distance: 25, sendOff: '0:30', stroke: 'free', recurrenceEveryWeeks: 4, guidance: 'Repeatability set. Adjust send-off as needed.' },
    { id: 'rep-50', category: 'repeat', label: '8x50 Repeatability', reps: 8, distance: 50, sendOff: '1:00', stroke: 'free', recurrenceEveryWeeks: 4, guidance: 'Repeatability set. Adjust send-off as needed.' },
    { id: 'rep-100', category: 'repeat', label: '8x100 Repeatability', reps: 8, distance: 100, sendOff: '1:30', stroke: 'free', recurrenceEveryWeeks: 4, guidance: 'Repeatability set. Adjust send-off as needed.' },
  ].map((row) => ({ ...row, checked: false }));
}


const TECHNICAL_OBSERVATION = (key, label, options, group) => ([
  { key: key + '_observation', label: label + ' · Observation', inputType: 'select', options, group },
  { key: key + '_rating', label: label + ' · Rating', inputType: 'select', options: ['1','2','3','4','5'], group },
  { key: key + '_note', label: label + ' · Note', inputType: 'textarea', group },
]);

const TECHNICAL_COMMON = {
  bodyPosition: [
    ['head_position','Head position',['Neutral','Raised','Lowered','Variable']],
    ['hip_position','Hip position',['High','Neutral','Low','Variable']],
    ['alignment','Alignment',['Centred','Lateral movement','Asymmetric','Variable']],
  ],
};

function technicalTemplate({ name, stroke, rows }) {
  return {
    name,
    testFamily: 'technical',
    description: stroke ? stroke + ' technical assessment' : 'Swimming technical assessment',
    notes: 'Coach-observed technique. Observation is descriptive; rating is a separate 1–5 judgement. Each item also has its own note.',
    setType: 'test',
    isTestSet: true,
    testCategory: 'Technical Analysis',
    resultType: 'Rating',
    resultUnit: '1-5',
    resultFields: rows.flatMap(row => row.resultFields),
    rows: rows.map((row,index)=>({
      order:index+1, phase:'Assessment', rounds:1, reps:1, distance:0, stroke:stroke || '',
      description:row.label, label:row.label, assessmentGroup:row.group,
      rest:'0:00', sendOff:'0:00', energy:'N/A', modality:'Technical',
      setType:'test', isTestSet:true, testCategory:'Technical Analysis', testFamily:'technical',
      resultType:'Rating', resultUnit:'1-5', resultFields:row.resultFields,
      protocol:'Select the neutral observation, rate 1–5, and add a note where useful.',
    })),
    lineCount: rows.length,
  };
}

function techniqueRows(groups) {
  return groups.flatMap(([group, items]) => items.map(([key,label,options]) => ({
    group, label, resultFields: TECHNICAL_OBSERVATION(key,label,options,group),
  })));
}

function canonicalTechnicalTemplates() {
  const freestyle = techniqueRows([
    ['Body Position & Alignment', [
      ...TECHNICAL_COMMON.bodyPosition,
      ['body_rotation','Body rotation',['Limited','Moderate','Large','Asymmetric','Variable']],
    ]],
    ['Entry & Catch', [
      ['hand_entry','Hand entry',['In line with shoulder','Narrow','Wide','Crossover','Variable']],
      ['entry_angle','Entry angle',['Flat','Fingertips first','Steep','Variable']],
      ['extension','Extension',['Short','Moderate','Long','Variable']],
      ['catch_timing','Catch timing',['Early','Mid','Late','Variable']],
      ['catch_elbow','Elbow position during catch',['High','Neutral','Dropped','Variable']],
      ['forearm_orientation','Forearm orientation',['Early vertical','Progressive','Shallow','Variable']],
    ]],
    ['Pull & Propulsion', [
      ['pull_path','Pull path',['Relatively straight','Curves inward','Curves outward','Variable']],
      ['pull_depth','Pull depth',['Shallow','Moderate','Deep','Variable']],
      ['finish','Finish',['Short','Around hip','Beyond hip','Variable']],
    ]],
    ['Recovery', [
      ['recovery_path','Recovery path',['Close','Moderate','Wide','Variable']],
      ['recovery_elbow','Recovery elbow',['High','Moderate','Low','Variable']],
      ['recovery_tension','Recovery tension',['Relaxed','Moderate','Tense','Variable']],
    ]],
    ['Kick', [
      ['kick_pattern','Kick pattern',['2-beat','4-beat','6-beat','Variable']],
      ['kick_source','Kick source',['Mainly hip','Mixed hip-knee','Mainly knee','Variable']],
      ['kick_amplitude','Kick amplitude',['Small','Moderate','Large','Variable']],
      ['ankle_position','Ankle position',['Plantar-flexed','Neutral','Limited','Variable']],
      ['kick_symmetry','Kick symmetry',['Balanced','Left dominant','Right dominant','Variable']],
    ]],
    ['Breathing & Coordination', [
      ['breathing_side','Breathing side',['Bilateral','Right','Left','Mixed']],
      ['breathing_frequency','Breathing frequency',['Every 2','Every 3','Every 4','Every 5+','Variable']],
      ['head_movement','Head movement',['Minimal','Moderate','Large','Variable']],
      ['breath_timing','Breath timing',['Early','Mid','Late','Variable']],
      ['arm_coordination','Arm coordination',['Continuous','Catch-up tendency','Overlap tendency','Variable']],
      ['arm_kick_coordination','Arm-kick coordination',['Consistent','Inconsistent','Variable']],
    ]],
    ['Fatigue Response', [
      ['fatigue_stroke_length','Stroke length under fatigue',['Maintained','Reduces','Increases','Variable']],
      ['fatigue_stroke_rate','Stroke rate under fatigue',['Maintained','Increases','Reduces','Variable']],
      ['fatigue_kick','Kick under fatigue',['Maintained','Reduces','Increases','Variable']],
      ['fatigue_body_position','Body position under fatigue',['Maintained','Deteriorates','Variable']],
      ['fatigue_symmetry','Symmetry under fatigue',['Maintained','Deteriorates','Variable']],
    ]],
  ]);

  const backstroke = techniqueRows([
    ['Body Position & Alignment', [
      ['back_head_position','Head position',['Neutral','Raised','Lowered','Variable']],
      ['back_hip_position','Hip position',['High','Neutral','Low','Variable']],
      ['back_body_roll','Body roll',['Limited','Moderate','Large','Asymmetric','Variable']],
      ['back_alignment','Alignment',['Centred','Lateral movement','Asymmetric','Variable']],
    ]],
    ['Entry & Catch', [
      ['back_hand_entry','Hand entry',['In line','Narrow','Wide','Crossover','Variable']],
      ['back_entry_orientation','Hand orientation at entry',['Little finger first','Flat','Thumb first','Variable']],
      ['back_catch_timing','Catch timing',['Early','Mid','Late','Variable']],
      ['back_catch_depth','Catch depth',['Shallow','Moderate','Deep','Variable']],
    ]],
    ['Pull & Propulsion', [
      ['back_pull_path','Pull path',['Consistent','Wide','Crosses body line','Variable']],
      ['back_finish','Finish',['Complete','Short','Variable']],
    ]],
    ['Recovery', [
      ['back_recovery','Recovery',['Straight','Bent','Variable']],
      ['back_recovery_alignment','Recovery alignment',['In line','Wide','Crosses','Variable']],
    ]],
    ['Kick', [
      ['back_kick_pattern','Kick pattern',['Continuous','Reduced','Burst','Variable']],
      ['back_kick_source','Kick source',['Mainly hip','Mixed hip-knee','Mainly knee','Variable']],
      ['back_kick_amplitude','Kick amplitude',['Small','Moderate','Large','Variable']],
      ['back_kick_symmetry','Kick symmetry',['Balanced','Left dominant','Right dominant','Variable']],
    ]],
    ['Timing & Coordination', [
      ['back_arm_timing','Arm timing',['Continuous','Catch-up tendency','Overlap tendency','Variable']],
      ['back_arm_kick','Arm-kick coordination',['Consistent','Inconsistent','Variable']],
      ['back_symmetry','Symmetry',['Balanced','Left dominant','Right dominant','Variable']],
    ]],
    ['Fatigue Response', [
      ['back_fatigue_body','Body position under fatigue',['Maintained','Deteriorates','Variable']],
      ['back_fatigue_rate','Stroke rate under fatigue',['Maintained','Increases','Reduces','Variable']],
      ['back_fatigue_kick','Kick under fatigue',['Maintained','Reduces','Increases','Variable']],
      ['back_fatigue_symmetry','Symmetry under fatigue',['Maintained','Deteriorates','Variable']],
    ]],
  ]);

  const breaststroke = techniqueRows([
    ['Body Position & Line', [
      ['breast_head_position','Head position',['Neutral','Raised','Lowered','Variable']],
      ['breast_body_line','Body line',['Streamlined','Moderate resistance','High resistance','Variable']],
      ['breast_hip_position','Hip position',['High','Neutral','Low','Variable']],
    ]],
    ['Pull', [
      ['breast_hand_entry','Hand/arm entry',['Narrow','Shoulder width','Wide','Variable']],
      ['breast_pull_width','Pull width',['Narrow','Moderate','Wide','Variable']],
      ['breast_pull_depth','Pull depth',['Shallow','Moderate','Deep','Variable']],
      ['breast_elbow_position','Elbow position',['High','Neutral','Dropped','Variable']],
      ['breast_recovery','Arm recovery',['Direct','Wide','Delayed','Variable']],
    ]],
    ['Kick', [
      ['breast_heel_recovery','Heel recovery',['Compact','Moderate','Wide','Variable']],
      ['breast_kick_width','Kick width',['Narrow','Moderate','Wide','Variable']],
      ['breast_foot_position','Foot position',['Turned out','Neutral','Inconsistent','Variable']],
      ['breast_kick_finish','Kick finish',['Complete','Partial','Asymmetric','Variable']],
      ['breast_kick_symmetry','Kick symmetry',['Balanced','Left dominant','Right dominant','Variable']],
    ]],
    ['Timing & Glide', [
      ['breast_pull_kick_timing','Pull-kick timing',['Sequential','Overlapping','Delayed','Variable']],
      ['breast_breath_timing','Breathing timing',['Early','Mid','Late','Variable']],
      ['breast_glide','Glide',['Short','Moderate','Long','Variable']],
      ['breast_rhythm','Rhythm',['Consistent','Interrupted','Variable']],
    ]],
    ['Fatigue Response', [
      ['breast_fatigue_timing','Timing under fatigue',['Maintained','Deteriorates','Variable']],
      ['breast_fatigue_glide','Glide under fatigue',['Maintained','Shortens','Lengthens','Variable']],
      ['breast_fatigue_symmetry','Symmetry under fatigue',['Maintained','Deteriorates','Variable']],
    ]],
  ]);

  const butterfly = techniqueRows([
    ['Body Position & Undulation', [
      ['fly_head_position','Head position',['Neutral','Raised','Lowered','Variable']],
      ['fly_body_line','Body line',['Streamlined','Moderate resistance','High resistance','Variable']],
      ['fly_undulation','Undulation',['Small','Moderate','Large','Variable']],
      ['fly_undulation_source','Undulation source',['Chest-led','Mixed','Knee-led','Variable']],
    ]],
    ['Entry & Catch', [
      ['fly_hand_entry','Hand entry',['Shoulder width','Narrow','Wide','Crossover','Variable']],
      ['fly_entry_angle','Entry angle',['Flat','Fingertips first','Steep','Variable']],
      ['fly_catch_timing','Catch timing',['Early','Mid','Late','Variable']],
      ['fly_catch_elbow','Elbow position during catch',['High','Neutral','Dropped','Variable']],
    ]],
    ['Pull & Propulsion', [
      ['fly_pull_path','Pull path',['Consistent','Wide','Narrow','Variable']],
      ['fly_finish','Finish',['Complete','Short','Variable']],
    ]],
    ['Recovery', [
      ['fly_recovery','Recovery',['Relaxed','Moderate tension','Tense','Variable']],
      ['fly_recovery_width','Recovery width',['Narrow','Moderate','Wide','Variable']],
    ]],
    ['Kick', [
      ['fly_first_kick','First kick timing',['Early','Mid','Late','Variable']],
      ['fly_second_kick','Second kick timing',['Early','Mid','Late','Variable']],
      ['fly_kick_amplitude','Kick amplitude',['Small','Moderate','Large','Variable']],
      ['fly_kick_symmetry','Kick symmetry',['Balanced','Left dominant','Right dominant','Variable']],
    ]],
    ['Breathing & Coordination', [
      ['fly_breath_frequency','Breathing frequency',['Every 1','Every 2','Every 3+','Variable']],
      ['fly_breath_timing','Breathing timing',['Early','Mid','Late','Variable']],
      ['fly_arm_kick','Arm-kick coordination',['Consistent','Inconsistent','Variable']],
      ['fly_rhythm','Rhythm',['Consistent','Interrupted','Variable']],
    ]],
    ['Fatigue Response', [
      ['fly_fatigue_body','Body line under fatigue',['Maintained','Deteriorates','Variable']],
      ['fly_fatigue_timing','Timing under fatigue',['Maintained','Deteriorates','Variable']],
      ['fly_fatigue_kick','Kick under fatigue',['Maintained','Reduces','Increases','Variable']],
    ]],
  ]);

  const turn = (stroke, items) => technicalTemplate({
    name: stroke + ' Turn Assessment', stroke,
    rows: techniqueRows([['Turn', items]]),
  });

  const start = technicalTemplate({
    name:'Start Assessment', stroke:'',
    rows: techniqueRows([
      ['Start', [
        ['start_set_position','Set position',['Stable','Forward-biased','Rear-biased','Variable']],
        ['start_reaction','Reaction',['Early','On cue','Delayed','Variable']],
        ['start_takeoff','Take-off direction',['Flat','Moderate arc','High arc','Variable']],
        ['start_entry','Water entry',['Clean','Moderate splash','Large splash','Variable']],
        ['start_streamline','Streamline',['Tight','Moderate','Loose','Variable']],
        ['start_underwater','Underwater phase',['Short','Moderate','Long','Variable']],
        ['start_breakout','Breakout timing',['Early','Appropriate','Late','Variable']],
        ['start_first_stroke','First stroke timing',['Immediate','Timed to breakout','Delayed','Variable']],
      ]],
    ]),
  });

  return [
    technicalTemplate({name:'Freestyle Technical Assessment',stroke:'Freestyle',rows:freestyle}),
    technicalTemplate({name:'Backstroke Technical Assessment',stroke:'Backstroke',rows:backstroke}),
    technicalTemplate({name:'Breaststroke Technical Assessment',stroke:'Breaststroke',rows:breaststroke}),
    technicalTemplate({name:'Butterfly Technical Assessment',stroke:'Butterfly',rows:butterfly}),
    turn('Freestyle',[
      ['free_turn_approach','Approach',['Controlled','Accelerating','Decelerating','Variable']],
      ['free_turn_final_stroke','Final stroke into wall',['Long','Normal','Short','Variable']],
      ['free_turn_rotation','Somersault/rotation',['Compact','Moderate','Wide','Variable']],
      ['free_turn_foot_placement','Foot placement',['High','Mid','Low','Asymmetric','Variable']],
      ['free_turn_push','Push-off direction',['Straight','Upward','Downward','Variable']],
      ['free_turn_streamline','Streamline',['Tight','Moderate','Loose','Variable']],
      ['free_turn_underwater','Underwater',['Short','Moderate','Long','Variable']],
      ['free_turn_breakout','Breakout',['Early','Appropriate','Late','Variable']],
      ['free_turn_first_stroke','First stroke',['Immediate','Timed to breakout','Delayed','Variable']],
    ]),
    turn('Backstroke',[
      ['back_turn_approach','Approach count',['Consistent','Short','Long','Variable']],
      ['back_turn_rotation_front','Rotation to front',['Early','On timing','Late','Variable']],
      ['back_turn_final_stroke','Final stroke',['Controlled','Long','Short','Variable']],
      ['back_turn_wall_rotation','Wall rotation',['Compact','Moderate','Wide','Variable']],
      ['back_turn_foot_placement','Foot placement',['High','Mid','Low','Asymmetric','Variable']],
      ['back_turn_push','Push-off',['Straight','Upward','Downward','Variable']],
      ['back_turn_streamline','Streamline',['Tight','Moderate','Loose','Variable']],
      ['back_turn_underwater','Underwater kick',['Short','Moderate','Long','Variable']],
      ['back_turn_breakout','Breakout',['Early','Appropriate','Late','Variable']],
    ]),
    turn('Breaststroke',[
      ['breast_turn_approach','Approach',['Controlled','Long final stroke','Short final stroke','Variable']],
      ['breast_turn_touch','Two-hand touch',['Simultaneous','Uneven','Variable']],
      ['breast_turn_rotation','Body rotation',['Compact','Moderate','Wide','Variable']],
      ['breast_turn_foot_placement','Foot placement',['High','Mid','Low','Asymmetric','Variable']],
      ['breast_turn_push','Push-off',['Straight','Upward','Downward','Variable']],
      ['breast_turn_streamline','Streamline',['Tight','Moderate','Loose','Variable']],
      ['breast_turn_pullout','Pullout',['Early','Well timed','Late','Variable']],
      ['breast_turn_first_kick','First kick',['Early','Well timed','Late','Variable']],
      ['breast_turn_breakout','Breakout',['Early','Appropriate','Late','Variable']],
    ]),
    turn('Butterfly',[
      ['fly_turn_approach','Approach',['Controlled','Long final stroke','Short final stroke','Variable']],
      ['fly_turn_touch','Two-hand touch',['Simultaneous','Uneven','Variable']],
      ['fly_turn_rotation','Body rotation',['Compact','Moderate','Wide','Variable']],
      ['fly_turn_foot_placement','Foot placement',['High','Mid','Low','Asymmetric','Variable']],
      ['fly_turn_push','Push-off',['Straight','Upward','Downward','Variable']],
      ['fly_turn_streamline','Streamline',['Tight','Moderate','Loose','Variable']],
      ['fly_turn_underwater','Underwater dolphin',['Short','Moderate','Long','Variable']],
      ['fly_turn_breakout','Breakout',['Early','Appropriate','Late','Variable']],
      ['fly_turn_first_stroke','First stroke',['Immediate','Timed to breakout','Delayed','Variable']],
    ]),
    start,
  ];
}

function developmentCharacteristicsTemplate() {
  const items = [
    ['motivation','Motivation','How strongly do you want to improve and achieve your goals?'],
    ['competitive_mindset','Competitive Mindset','How much do you enjoy competing and challenging yourself against others or your own best performances?'],
    ['concentration','Concentration','How well can you stay focused on what you need to do during training and competition?'],
    ['confidence','Confidence','How confident are you in your ability to perform and improve?'],
    ['independence','Independence','How well can you take responsibility for your own preparation and development?'],
    ['composure','Composure','How well do you stay calm and perform effectively when under pressure?'],
    ['resilience','Resilience','How well do you keep working when training is difficult or things do not go as planned?'],
    ['training_commitment','Training Commitment','How consistently do you apply yourself and complete the work required?'],
    ['responsiveness_to_coaching','Responsiveness to Coaching','How well do you listen to feedback, understand it and try to apply it?'],
    ['challenge_readiness','Challenge Readiness','How willing are you to attempt difficult things even when you may fail or feel uncomfortable?'],
  ];
  const rows = items.map(([key,label,question],index)=>({
    order:index+1, phase:'Questionnaire', rounds:1, reps:1, distance:0, stroke:'',
    description:question, label, assessmentGroup:'Development Characteristics',
    rest:'0:00', sendOff:'0:00', energy:'N/A', modality:'Questionnaire',
    setType:'test', isTestSet:true, testCategory:'Questionnaires', testFamily:'questionnaires',
    resultType:'Rating', resultUnit:'1-10',
    resultFields:[
      {key:key+'_rating',label:label+' · Rating',inputType:'select',options:['1','2','3','4','5','6','7','8','9','10'],group:'Development Characteristics'},
      {key:key+'_note',label:label+' · Note',inputType:'textarea',group:'Development Characteristics'},
    ],
    protocol:question,
  }));
  return {
    name:'AthlyraX Development Characteristics',
    testFamily:'questionnaires',
    description:'Swimmer self-assessment across ten development characteristics.',
    notes:'Swimmer-rated 1–10 with an optional note for each characteristic. Track longitudinally; do not reduce to a single talent score.',
    setType:'test',isTestSet:true,testCategory:'Questionnaires',resultType:'Rating',resultUnit:'1-10',
    resultFields:rows.flatMap(row=>row.resultFields),rows,lineCount:rows.length,
  };
}

export function canonicalBuiltInTestTemplate(name) {
  const key = String(name || '').trim().toLowerCase();
  const technical = canonicalTechnicalTemplates().find(template => template.name.toLowerCase() === key);
  if (technical) return technical;
  if (key === 'athlyrax development characteristics' || key === 'development characteristics') return developmentCharacteristicsTemplate();

  const makeSingle = ({
    name: templateName,
    family,
    category,
    description,
    notes,
    modality,
    resultType,
    resultUnit,
    protocol,
    reps = 1,
    distance = 0,
    stroke = '',
    energy = 'N/A',
    sendOff = '0:00',
    resultFields = [],
  }) => {
    const row = {
      order: 1,
      phase: 'Main',
      rounds: 1,
      reps,
      distance,
      stroke,
      description: templateName,
      rest: '0:00',
      sendOff,
      energy,
      modality,
      setType: 'test',
      isTestSet: true,
      testCategory: category,
      testFamily: family,
      resultType,
      resultUnit,
      resultFields,
      protocol,
    };
    return {
      name: templateName,
      testFamily: family,
      description,
      notes,
      setType: 'test',
      isTestSet: true,
      testCategory: category,
      resultType,
      resultUnit,
      resultFields,
      rows: [row],
      lineCount: 1,
    };
  };

  if (key === 'aerobic / durability check' || key === 'aerobic durability check' || key === '5x400') {
    const template = makeSingle({
      name: 'Aerobic / Durability Check',
      family: 'swimming',
      category: 'Swimming',
      description: 'Optional 5x400 controlled aerobic / durability check.',
      notes: 'Optional supporting test, not part of the fixed AthlyraX core battery.',
      modality: 'Swim',
      resultType: 'Time',
      resultUnit: 's',
      protocol: 'Complete 5x400 under a consistent controlled aerobic protocol. Record all five times, stroke information where practical, pacing drift and the point where organisation first breaks.',
      reps: 5,
      distance: 400,
      stroke: 'free',
      energy: 'EN2',
      sendOff: '0:00',
    });
    template.rows[0] = {
      ...template.rows[0],
      description: '5x400 Aerobic / Durability Check',
      label: '5x400 Aerobic / Durability Check',
      recurrenceEveryWeeks: 4,
    };
    return template;
  }

  if (key === 'height & weight' || key === 'height and weight') {
    return makeSingle({
      name: 'Height & Weight',
      family: 'measurements',
      category: 'Measurements',
      description: 'Standing height and body weight on one row.',
      notes: 'Physical measurement template. Longitudinal context only; not capability scoring.',
      modality: 'Measurement',
      resultType: 'Height & Weight',
      resultUnit: 'cm / kg',
      protocol: 'Record standing height and body weight together.',
      resultFields: [
        { key: 'heightCm', label: 'Height', unit: 'cm' },
        { key: 'weightKg', label: 'Weight', unit: 'kg' },
      ],
    });
  }

  if (key === '50m run' || key === '50 metre run' || key === '50 meter run') {
    return makeSingle({
      name: '50m Run',
      family: 'running',
      category: 'Running',
      description: 'Simple 50m running speed test.',
      notes: 'Generic running test template.',
      modality: 'Run',
      resultType: 'Time',
      resultUnit: 's',
      protocol: 'Use a consistent start and surface. Record the 50m completion time.',
      reps: 1,
      distance: 50,
      energy: 'SP',
    });
  }

  if (key === 'high jump') {
    return makeSingle({
      name: 'High Jump',
      family: 'jumping',
      category: 'Jumping',
      description: 'Simple jump-height test.',
      notes: 'Generic jumping test template.',
      modality: 'Jump',
      resultType: 'Height',
      resultUnit: 'cm',
      protocol: 'Use the same jump method and measurement setup each time. Record best valid height.',
      resultFields: [{ key: 'heightCm', label: 'Height', unit: 'cm' }],
    });
  }

  if (key === '500m row' || key === '500 metre row' || key === '500 meter row') {
    return makeSingle({
      name: '500m Row',
      family: 'rowing',
      category: 'Rowing',
      description: 'Simple 500m rowing ergometer test.',
      notes: 'Generic rowing test template.',
      modality: 'Row',
      resultType: 'Time',
      resultUnit: 's',
      protocol: 'Use the same ergometer settings each time. Record the available performance data consistently.',
      reps: 1,
      distance: 500,
      energy: 'AN',
      resultFields: [
        { key: 'time', label: 'Time', type: 'Time', unit: 's' },
        { key: 'pace500m', label: 'Pace / 500m', type: 'Pace', unit: 'min/500m' },
        { key: 'averagePowerW', label: 'Average Power', type: 'Power', unit: 'W' },
        { key: 'strokeRateSpm', label: 'Stroke Rate', type: 'Stroke Rate', unit: 'spm' },
        { key: 'heartRateBpm', label: 'Heart Rate', type: 'Heart Rate', unit: 'bpm' },
        { key: 'lactateMmol', label: 'Lactate', type: 'Lactate', unit: 'mmol/L' },
      ],
    });
  }

  if (key === 'gym strength') {
    return makeSingle({
      name: 'Gym Strength',
      family: 'gym',
      category: 'Gym',
      description: 'Generic strength test for a chosen exercise.',
      notes: 'Use the exercise/load fields consistently for longitudinal comparison.',
      modality: 'Gym',
      resultType: 'Weight',
      resultUnit: 'kg',
      protocol: 'Choose the exercise, record the weight/load and completed repetitions using the same technique standard.',
      resultFields: [
        { key: 'exercise', label: 'Exercise', type: 'Custom', unit: '' },
        { key: 'weightKg', label: 'Weight', type: 'Weight', unit: 'kg' },
        { key: 'reps', label: 'Repetitions', type: 'Repetitions', unit: 'reps' },
      ],
    });
  }

  const category = key === 'max' ? 'max' : (key === 'repeatability' ? 'repeat' : '');
  if (!category) return null;
  const rows = buildFixedTestTemplateRows()
    .filter((row) => row.category === category)
    .map((row, index) => ({
      order: index + 1,
      phase: 'Main',
      rounds: 1,
      reps: row.reps,
      distance: row.distance,
      stroke: row.stroke,
      description: row.label,
      rest: '0:00',
      sendOff: row.sendOff,
      energy: category === 'max' ? 'SP' : 'EN2',
      modality: 'Swim',
      setType: 'test',
      isTestSet: true,
      testCategory: 'Swimming',
      testFamily: 'swimming',
      resultType: 'Time',
      resultUnit: 's',
      protocol: row.guidance,
      recurrenceEveryWeeks: row.recurrenceEveryWeeks,
    }));
  const distances = rows.map((row) => row.distance).join(', ');
  return {
    name: category === 'max' ? 'Max' : 'Repeatability',
    testFamily: 'swimming',
    description: category === 'max' ? `${distances} Max` : rows.map((row) => `${row.reps}x${row.distance}`).join(', '),
    notes: category === 'max' ? 'Canonical Max test battery.' : 'Canonical Repeatability test battery.',
    setType: 'test',
    isTestSet: true,
    testCategory: 'Swimming',
    resultType: 'Time',
    resultUnit: 's',
    rows,
    lineCount: rows.length,
  };
}

export function canonicalBuiltInTestTemplates() {
  return ['Max', 'Repeatability', 'Aerobic / Durability Check', 'Height & Weight', '50m Run', 'High Jump', '500m Row', 'Gym Strength']
    .map((name) => canonicalBuiltInTestTemplate(name));
}

export function canonicalBuiltInAssessmentTemplates() {
  return [
    ...canonicalTechnicalTemplates(),
    developmentCharacteristicsTemplate(),
  ];
}
