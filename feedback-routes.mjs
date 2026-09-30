import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// Feedback is separate from swimmer/session DB records. Every submission is durable
// before email delivery is attempted. SMTP outage must not lose a coach's message.
export function installFeedbackRoutes({
  app, requireStrictAuth, resolveStoragePathsForAuth,
  isPrimarySoftwareOwnerAccount, enqueueWrite, writeAtomicJsonFile,
  getAuthResetMailTransport, smtpHost, smtpFrom, storageRoot,
  authUserLookup = () => null, appendAuthAuditEvent = () => {},
  retryIntervalMs = 300000,
  notifyEmail = process.env.FEEDBACK_NOTIFY_EMAIL || 'AthlyraX@outlook.com',
}) {
  const recipient = String(notifyEmail || '').trim();
  const smtpReady = Boolean(smtpHost && smtpFrom && recipient);
  const sending = new Set();
  const tenantRoot = path.join(storageRoot, 'tenants');
  const ownPath = path.join(storageRoot, 'feedback-messages.json');
  const rateLimit = new Map();

  function feedbackPath(tenantKey) {
    const key = String(tenantKey || '').trim();
    if (!key || key === 'global-owner' || key === 'global') return ownPath;
    if (!/^[a-z0-9_-]+$/.test(key)) throw new Error('Invalid feedback tenant scope.');
    return path.join(tenantRoot, key, 'feedback-messages.json');
  }

  function rowsAt(filePath) {
    if (!fs.existsSync(filePath)) return [];
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const rows = Array.isArray(parsed) ? parsed : parsed?.rows;
    if (!Array.isArray(rows)) throw new Error('Feedback store is not a valid array; existing records were preserved.');
    return rows;
  }

  function allFeedbackFiles() {
    const paths = [ownPath];
    if (fs.existsSync(tenantRoot)) {
      for (const entry of fs.readdirSync(tenantRoot, { withFileTypes: true })) {
        if (!entry.isDirectory() || !/^[a-z0-9_-]+$/.test(entry.name)) continue;
        paths.push(feedbackPath(entry.name));
      }
    }
    return paths;
  }

  function sanitizeSubject(value) {
    return String(value || '').replace(/[\r\n]+/g, ' ').slice(0, 160);
  }

  async function notify(filePath, id) {
    if (!smtpReady || sending.has(id)) return;
    sending.add(id);
    try {
      const row = rowsAt(filePath).find((item) => item?.id === id);
      if (!row || row.notifiedAt || row.notificationStatus === 'sent') return;
      const body = [
        'New AthlyraX coach feedback',
        '',
        'From: ' + row.createdBy + ' (' + row.createdRole + ')',
        'Club: ' + (row.clubId || 'Not provided'),
        'Tenant: ' + row.tenantKey,
        'Date: ' + row.createdAt,
        'Topic: ' + row.topic,
        '',
        row.description,
        '',
        'Feedback ID: ' + row.id,
        'The saved original is in the software-owner feedback inbox.',
      ].join('\n');
      await getAuthResetMailTransport().sendMail({
        from: smtpFrom,
        to: recipient,
        subject: '[AthlyraX Feedback] ' + sanitizeSubject(row.topic),
        text: body,
      });
      await enqueueWrite(async () => {
        const current = rowsAt(filePath);
        const original = current.find((item) => item?.id === id);
        if (!original || original.notifiedAt) return;
        original.notificationStatus = 'sent';
        original.notifiedAt = new Date().toISOString();
        writeAtomicJsonFile(filePath, current);
      });
    } catch (error) {
      // Retain 'pending' so the retry worker can deliver once SMTP is available.
      console.error('[feedback] notification delivery deferred:', error instanceof Error ? error.message : 'mail delivery error');
    } finally {
      sending.delete(id);
    }
  }

  async function retryPending() {
    if (!smtpReady) return;
    try {
      for (const filePath of allFeedbackFiles()) {
        for (const row of rowsAt(filePath).filter((item) => item?.id && !item?.notifiedAt && item?.notificationStatus === 'pending').slice(0, 30)) {
          await notify(filePath, row.id);
        }
      }
    } catch (error) {
      console.error('[feedback] pending notification retry deferred:', error instanceof Error ? error.message : 'read error');
    }
  }

  app.post('/feedback', requireStrictAuth, (req, res) => {
    const topic = String(req.body?.topic || '').trim();
    const description = String(req.body?.description || '').trim();
    if (!topic || !description) return res.status(400).json({ error: 'Topic and description are required.' });
    if (topic.length > 200 || description.length > 4000) return res.status(400).json({ error: 'Feedback exceeds the maximum permitted length.' });
    const actor = String(req.auth?.username || '').trim();
    const now = Date.now();
    const recent = (rateLimit.get(actor) || []).filter((time) => now - time < 60000);
    if (recent.length >= 5) return res.status(429).json({ error: 'Too many feedback submissions. Please try again shortly.' });
    recent.push(now);
    rateLimit.set(actor, recent);

    const scope = resolveStoragePathsForAuth(req.auth);
    const tenantKey = String(scope?.tenantKey || '').trim();
    let filePath;
    try { filePath = feedbackPath(tenantKey); }
    catch { return res.status(400).json({ error: 'Invalid feedback scope.' }); }
    const actorUser = authUserLookup(actor);
    const row = {
      id: crypto.randomUUID(), tenantKey, tenantId: tenantKey,
      clubId: String(actorUser?.swimClub || actorUser?.clubId || '').trim(),
      topic, description, status: 'pending', decision: '',
      decisionBy: '', decisionAt: '',
      createdBy: actor, createdRole: String(req.auth?.role || '').trim(),
      createdAt: new Date(now).toISOString(),
      notificationStatus: 'pending', notifiedAt: '',
    };
    enqueueWrite(async () => {
      const rows = rowsAt(filePath);
      rows.unshift(row);
      writeAtomicJsonFile(filePath, rows);
    }).then(() => {
      appendAuthAuditEvent({ action: 'feedback_submitted', req, status: 'success', target: row.id, details: { tenantKey } });
      res.status(201).json({ ok: true, row, emailNotification: smtpReady ? 'queued' : 'awaiting-smtp-configuration' });
      void notify(filePath, row.id);
    }).catch((error) => {
      console.error('[feedback] save failed:', error instanceof Error ? error.message : 'storage error');
      res.status(500).json({ error: 'Could not save feedback message.' });
    });
  });

  app.get('/feedback', requireStrictAuth, (req, res) => {
    // A coach can submit feedback but must never be shown another user's inbox.
    // Return a clean non-owner view so the submission UI does not show a false load failure.
    if (!isPrimarySoftwareOwnerAccount(req.auth)) {
      return res.status(200).json({ ok: true, rows: [], canViewInbox: false });
    }
    try {
      const rows = allFeedbackFiles().flatMap((filePath) => rowsAt(filePath))
        .sort((a, b) => String(b?.createdAt || '').localeCompare(String(a?.createdAt || '')));
      return res.status(200).json({ ok: true, rows, canViewInbox: true });
    } catch (error) {
      console.error('[feedback] owner inbox read failed:', error instanceof Error ? error.message : 'read error');
      return res.status(503).json({ error: 'Feedback inbox temporarily unavailable; existing messages are preserved.' });
    }
  });

  app.patch('/feedback/:id/decision', requireStrictAuth, (req, res) => {
    if (!isPrimarySoftwareOwnerAccount(req.auth)) return res.status(403).json({ error: 'Software owner only.' });
    const id = String(req.params?.id || '').trim();
    const decision = String(req.body?.decision || '').trim().toLowerCase();
    if (!id || !['fix', 'archive'].includes(decision)) return res.status(400).json({ error: 'A valid feedback ID and fix/archive decision are required.' });
    enqueueWrite(async () => {
      const paths = allFeedbackFiles();
      for (const filePath of paths) {
        const rows = rowsAt(filePath);
        const row = rows.find((item) => item?.id === id);
        if (!row) continue;
        row.decision = decision;
        row.status = decision === 'archive' ? 'archived' : 'fix';
        row.decisionBy = String(req.auth?.username || '').trim();
        row.decisionAt = new Date().toISOString();
        writeAtomicJsonFile(filePath, rows);
        return row;
      }
      return null;
    }).then((row) => {
      if (!row) return res.status(404).json({ error: 'Feedback not found.' });
      return res.status(200).json({ ok: true, row });
    }).catch(() => res.status(500).json({ error: 'Could not update feedback decision.' }));
  });

  // Delivery is at least once: if SMTP is down, the original is kept and retries
  // start after deployment/restart; never silently count email as successful.
  const worker = setInterval(() => { void retryPending(); }, Math.max(60000, Number(retryIntervalMs) || 300000));
  worker.unref?.();
  if (!smtpReady) console.warn('[feedback] SMTP notification unavailable; messages will still be saved.');
}
