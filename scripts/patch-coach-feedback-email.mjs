import fs from 'node:fs';
import path from 'node:path';

// Install the same feedback contract in the *built* backend. Production executes
// build-production-backend.mjs, so editing the unbuilt index.js is not sufficient.
const indexPath = path.resolve('index.js');
let source = fs.readFileSync(indexPath, 'utf8').replace(/\r\n/g, '\n');
const marker = '// ATHLYRAX_COACH_FEEDBACK_EMAIL_V1';
const anchor = '// Serve db.json at /db';
if (!source.includes(anchor)) throw new Error('Canonical /db route anchor absent');
if (source.includes(marker)) {
  console.log('COACH_FEEDBACK_EMAIL_ALREADY_INSTALLED');
  process.exit(0);
}
if (source.includes("app.post('/feedback',") || source.includes("app.get('/feedback',")) {
  throw new Error('A feedback route already exists; reconcile routes instead of duplicating them.');
}

const patch = String.raw`// ATHLYRAX_COACH_FEEDBACK_EMAIL_V1
// Submissions are stored in their own tenant, separate from the main db.json.
const FEEDBACK_NOTIFICATION_RECIPIENT = String(process.env.FEEDBACK_NOTIFICATION_EMAIL || 'AthlyraX@outlook.com').trim();
const FEEDBACK_MESSAGES_FILENAME = 'feedback-messages.json';
const feedbackPathForTenant = (storagePaths) => path.join(path.dirname(storagePaths.dbPath), FEEDBACK_MESSAGES_FILENAME);
const feedbackStoredRows = (filePath) => {
	const payload = readJsonFile(filePath);
	return Array.isArray(payload) ? payload.filter((item) => item && typeof item === 'object') :
		(Array.isArray(payload?.rows) ? payload.rows.filter((item) => item && typeof item === 'object') : []);
};

async function notifyFeedbackRecipient(row) {
	if (!AUTH_SMTP_HOST || !AUTH_SMTP_FROM || !AUTH_SMTP_USER || !AUTH_SMTP_PASS) {
		return 'not_configured';
	}
	if (!AUTH_EMAIL_PATTERN.test(FEEDBACK_NOTIFICATION_RECIPIENT)) return 'invalid_recipient';
	try {
		await getAuthResetMailTransport().sendMail({
			from: AUTH_SMTP_FROM,
			to: FEEDBACK_NOTIFICATION_RECIPIENT,
			subject: 'AthlyraX coach feedback: ' + row.topic.replace(/[\r\n]+/g, ' ').slice(0, 130),
			text: [
				'New AthlyraX feedback submitted and stored.',
				'',
				'Coach: ' + row.createdBy,
				'Role: ' + row.createdRole,
				'Tenant: ' + row.tenantKey,
				'Date: ' + row.createdAt,
				'Topic: ' + row.topic,
				'Feedback ID: ' + row.id,
				'',
				'Description:',
				row.description,
				'',
				'The original remains in the software-owner Feedback Inbox.',
			].join('\n'),
		});
		return 'sent';
	} catch (error) {
		// Email is a notification, not the persistence authority.
		console.error('[feedback] Stored feedback notification delivery failed:', error instanceof Error ? error.message : 'unknown SMTP error');
		return 'failed';
	}
}

// A coach may submit feedback, but may not view the owner inbox. Return the
// *empty* safe view expected by the shared frontend, not a noisy 403.
app.get('/feedback', requireStrictAuth, (req, res) => {
	if (!isPrimarySoftwareOwnerAccount(req.auth)) {
		res.status(200).json({ ok: true, rows: [], canViewInbox: false });
		return;
	}
	const files = [path.join(STORAGE_ROOT, FEEDBACK_MESSAGES_FILENAME)];
	if (fs.existsSync(DB_TENANTS_DIR)) {
		for (const entry of fs.readdirSync(DB_TENANTS_DIR, { withFileTypes: true })) {
			if (!entry.isDirectory() || !/^[a-z0-9_-]+$/.test(entry.name)) continue;
			files.push(path.join(DB_TENANTS_DIR, entry.name, FEEDBACK_MESSAGES_FILENAME));
		}
	}
	const rows = files.flatMap((filePath) => feedbackStoredRows(filePath))
		.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
	res.status(200).json({ ok: true, rows, canViewInbox: true });
});

app.post('/feedback', requireStrictAuth, requireAdminRateLimit, async (req, res) => {
	const topic = String(req.body?.topic || '').trim();
	const description = String(req.body?.description || '').trim();
	if (!topic || !description) {
		res.status(400).json({ error: 'Topic and description are required.' });
		return;
	}
	if (topic.length > 200 || description.length > 4000) {
		res.status(400).json({ error: 'Feedback exceeds maximum length (topic 200, description 4000).' });
		return;
	}
	const paths = resolveStoragePathsForAuth(req.auth);
	if (!paths?.dbPath || !fs.existsSync(paths.dbPath)) {
		res.status(503).json({ error: 'Tenant storage is temporarily unavailable. Feedback not accepted.' });
		return;
	}
	const row = {
		id: crypto.randomUUID(),
		topic, description,
		status: 'pending',
		decision: '', decisionBy: '', decisionAt: '',
		createdBy: String(req.auth?.username || '').trim(),
		createdRole: String(req.auth?.role || '').trim(),
		createdAt: new Date().toISOString(),
		tenantKey: String(paths.tenantKey || '').trim(),
	};
	const feedbackPath = feedbackPathForTenant(paths);
	try {
		await enqueueWrite(async () => {
			const rows = feedbackStoredRows(feedbackPath);
			rows.unshift(row);
			writeAtomicJsonFile(feedbackPath, rows);
		});
	} catch (error) {
		console.error('[feedback] Could not persist feedback:', error instanceof Error ? error.message : 'unknown error');
		res.status(500).json({ error: 'Could not save feedback message.' });
		return;
	}
	appendAuthAuditEvent({ action: 'feedback_submitted', req, status: 'success', target: row.id, details: { tenantKey: row.tenantKey } });
	const notification = await notifyFeedbackRecipient(row);
	res.status(201).json({ ok: true, row, notification });
});

app.patch('/feedback/:id/decision', requireStrictAuth, requireSoftwareOwnerRole, requireAdminRateLimit, async (req, res) => {
	if (!isPrimarySoftwareOwnerAccount(req.auth)) {
		res.status(403).json({ error: 'Only the primary software owner can review feedback.' });
		return;
	}
	const id = String(req.params?.id || '').trim();
	const decision = String(req.body?.decision || '').trim().toLowerCase();
	if (!id || !['accepted', 'rejected', 'deferred', 'pending'].includes(decision)) {
		res.status(400).json({ error: 'Valid feedback id and decision required.' });
		return;
	}
	const files = [path.join(STORAGE_ROOT, FEEDBACK_MESSAGES_FILENAME)];
	if (fs.existsSync(DB_TENANTS_DIR)) {
		for (const entry of fs.readdirSync(DB_TENANTS_DIR, { withFileTypes: true })) {
			if (!entry.isDirectory() || !/^[a-z0-9_-]+$/.test(entry.name)) continue;
			files.push(path.join(DB_TENANTS_DIR, entry.name, FEEDBACK_MESSAGES_FILENAME));
		}
	}
	let updated = null;
	try {
		await enqueueWrite(async () => {
			for (const filePath of files) {
				if (!fs.existsSync(filePath)) continue;
				const rows = feedbackStoredRows(filePath);
				const index = rows.findIndex((item) => String(item.id) === id);
				if (index < 0) continue;
				rows[index] = { ...rows[index], decision, status: decision, decisionBy: String(req.auth?.username || ''), decisionAt: new Date().toISOString() };
				writeAtomicJsonFile(filePath, rows);
				updated = rows[index];
				break;
			}
		});
		if (!updated) return res.status(404).json({ error: 'Feedback message not found.' });
		appendAuthAuditEvent({ action: 'feedback_triaged', req, status: 'success', target: id });
		res.status(200).json({ ok: true, row: updated });
	} catch (error) {
		console.error('[feedback] Feedback decision failed:', error instanceof Error ? error.message : 'unknown error');
		res.status(500).json({ error: 'Could not update feedback decision.' });
	}
});

`;
source = source.replace(anchor, patch + anchor);
for (const required of [
  marker, "app.post('/feedback',", "app.get('/feedback',",
  "app.patch('/feedback/:id/decision',",
  "FEEDBACK_NOTIFICATION_EMAIL || 'AthlyraX@outlook.com'",
  "res.status(200).json({ ok: true, rows: [], canViewInbox: false })",
  "const notification = await notifyFeedbackRecipient(row)",
]) if (!source.includes(required)) throw new Error('Feedback patch contract missing: ' + required);
fs.writeFileSync(indexPath, source, 'utf8');
console.log('COACH_FEEDBACK_EMAIL_INSTALLED');
