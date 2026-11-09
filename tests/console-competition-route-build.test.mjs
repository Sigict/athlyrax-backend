import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

// The production build removes the index.js block holding the Coach Poolside routes
// (patch-coach-link-lifecycle.mjs) and re-inserts them from patch-coach-poolside-api.mjs.
// The Console race detail fields must therefore be passed by both copies of the route.
const FIELDS = ['splits', 'segmentTimes', 'strokeCount', 'position', 'heat', 'lane', 'splitLength'];
const routeOf = (source) => {
  const start = source.indexOf("app.post('/coach/poolside/competitions/:fixtureId/events/:eventId/evidence'");
  assert.ok(start >= 0, 'competition evidence route present');
  return source.slice(start, source.indexOf('\n});', start));
};

test('Console competition route passes race detail in index.js and in the production template', () => {
  for (const file of ['index.js', 'scripts/patch-coach-poolside-api.mjs']) {
    const route = routeOf(fs.readFileSync(file, 'utf8'));
    for (const field of FIELDS) assert.ok(route.includes(`${field}: req.body?.${field}`), `${file}: ${field}`);
  }
});
