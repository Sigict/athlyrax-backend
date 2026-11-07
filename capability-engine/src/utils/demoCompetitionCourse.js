// Backward-compatible course metadata for the six unmodified synthetic
// demonstration fixtures from the original seed. No inference for user meets.
// A newly saved explicit pool length always wins.
const ORIGINAL_DEMO_MEET_COURSES = Object.freeze({
  benchmark: 25,
  development: 50,
  regional: 25,
  prep: 50,
  october: 25,
  target: 50,
});

export function resolveDemoFixturePoolLength(fixture) {
  const explicit = Number(fixture?.poolLength);
  if (explicit === 25 || explicit === 50) return explicit;
  const id = String(fixture?.id || '').trim();
  if (!id.startsWith('demo_showcase_fixture_')) return null;
  const key = id.slice('demo_showcase_fixture_'.length);
  return ORIGINAL_DEMO_MEET_COURSES[key] || null;
}
