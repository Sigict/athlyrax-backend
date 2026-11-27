import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

test('canonical postinstall backend registers Feedback save, owner inbox, and owner email', () => {
  const backend = fs.readFileSync('index.js', 'utf8');
  const build = fs.readFileSync('scripts/build-production-backend.mjs','utf8');
  assert.ok(build.includes("run('final tenant-scoped Feedback API and email notification'"), 'Transform must be in production build');
  assert.ok(backend.includes('// ATHLYRAX_OWNER_FEEDBACK_EMAIL_V1'), 'Feedback must exist in built backend');
  assert.equal((backend.match(/app\.post\('\/feedback'/g) || []).length, 1);
  assert.equal((backend.match(/app\.get\('\/feedback'/g) || []).length, 1);
  assert.equal((backend.match(/app\.patch\('\/feedback\/:id\/decision'/g) || []).length, 1);
  const postStart = backend.indexOf("app.post('/feedback'");
  const getStart = backend.indexOf("app.get('/feedback'",postStart);
  const patchStart = backend.indexOf("app.patch('/feedback/:id/decision'",getStart);
  const saveRoute = backend.slice(postStart,getStart);
  const inboxRoute = backend.slice(getStart,patchStart);
  assert.ok(saveRoute.includes("enqueueWrite(async () =>"));
  assert.ok(saveRoute.indexOf('writeAtomicJsonFile(filePath, rows)') < saveRoute.indexOf('sendOwnerFeedbackEmail(row)'), 'Email only after durable save');
  assert.ok(saveRoute.includes("res.status(201).json({ ok: true, row })"));
  assert.ok(saveRoute.includes(".catch((error) =>"), 'SMTP rejection must be caught');
  assert.ok(saveRoute.includes("res.status(500).json({ error: 'Could not save feedback message.' })"), 'Storage failures must be reported');
  assert.ok(backend.includes("FEEDBACK_NOTIFY_EMAIL || 'AthlyraX@outlook.com'"));
  assert.ok(backend.includes('getAuthResetMailTransport().sendMail('), 'Use existing SMTP configuration');
  assert.ok(inboxRoute.includes("if (!isPrimarySoftwareOwnerAccount(req.auth))"));
  assert.ok(inboxRoute.includes("rows: [], inboxVisible: false"), 'Non-owner receives no other users messages, nor a spurious error');
  assert.ok(inboxRoute.includes("inboxVisible: true"), 'Owner retains inbox');
  assert.ok(backend.includes("['fix', 'archive']"), 'Preserve existing owner triage contract');
});
