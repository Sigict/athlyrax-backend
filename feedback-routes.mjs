// Persistent tenant-scoped coach feedback with owner-only inbox and optional SMTP alert.
// Route registration is injected by the guarded production build.
export function registerFeedbackRoutes({
  app, fs, path, crypto, storageRoot, tenantsDir, resolveStoragePathsForAuth,
  isPrimarySoftwareOwnerAccount, requireStrictAuth, requireAdminRateLimit,
  enqueueWrite, getAuthResetMailTransport, smtp, appendAuthAuditEvent,
}) {
  const recipient = String(process.env.FEEDBACK_NOTIFICATION_TO || 'AthlyraX@outlook.com').trim();
  const enabled = String(process.env.FEEDBACK_EMAIL_ENABLED || 'true').trim().toLowerCase() !== 'false';
  const rowPath = (storagePaths) => path.join(path.dirname(storagePaths.dbPath), 'feedback-messages.json');
  const validEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const rowFields = (row) => ({
    id: String(row?.id || ''),
    topic: String(row?.topic || ''),
    description: String(row?.description || ''),
    status: String(row?.status || 'pending'),
    decision: String(row?.decision || ''),
    decisionBy: String(row?.decisionBy || ''),
    decisionAt: String(row?.decisionAt || ''),
    createdBy: String(row?.createdBy || ''),
    createdRole: String(row?.createdRole || ''),
    createdAt: String(row?.createdAt || ''),
    tenantKey: String(row?.tenantKey || ''),
  });
  const read = (file) => {
    if (!fs.existsSync(file)) return [];
    // Malformed existing stores must never be silently overwritten by an empty array.
    const payload = JSON.parse(fs.readFileSync(file, 'utf8'));
    const items = Array.isArray(payload) ? payload : payload?.rows;
    if (!Array.isArray(items)) throw new Error('Existing feedback store is not a valid row collection.');
    return items.map(rowFields);
  };
  const write = (file, rows) => {
    const dir = path.dirname(file);
    fs.mkdirSync(dir, { recursive: true });
    const temp = path.join(dir, 'feedback-messages.json.' + process.pid + '.' + crypto.randomUUID() + '.tmp');
    try {
      fs.writeFileSync(temp, JSON.stringify(rows.map(rowFields), null, 2) + '\n', { encoding: 'utf8', flag: 'wx', mode: 0o600 });
      fs.renameSync(temp, file);
    } catch (error) {
      try { fs.unlinkSync(temp); } catch {}
      throw error;
    }
  };
  const allStoreFiles = () => {
    const files = [path.join(storageRoot, 'feedback-messages.json')];
    if (fs.existsSync(tenantsDir)) {
      for (const entry of fs.readdirSync(tenantsDir, { withFileTypes: true })) {
        if (entry.isDirectory() && /^[a-z0-9_-]+$/.test(entry.name)) {
          files.push(path.join(tenantsDir, entry.name, 'feedback-messages.json'));
        }
      }
    }
    return files;
  };
  const notify = async (row) => {
    if (!enabled) return { status: 'disabled' };
    if (!smtp.host || !smtp.from || !validEmail.test(recipient)) return { status: 'unconfigured' };
    const topicSubject = row.topic.replace(/[\r\n\t]+/g, ' ').slice(0, 100);
    const lines = [
      'A coach has submitted feedback through AthlyraX.',
      'Feedback ID: ' + row.id,
      'From: ' + row.createdBy,
      'Role: ' + row.createdRole,
      'Tenant: ' + row.tenantKey,
      'Submitted: ' + row.createdAt,
      'Topic: ' + row.topic,
      '',
      row.description,
      '',
      'This is a notification; the saved record remains in the owner-only Feedback Inbox.',
    ];
    try {
      await getAuthResetMailTransport().sendMail({
        from: smtp.from,
        to: recipient,
        subject: '[AthlyraX Feedback] ' + topicSubject,
        text: lines.join('\n'),
      });
      return { status: 'sent' };
    } catch (error) {
      console.error('[feedback-email] Notification failed for feedback ' + row.id + ': ' + (error instanceof Error ? error.message : String(error)));
      return { status: 'failed' };
    }
  };

  app.post('/feedback', requireStrictAuth, requireAdminRateLimit, (req, res) => {
    const topic = String(req.body?.topic || '').trim();
    const description = String(req.body?.description || '').trim();
    if (!topic || !description) {
      res.status(400).json({ error: 'Topic and description are required.' });
      return;
    }
    if (topic.length > 200 || description.length > 4000) {
      res.status(400).json({ error: 'Topic must be at most 200 characters and description at most 4000 characters.' });
      return;
    }
    const storagePaths = resolveStoragePathsForAuth(req.auth);
    const file = rowPath(storagePaths);
    const row = {
      id: crypto.randomUUID(), topic, description, status: 'pending', decision: '',
      decisionBy: '', decisionAt: '', createdBy: String(req.auth?.username || '').trim(),
      createdRole: String(req.auth?.role || '').trim(), createdAt: new Date().toISOString(),
      tenantKey: String(storagePaths.tenantKey || '').trim(),
    };
    enqueueWrite(async () => {
      const rows = read(file);
      rows.unshift(row);
      write(file, rows);
    }).then(async () => {
      appendAuthAuditEvent({ action: 'feedback_submitted', req, status: 'success', target: row.id, details: { tenantKey: row.tenantKey } });
      // Feedback has already been durably saved. Email failure is reported separately.
      const notification = await notify(row);
      res.status(201).json({ ok: true, row: rowFields(row), notification });
    }).catch((error) => {
      console.error('[feedback] Save failed:', error instanceof Error ? error.message : String(error));
      res.status(500).json({ error: 'Could not save feedback message.' });
    });
  });

  app.get('/feedback', requireStrictAuth, (req, res) => {
    if (!isPrimarySoftwareOwnerAccount(req.auth)) {
      res.status(403).json({ error: 'Feedback inbox is restricted to the primary software owner.' });
      return;
    }
    try {
      const rows = allStoreFiles().flatMap((file) => read(file));
      rows.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      res.status(200).json({ ok: true, rows });
    } catch (error) {
      console.error('[feedback] Inbox read failed:', error instanceof Error ? error.message : String(error));
      res.status(503).json({ error: 'Feedback inbox is temporarily unavailable.' });
    }
  });

  app.patch('/feedback/:id/decision', requireStrictAuth, requireAdminRateLimit, (req, res) => {
    if (!isPrimarySoftwareOwnerAccount(req.auth)) {
      res.status(403).json({ error: 'Only the primary software owner can triage feedback.' });
      return;
    }
    const id = String(req.params?.id || '').trim();
    const decision = String(req.body?.decision || '').trim().toLowerCase();
    if (!id || !['fix', 'archive'].includes(decision)) {
      res.status(400).json({ error: 'Valid feedback id and decision (fix/archive) are required.' });
      return;
    }
    enqueueWrite(async () => {
      for (const file of allStoreFiles()) {
        const rows = read(file);
        const match = rows.find((row) => row.id === id);
        if (!match) continue;
        match.status = decision === 'archive' ? 'archived' : 'fix';
        match.decision = decision;
        match.decisionBy = String(req.auth?.username || '').trim();
        match.decisionAt = new Date().toISOString();
        write(file, rows);
        return match;
      }
      return null;
    }).then((row) => {
      if (!row) {
        res.status(404).json({ error: 'Feedback message not found.' });
        return;
      }
      appendAuthAuditEvent({ action: 'feedback_triaged', req, status: 'success', target: id, details: { decision } });
      res.status(200).json({ ok: true, row });
    }).catch((error) => {
      console.error('[feedback] Triage failed:', error instanceof Error ? error.message : String(error));
      res.status(500).json({ error: 'Could not update feedback decision.' });
    });
  });
}
