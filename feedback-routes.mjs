import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// Mounted by the guarded production build. No feedback is kept in the training DB.
// Coach submissions stay in their own tenant; only primary owner may read all tenants.
export function installFeedbackRoutes(app, {
  requireStrictAuth, requireSoftwareOwnerRole, requireAdminRateLimit,
  resolveStoragePathsForAuth, isPrimarySoftwareOwnerAccount,
  enqueueWrite, writeAtomicJsonFile, getAuthResetMailTransport,
  storageRoot, smtpHost, smtpFrom, validEmail,
  feedbackRecipient = 'AthlyraX@outlook.com',
}) {
  const root = path.resolve(storageRoot);
  const tenantRoot = path.join(root, 'tenants');
  const globalFile = path.join(root, 'feedback-messages.json');
  const recipient = String(feedbackRecipient || '').trim();
  const clean = (value) => String(value ?? '').trim();

  const readRows = (filePath) => {
    if (!fs.existsSync(filePath)) return [];
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const rows = Array.isArray(raw) ? raw : raw?.rows;
    if (!Array.isArray(rows)) throw new Error('Feedback file is invalid: refusing to discard any prior messages.');
    return rows.filter((row) => row && typeof row === 'object' && clean(row.id));
  };

  const forAuth = (auth) => {
    const storage = resolveStoragePathsForAuth(auth);
    const dbPath = path.resolve(storage.dbPath);
    const dir = path.dirname(dbPath);
    if (!(dir === root || dir.startsWith(tenantRoot + path.sep))) throw new Error('Unsafe feedback storage scope.');
    return { dbPath, feedbackPath: path.join(dir, 'feedback-messages.json'), tenantKey: clean(storage.tenantKey) };
  };
  const ownerTargets = () => {
    const targets = [globalFile];
    if (fs.existsSync(tenantRoot)) {
      for (const entry of fs.readdirSync(tenantRoot, { withFileTypes: true })) {
        if (!entry.isDirectory() || !/^[a-z0-9_-]+$/.test(entry.name)) continue;
        const filePath = path.join(tenantRoot, entry.name, 'feedback-messages.json');
        if (filePath !== globalFile) targets.push(filePath);
      }
    }
    return targets;
  };
  const sendEmail = async (row) => {
    if (String(process.env.FEEDBACK_EMAIL_NOTIFICATIONS_ENABLED || 'true').toLowerCase() === 'false') return 'disabled';
    if (!smtpHost || !smtpFrom || !validEmail.test(recipient)) return 'not-configured';
    try {
      const transport = getAuthResetMailTransport();
      await transport.sendMail({
        from: smtpFrom, to: recipient,
        subject: 'AthlyraX coach feedback received',
        text: [
          'New AthlyraX feedback (saved in the owner-only inbox).', '',
          'Coach: ' + row.createdBy,
          'Role: ' + row.createdRole,
          'Tenant: ' + row.tenantKey,
          'Date: ' + row.createdAt,
          'Topic: ' + row.topic,
          '', 'Description:', row.description, '',
          'Feedback ID: ' + row.id,
          'Sign in as the primary software owner to triage the message.',
        ].join('\n'),
      });
      return 'sent';
    } catch (error) {
      // Saved feedback is authoritative: mail must never roll back a durable write.
      console.error('[feedback] Email delivery failed for saved message', row.id, String(error?.code || 'smtp-error'));
      return 'failed';
    }
  };

  app.post('/feedback', requireStrictAuth, (req, res) => {
    const topic = clean(req.body?.topic);
    const description = clean(req.body?.description);
    if (!topic || !description) return res.status(400).json({ error: 'Topic and description are required.' });
    if (topic.length > 200 || description.length > 4000) {
      return res.status(400).json({ error: 'Topic must not exceed 200 characters; description must not exceed 4000.' });
    }
    let target;
    try { target = forAuth(req.auth); } catch { return res.status(403).json({ error: 'Invalid feedback tenant scope.' }); }
    if (!fs.existsSync(target.dbPath)) {
      return res.status(503).json({ error: 'Tenant data unavailable. Feedback not submitted; retry when the account is restored.' });
    }
    const row = {
      id: crypto.randomUUID(), topic, description,
      status: 'pending', decision: '', decisionBy: '', decisionAt: '',
      createdBy: clean(req.auth?.username), createdRole: clean(req.auth?.role),
      createdAt: new Date().toISOString(), tenantKey: target.tenantKey,
    };
    enqueueWrite(async () => {
      const rows = readRows(target.feedbackPath);
      rows.unshift(row);
      writeAtomicJsonFile(target.feedbackPath, rows);
    }).then(async () => {
      const notification = await sendEmail(row);
      return res.status(201).json({ ok: true, row, notification });
    }).catch((error) => {
      console.error('[feedback] Persistence failure', String(error?.code || 'write-error'));
      return res.status(500).json({ error: 'Could not save feedback message.' });
    });
  });

  app.get('/feedback', requireStrictAuth, (req, res) => {
    // Coach UI may request this endpoint when opening the feedback form.
    // Return a benign empty list instead of 403; never reveal another coach's messages.
    if (!isPrimarySoftwareOwnerAccount(req.auth)) {
      return res.status(200).json({ ok: true, rows: [], inboxAccess: 'owner-only' });
    }
    try {
      const rows = ownerTargets().flatMap((filePath) => readRows(filePath))
        .sort((a, b) => clean(b.createdAt).localeCompare(clean(a.createdAt)));
      return res.status(200).json({ ok: true, rows, inboxAccess: 'owner' });
    } catch {
      return res.status(503).json({ error: 'Feedback inbox temporarily unavailable. No messages have been discarded.' });
    }
  });

  app.patch('/feedback/:id/decision', requireStrictAuth, requireSoftwareOwnerRole, requireAdminRateLimit, (req, res) => {
    if (!isPrimarySoftwareOwnerAccount(req.auth)) return res.status(403).json({ error: 'Owner access required.' });
    const id = clean(req.params?.id);
    const decision = clean(req.body?.decision).toLowerCase();
    if (!id || !['fix', 'archive'].includes(decision)) {
      return res.status(400).json({ error: 'Feedback ID and a fix/archive decision are required.' });
    }
    enqueueWrite(async () => {
      for (const filePath of ownerTargets()) {
        const rows = readRows(filePath);
        const index = rows.findIndex((row) => clean(row.id) === id);
        if (index < 0) continue;
        const row = { ...rows[index], status: decision === 'fix' ? 'fix-queued' : 'archived',
          decision, decisionBy: clean(req.auth?.username), decisionAt: new Date().toISOString() };
        rows[index] = row;
        writeAtomicJsonFile(filePath, rows);
        return row;
      }
      return null;
    }).then((row) => row ? res.status(200).json({ ok: true, row }) :
      res.status(404).json({ error: 'Feedback message not found.' }))
      .catch(() => res.status(500).json({ error: 'Could not update feedback decision.' }));
  });
}
