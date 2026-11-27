import fs from 'node:fs';
const path = 'index.js';
let source = fs.readFileSync(path, 'utf8');
const marker = '// ATHLYRAX_OWNER_FEEDBACK_EMAIL_V1';
const anchor = "app.get('/db', requireAuth, (req, res) => {";
if (source.includes(marker)) {
  console.log('ATHLYRAX_OWNER_FEEDBACK_EMAIL_ALREADY_INSTALLED');
  process.exit(0);
}
if (!source.includes(anchor)) throw new Error('Cannot find authenticated database route for feedback insertion.');
if (source.includes("app.post('/feedback'") || source.includes("app.get('/feedback'"))
  throw new Error('Feedback endpoint already defined; reconcile rather than register a duplicate.');
const addition = String.raw`
// ATHLYRAX_OWNER_FEEDBACK_EMAIL_V1
// Feedback storage is separate from coaching data. The message is durably committed
// before any SMTP attempt; a mail outage cannot discard or roll back the submission.
const ATHLYRAX_FEEDBACK_TO = String(process.env.FEEDBACK_NOTIFY_EMAIL || 'AthlyraX@outlook.com').trim();
function feedbackFileForTenant(storagePaths) {
  return path.join(path.dirname(storagePaths.dbPath), 'feedback-messages.json');
}
function readOwnerFeedback(filePath, tenantKey) {
  const payload = readJsonFile(filePath);
  const rows = Array.isArray(payload) ? payload : (Array.isArray(payload?.rows) ? payload.rows : []);
  return rows.filter((item) => item && typeof item === 'object')
    .map((item) => ({ ...item, tenantKey: String(item.tenantKey || tenantKey || '') }));
}
async function sendOwnerFeedbackEmail(row) {
  if (!ATHLYRAX_FEEDBACK_TO || !AUTH_EMAIL_PATTERN.test(ATHLYRAX_FEEDBACK_TO)) {
    console.error('[feedback] Notification skipped: owner recipient is invalid.');
    return;
  }
  if (!AUTH_SMTP_HOST || !AUTH_SMTP_FROM) {
    console.error('[feedback] Message saved, email not sent: configure AUTH_SMTP_HOST and AUTH_SMTP_FROM.');
    return;
  }
  await getAuthResetMailTransport().sendMail({
    from: AUTH_SMTP_FROM,
    to: ATHLYRAX_FEEDBACK_TO,
    subject: '[AthlyraX Feedback] ' + row.topic.replace(/[\r\n]+/g, ' ').slice(0, 150),
    text: [
      'A coach submitted feedback in AthlyraX.',
      '',
      'Submitted by: ' + row.createdBy,
      'Role: ' + row.createdRole,
      'Tenant: ' + row.tenantKey,
      'Date: ' + row.createdAt,
      'Reference: ' + row.id,
      'Topic: ' + row.topic,
      '',
      row.description,
      '',
      'The original submission is stored in the owner-only Feedback Inbox.'
    ].join('\n'),
  });
}
app.post('/feedback', requireStrictAuth, (req, res) => {
  const topic = String(req.body?.topic || '').trim();
  const description = String(req.body?.description || '').trim();
  if (!topic || !description) {
    res.status(400).json({ error: 'Topic and description are required.' });
    return;
  }
  if (topic.length > 200 || description.length > 4000) {
    res.status(400).json({ error: 'Topic (max 200) or description (max 4000) is too long.' });
    return;
  }
  const storagePaths = resolveStoragePathsForAuth(req.auth);
  const row = {
    id: crypto.randomUUID(), topic, description, status: 'pending',
    decision: '', decisionBy: '', decisionAt: '',
    createdBy: String(req.auth?.username || '').trim(),
    createdRole: String(req.auth?.role || '').trim(),
    createdAt: new Date().toISOString(),
    tenantKey: String(storagePaths.tenantKey || '').trim(),
  };
  enqueueWrite(async () => {
    ensureStorageLayout(storagePaths);
    const filePath = feedbackFileForTenant(storagePaths);
    const rows = readOwnerFeedback(filePath, storagePaths.tenantKey);
    rows.unshift(row);
    writeAtomicJsonFile(filePath, rows);
  }).then(() => {
    res.status(201).json({ ok: true, row });
    // Notify after persistence and response. SMTP errors are logged without
    // falsely telling the coach their saved feedback has failed.
    void sendOwnerFeedbackEmail(row).catch((error) =>
      console.error('[feedback] Message saved but notification failed:', error instanceof Error ? error.message : String(error)));
  }).catch((error) => {
    console.error('[feedback] Durable save failed:', error instanceof Error ? error.message : String(error));
    res.status(500).json({ error: 'Could not save feedback message.' });
  });
});
app.get('/feedback', requireStrictAuth, (req, res) => {
  // Existing coach modal loads the inbox even though it is owner-only.
  // Give coaches an empty collection without revealing other submissions.
  if (!isPrimarySoftwareOwnerAccount(req.auth)) {
    res.status(200).json({ ok: true, rows: [], inboxVisible: false });
    return;
  }
  const targets = [{ tenantKey: 'global-owner', dbPath: DB_PATH }];
  if (fs.existsSync(DB_TENANTS_DIR)) {
    for (const entry of fs.readdirSync(DB_TENANTS_DIR, { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^[a-z0-9_-]+$/.test(entry.name)) continue;
      targets.push({ tenantKey: entry.name, dbPath: path.join(DB_TENANTS_DIR, entry.name, 'db.json') });
    }
  }
  const rows = targets.flatMap((scope) => readOwnerFeedback(feedbackFileForTenant(scope), scope.tenantKey))
    .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
  res.status(200).json({ ok: true, rows, inboxVisible: true });
});
app.patch('/feedback/:id/decision', requireStrictAuth, (req, res) => {
  if (!isPrimarySoftwareOwnerAccount(req.auth)) {
    res.status(403).json({ error: 'Feedback triage is owner-only.' });
    return;
  }
  const id = String(req.params?.id || '').trim();
  const decision = String(req.body?.decision || '').trim().toLowerCase();
  if (!id || !['fix', 'archive'].includes(decision)) {
    res.status(400).json({ error: 'Valid feedback id and decision required.' });
    return;
  }
  enqueueWrite(async () => {
    const scopes = [{ tenantKey: 'global-owner', dbPath: DB_PATH }];
    if (fs.existsSync(DB_TENANTS_DIR)) {
      for (const entry of fs.readdirSync(DB_TENANTS_DIR, { withFileTypes: true })) {
        if (entry.isDirectory() && /^[a-z0-9_-]+$/.test(entry.name)) {
          scopes.push({ tenantKey: entry.name, dbPath: path.join(DB_TENANTS_DIR, entry.name, 'db.json') });
        }
      }
    }
    for (const scope of scopes) {
      const filePath = feedbackFileForTenant(scope);
      if (!fs.existsSync(filePath)) continue;
      const rows = readOwnerFeedback(filePath, scope.tenantKey);
      const index = rows.findIndex((row) => String(row.id || '') === id);
      if (index < 0) continue;
      rows[index] = {
        ...rows[index], decision, status: decision === 'fix' ? 'fix-queued' : 'archived', decisionBy: String(req.auth?.username || '').trim(),
        decisionAt: new Date().toISOString(),
      };
      writeAtomicJsonFile(filePath, rows);
      return rows[index];
    }
    return null;
  }).then((row) => row ? res.status(200).json({ ok: true, row }) : res.status(404).json({ error: 'Feedback not found.' }))
    .catch((error) => {
      console.error('[feedback] Triage write failed:', error instanceof Error ? error.message : String(error));
      res.status(500).json({ error: 'Could not update feedback decision.' });
    });
});
`;
source = source.replace(anchor, addition + '\n' + anchor);
fs.writeFileSync(path, source, 'utf8');
console.log('ATHLYRAX_OWNER_FEEDBACK_EMAIL_INSTALLED');
