import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

// The production build removes the index.js block that holds the Coach Poolside routes
// (patch-coach-link-lifecycle.mjs rewrites from /swimmer/coach/disconnect to the /db anchor) and
// re-inserts them from the templates in scripts/patch-coach-poolside-api.mjs. Every Coach Poolside
// route must therefore be identical in both places; a change made in only one is lost or diverges.
const routesOf = (source) => {
  const out = new Map();
  const re = /app\.(get|post|put|delete)\('(\/coach\/poolside[^']*)'/g;
  let m;
  while ((m = re.exec(source))) {
    const end = source.indexOf('\n});', m.index);
    const body = source.slice(m.index, end).split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('//')).join('\n')
      .replace(/writeAtomicJsonFileCompact\(/g, 'writeAtomicJsonFile('); // later build transform, not a route difference
    out.set(`${m[1]} ${m[2]}`, body);
  }
  return out;
};

test('every Coach Poolside route is identical in index.js and in the production template', () => {
  // Only the region the build replaces: from the swimmer coach disconnect route to the /db anchor.
  const source = fs.readFileSync('index.js', 'utf8');
  const start = source.indexOf("app.post('/swimmer/coach/disconnect'");
  const end = source.indexOf('// Serve db.json at /db', start);
  assert.ok(start > 0 && end > start, 'replaced region found');
  const index = routesOf(source.slice(start, end));
  const template = routesOf(fs.readFileSync('scripts/patch-coach-poolside-api.mjs', 'utf8'));
  assert.ok(template.size >= 6, `template routes found: ${template.size}`);
  for (const [route, body] of template) {
    assert.ok(index.has(route), `${route} missing from index.js`);
    assert.equal(index.get(route), body, `${route} differs between index.js and scripts/patch-coach-poolside-api.mjs`);
  }
  for (const route of index.keys()) assert.ok(template.has(route), `${route} is in index.js but not in the production template`);
});
