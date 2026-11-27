export const ATHLYRAX_AXES_SNAKE = [
  { key: 'technical_control', label: 'Technical Control' },
  { key: 'efficiency', label: 'Efficiency' },
  { key: 'robustness_of_efficiency', label: 'Robustness of Efficiency' },
  { key: 'aerobic_capacity', label: 'Aerobic Capacity' },
  { key: 'anaerobic_capacity', label: 'Anaerobic Capacity' },
  { key: 'power_speed_expression', label: 'Power & Speed Expression' },
  { key: 'adaptability', label: 'Adaptability' },
  { key: 'durability', label: 'Durability' },
];

export const ATHLYRAX_AXES_CAMEL = [
  { key: 'technicalControl', label: 'Technical Control' },
  { key: 'efficiency', label: 'Efficiency' },
  { key: 'robustnessOfEfficiency', label: 'Robustness of Efficiency' },
  { key: 'aerobicCapacity', label: 'Aerobic Capacity' },
  { key: 'anaerobicCapacity', label: 'Anaerobic Capacity' },
  { key: 'powerSpeedExpression', label: 'Power & Speed Expression' },
  { key: 'adaptability', label: 'Adaptability' },
  { key: 'durability', label: 'Durability' },
];

export const ATHLYRAX_AXIS_LABELS = ATHLYRAX_AXES_SNAKE.map((axis) => axis.label);

export const ATHLYRAX_AXIS_KEY_ALIASES = {
  technical: 'technical_control',
  efficiency: 'efficiency',
  efficiency_cost: 'efficiency',
  robustness: 'robustness_of_efficiency',
  aerobic: 'aerobic_capacity',
  anaerobic: 'anaerobic_capacity',
  speed: 'power_speed_expression',
  speed_expression: 'power_speed_expression',
  power_speed_expression: 'power_speed_expression',
  adaptability: 'adaptability',
  adaptive: 'adaptability',
  durability: 'durability',
  durable: 'durability',
};

export const ATHLYRAX_AXIS_OPTIONS = [
  { id: 'all', label: 'All axes' },
  ...ATHLYRAX_AXES_SNAKE.map((axis) => ({ id: axis.key, label: axis.label })),
];
