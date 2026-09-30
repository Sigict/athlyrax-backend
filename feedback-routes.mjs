import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const clean = (value, max = 4000) => String(value ?? '').trim().slice(0, max);
const safeRows = (payload, tenantKey = '') => {
  const rows = Array.isArray(payload) ? payload : (Array.isArray(payload?.rows) ? payload.rows : []);
  return rows.filter((row) => row && typeof row === 'object' && clean(row.id, 150)).map((row) => {
    const decision = clean(row.decision, 20).toLowerCase();
    return {
      id: clean(row.id, 150),
      topic: clean(row.topic, 200),
      description: clean(row.description, 4000),
      status: clean(row.status || (decision === 'fix' ? 'fix-queued' : decision === 'archive' ? 'archived' : 'pending'), 40),
      decision: ['fix', 'archive'].includes(decision) ? decision : '',
      decisionBy: clean(row.decisionBy, 100),
      decisionAt: clean(row.decisionAt, 60),
      createdBy: clean(row.createdBy, 100),
      createdRole: clean(row.createdRole, 60),
      createdAt: clean(row.createdAt, 60),
      tenantKey: clean(row.tenantKey || tenantKey, 120),
    };
  }).sort((a,b) => b.createdAt.localeCompare(a.createdAt));
};

export function registerFeedbackRoutes({
  app, requireStrictAuth, requireAdminRateLimit, isPrimarySoftwareOwnerAccount,
  resolveStoragePathsForAuth, readJsonFile, writeAtomicJsonFile, enqueueWrite,
  appendAuthAuditEvent, storageRoot, getMailTransport,
  smtpHost = '', smtpFrom = '', notifyTo = 'AthlyraX@outlook.com',
}) {
  if (!app || typeof app.post !== 'function' || typeof app.get !== 'function') throw new Error('Feedback requires an Express app');
  const globalFile = path.join(storageRoot, 'feedback-messages.json');
  const tenantsRoot = path.join(storageRoot, 'tenants');
  const read = (filePath, tenantKey) => safeRows(readJsonFile(filePath), tenantKey);
  const resolveFile = (auth) => {
    const storage = resolveStoragePathsForAuth(auth);
    // Use the SAME canonical per-tenant directory as the authenticated /db route.
    const file = storage.dbPath && storage.dbPath !== path.join(storageRoot, 'db.json')
      ? path.join(path.dirname(storage.dbPath), 'feedback-messages.json') : globalFile;
    return { file, tenantKey: clean(storage.tenantKey, 120) || 'global-owner' };
  };
  const allTargets = () => {
    const targets = [{ file: globalFile, tenantKey: 'global-owner' }];
    if (fs.existsSync(tenantsRoot)) {
      for (const entry of fs.readdirSync(tenantsRoot, { withFileTypes: true })) {
        if (!entry.isDirectory() || !/^[a-z0-9_-]+$/.test(entry.name)) continue;
        targets.push({ file: path.join(tenantsRoot, entry.name, 'feedback-messages.json'), tenantKey: entry.name });
      }
    }
    return targets;
  };
  const owner = (req) => isPrimarySoftwareOwnerAccount(req.auth);
  const recipients = clean(notifyTo, 320);
  const sendNotification = async (row) => {
    if (!smtpHost || !smtpFrom || !recipients || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipients)) return 'not-configured';
    try {
      await getMailTransport().sendMail({
        from: smtpFrom,
        to: recipients,
        subject: 'AthlyraX feedback received [' + row.id.slice(0, 8) + ']',
        text: [
          'New AthlyraX feedback', '',
          'Submitted by: ' + row.createdBy,
          'Role: ' + row.createdRole,
          'Tenant: ' + row.tenantKey,
          'Date (UTC): ' + row.createdAt,
          'Reference: ' + row.id,
          'Topic: ' + row.topic, '', row.description, '',
          'The original submission is stored in the owner feedback inbox.',
        ].join('\n'),
      });
      return 'sent';
    } catch (error) {
      // Storage has already committed; an SMTP problem must never lose coach feedback.
      console.error('[feedback] Notification delivery failed:', error instanceof Error ? error.message : 'Unknown SMTP error');
      return 'failed';
    }
  };

  app.post('/feedback', requireStrictAuth, (req, res) => {
    const topic = clean(req.body?.topic, 201);
    const description = clean(req.body?.description, 4001);
    if (!topic || !description) return res.status(400).json({ error: 'Topic and description are required.' });
    if (topic.length > 200 || description.length > 4000) return res.status(400).json({ error: 'Feedback exceeds the maximum permitted length.' });
    const { file, tenantKey } = resolveFile(req.auth);
    const row = {
      id: crypto.randomUUID(), topic, description, status: 'pending',
      decision: '', decisionBy: '', decisionAt: '',
      createdBy: clean(req.auth?.username, 100), createdRole: clean(req.auth?.role, 60),
      createdAt: new Date().toISOString(), tenantKey,
    };
    enqueueWrite(async () => {
      const rows = read(file, tenantKey);
      rows.unshift(row);
      writeAtomicJsonFile(file, safeRows(rows, tenantKey));
    }).then(async () => {
      appendAuthAuditEvent({ action: 'feedback_submitted', req, status: 'success', target: row.id, details: { tenantKey } });
      const emailNotification = await sendNotification(row);
      res.status(201).json({ ok: true, row, emailNotification });
    }).catch((error) => {
      console.error('[feedback] Persistence failed:', error instanceof Error ? error.message : 'Unknown error');
      res.status(500).json({ error: 'Could not save feedback message.' });
    });
  });

  app.get('/feedback', requireStrictAuth, (req, res) => {
    // Coaches may access the form, but must never see any owner's/other tenant's inbox.
    if (!owner(req)) return res.status(200).json({ ok: true, rows: [], ownerOnly: true });
    try {
      const rows = allTargets().flatMap((target) => read(target.file, target.tenantKey));
      res.status(200).json({ ok: true, rows: safeRows(rows) });
    } catch (error) {
      console.error('[feedback] Inbox read failed:', error instanceof Error ? error.message : 'Unknown error');
      res.status(500).json({ error: 'Could not load feedback messages.' });
    }
  });

  app.patch('/feedback/:id/decision', requireStrictAuth, requireAdminRateLimit, (req, res) => {
    if (!owner(req)) return res.status(403).json({ error: 'Owner-only action.' });
    const id = clean(req.params?.id, 150);
    const decision = clean(req.body?.decision, 20).toLowerCase();
    if (!id || !['fix', 'archive'].includes(decision)) return res.status(400).json({ error: 'Feedback id and valid decision are required.' });
    enqueueWrite(async () => {
      for (const target of allTargets()) {
        const rows = read(target.file, target.tenantKey);
        const index = rows.findIndex((row) => row.id === id);
        if (index < 0) continue;
        const next = {
          ...rows[index], decision, status: decision === 'fix' ? 'fix-queued' : 'archived',
          decisionBy: clean(req.auth?.username, 100), decisionAt: new Date().toISOString(),
        };
        rows[index] = next;
        writeAtomicJsonFile(target.file, safeRows(rows, target.tenantKey));
        return next;
      }
      return null;
    }).then((row) => {
      if (!row) return res.status(404).json({ error: 'Feedback message not found.' });
      appendAuthAuditEvent({ action: 'feedback_triaged', req, status: 'success', target: row.id, details: { decision } });
      res.status(200).json({ ok: true, row });
    }).catch((error) => {
      console.error('[feedback] Owner decision save failed:', error instanceof Error ? error.message : 'Unknown error');
      res.status(500).json({ error: 'Could not update feedback decision.' });
    });
  });
}
