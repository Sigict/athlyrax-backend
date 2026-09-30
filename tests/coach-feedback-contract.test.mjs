import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const patchFile = path.join(root, 'scripts', 'patch-coach-feedback-email.mjs');
const builtIndex = fs.readFileSync(path.join(root, 'index.js'), 'utf8');

test('production build installs feedback once with owner email and a safe coach inbox', () => {
  const start = builtIndex.indexOf('// ATHLYRAX_COACH_FEEDBACK_EMAIL_V1');
  assert.ok(start > 0, 'Production build must include feedback routes');
  const source = builtIndex.slice(start, builtIndex.indexOf('// Serve db.json at /db', start));
  assert.match(source, /FEEDBACK_NOTIFICATION_EMAIL \|\| 'AthlyraX@outlook\.com'/);
  assert.match(source, /app\.post\('\/feedback', requireStrictAuth/);
  assert.match(source, /app\.get\('\/feedback', requireStrictAuth/);
  assert.match(source, /app\.patch\('\/feedback\/:id\/decision', requireStrictAuth/);
  assert.match(source, /canViewInbox: false/);
  assert.match(source, /canViewInbox: true/);
  assert.match(source, /requireSoftwareOwnerRole/);
  assert.match(source, /String\(req\.auth\?\.role \|\| ''\)\.trim\(\) !== 'software-owner'/);
  assert.match(source, /feedbackPathForTenant = \(storagePaths\)/);
  assert.match(source, /feedbackPathForTenant\(paths\)/);
  assert.match(source, /getAuthResetMailTransport\(\)\.sendMail/);
  assert.match(source, /if \(!paths\?\.dbPath \|\| !fs\.existsSync\(paths\.dbPath\)\)/);
  assert.equal(source.split("app.post('/feedback',").length - 1, 1);
  assert.ok(source.indexOf('await enqueueWrite(async () =>') < source.indexOf('const notification = await notifyFeedbackRecipient(row)'), 'Save must complete before sending an email');
  assert.ok(source.indexOf('writeAtomicJsonFile(feedbackPath, rows)') < source.indexOf('const notification = await notifyFeedbackRecipient(row)'), 'Failed SMTP may not erase or roll back saved feedback');
  assert.match(source, /res\.status\(201\)\.json\(\{ ok: true, row, notification \}\)/);
  assert.doesNotMatch(source, /to: req\.body/);
});

test('transform is idempotent and builds syntactically valid backend route source', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'athlyrax-feedback-contract-'));
  try {
    const index = path.join(dir, 'index.js');
    fs.writeFileSync(index, '// minimal synthetic backend\n// Serve db.json at /db\n', 'utf8');
    const invoke = () => spawnSync(process.execPath, [patchFile], { cwd: dir, encoding: 'utf8' });
    const first = invoke();
    assert.equal(first.status, 0, first.stderr);
    const source = fs.readFileSync(index, 'utf8');
    assert.match(source, /COACH_FEEDBACK_EMAIL_V1/);
    const syntax = spawnSync(process.execPath, ['--check', index], { encoding: 'utf8' });
    assert.equal(syntax.status, 0, syntax.stderr);
    const second = invoke();
    assert.equal(second.status, 0, second.stderr);
    assert.equal(fs.readFileSync(index, 'utf8'), source, 'Build must not duplicate feedback routes');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
