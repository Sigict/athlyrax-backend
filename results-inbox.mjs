// Results inbox: the Stopwatch, Assistant and Video apps send an AthlyraX results file to the
// signed-in coach's club. Nothing is written into sessions here: the coach reviews each file in
// Session Results and imports it with the normal save. Sending the same results twice is a no-op.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const RESULTS_INBOX_MAX_BYTES = 2 * 1024 * 1024;
export const RESULTS_INBOX_MAX_RESULTS = 2000;
export const RESULTS_INBOX_MAX_ITEMS = 500;
const SOURCES = new Set(['console', 'stopwatch', 'assistant', 'video']);
const STATUSES = new Set(['new', 'imported', 'dismissed']);

const text = (value, max = 200) => String(value ?? '').trim().slice(0, max);

/** Stable fingerprint of the measurements themselves, so re-sending or re-exporting the same results is detected. */
export function resultsFingerprint(file) {
	const rows = (Array.isArray(file?.results) ? file.results : [])
		.map((r) => [text(r?.swimmer?.id) || text(r?.swimmer?.name).toLowerCase(), Number(r?.distance) || 0, Number(r?.rep) || 0,
			Number(r?.time?.seconds) || 0, text(r?.setId || r?.setTitle), text(r?.capturedAt), text(r?.id)].join('|'))
		.sort();
	return crypto.createHash('sha256').update(`${text(file?.session?.id)}\n${rows.join('\n')}`).digest('hex');
}

/** Validates an incoming AthlyraX results file. Returns { ok, error, summary }. */
export function validateResultsFile(file) {
	if (!file || typeof file !== 'object' || Array.isArray(file)) return { ok: false, error: 'Expected an AthlyraX results file.' };
	if (file.format !== 'athlyrax-results-file') return { ok: false, error: 'Not an AthlyraX results file.' };
	if (!Array.isArray(file.results)) return { ok: false, error: 'The results file has no results.' };
	if (file.results.length < 1) return { ok: false, error: 'The results file is empty.' };
	if (file.results.length > RESULTS_INBOX_MAX_RESULTS) return { ok: false, error: `A results file can hold at most ${RESULTS_INBOX_MAX_RESULTS} results.` };
	const bad = file.results.findIndex((r) => !r || r.format !== 'athlyrax-swim-result' || !(Number(r?.time?.seconds) > 0) || !(text(r?.swimmer?.id) || text(r?.swimmer?.name)));
	if (bad >= 0) return { ok: false, error: `Result ${bad + 1} is not a valid swim result (swimmer and time are required).` };
	const swimmers = new Set(file.results.map((r) => text(r.swimmer?.id) || text(r.swimmer?.name).toLowerCase()));
	const sources = new Set(file.results.map((r) => text(r.source, 40)).filter((s) => SOURCES.has(s)));
	const dates = file.results.map((r) => text(r.capturedAt, 40).slice(0, 10)).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort();
	return {
		ok: true,
		summary: {
			resultCount: file.results.length,
			swimmerCount: swimmers.size,
			sources: [...sources],
			sessionId: text(file.session?.id, 120),
			sessionTitle: text(file.session?.title, 160),
			sessionDate: text(file.session?.date, 20) || dates[0] || '',
			firstDate: dates[0] || '',
			lastDate: dates[dates.length - 1] || '',
			waitingForReview: file.results.filter((r) => r.review?.status === 'needs-review').length,
		},
	};
}

export function registerResultsInbox(app, deps) {
	const { storageRoot, requireStrictAuth, requireWriteRole, resolveTenantId } = deps;
	const root = path.join(storageRoot, 'results-inbox');
	const tenantDir = (tenantId) => path.join(root, crypto.createHash('sha256').update(String(tenantId)).digest('hex').slice(0, 32));
	const idPattern = /^[a-f0-9]{24}$/;

	function readIndex(dir) {
		try { const parsed = JSON.parse(fs.readFileSync(path.join(dir, 'index.json'), 'utf8')); return Array.isArray(parsed) ? parsed : []; } catch { return []; }
	}
	function writeAtomic(file, value) {
		fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
		const tmp = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
		fs.writeFileSync(tmp, JSON.stringify(value), { mode: 0o600, flag: 'wx' });
		fs.renameSync(tmp, file);
	}
	function tenantOf(req, res) {
		const tenantId = text(resolveTenantId(req), 200);
		if (!tenantId || tenantId === 'global-owner') {
			res.status(403).json({ error: 'Sign in with a club coach account to use the Results inbox.' });
			return '';
		}
		return tenantId;
	}
	// Writes for one club are serialised so concurrent sends never lose an index entry.
	const queues = new Map();
	function serial(key, fn) {
		const prev = queues.get(key) || Promise.resolve();
		const next = prev.then(fn, fn);
		queues.set(key, next.catch(() => {}));
		return next;
	}

	app.post('/results-inbox', requireStrictAuth, requireWriteRole, (req, res) => {
		const tenantId = tenantOf(req, res); if (!tenantId) return;
		const file = req.body?.file;
		let size = 0;
		try { size = Buffer.byteLength(JSON.stringify(file ?? null)); } catch { size = Infinity; }
		if (size > RESULTS_INBOX_MAX_BYTES) { res.status(413).json({ error: 'The results file is larger than 2 MB.' }); return; }
		const check = validateResultsFile(file);
		if (!check.ok) { res.status(400).json({ error: check.error }); return; }
		const fingerprint = resultsFingerprint(file);
		const dir = tenantDir(tenantId);
		serial(dir, () => {
			const index = readIndex(dir);
			const existing = index.find((row) => row.fingerprint === fingerprint);
			if (existing) return { status: 200, body: { ok: true, duplicate: true, item: existing } };
			if (index.filter((row) => row.status === 'new').length >= RESULTS_INBOX_MAX_ITEMS) {
				return { status: 409, body: { error: 'The Results inbox is full. Import or dismiss older items first.' } };
			}
			const id = crypto.randomBytes(12).toString('hex');
			const item = {
				id, fingerprint, status: 'new', createdAt: new Date().toISOString(),
				sentBy: text(req.auth?.username, 120), app: SOURCES.has(text(req.body?.app, 40)) ? text(req.body.app, 40) : (check.summary.sources[0] || 'console'),
				...check.summary,
			};
			writeAtomic(path.join(dir, `${id}.json`), file);
			writeAtomic(path.join(dir, 'index.json'), [item, ...index]);
			return { status: 201, body: { ok: true, duplicate: false, item } };
		}).then((out) => res.status(out.status).json(out.body))
			.catch(() => res.status(500).json({ error: 'Could not save the results. Keep the downloaded file and try again.' }));
	});

	app.get('/results-inbox', requireStrictAuth, requireWriteRole, (req, res) => {
		const tenantId = tenantOf(req, res); if (!tenantId) return;
		const status = text(req.query?.status, 20);
		const items = readIndex(tenantDir(tenantId)).filter((row) => !status || row.status === status);
		res.set('Cache-Control', 'no-store');
		res.status(200).json({ ok: true, items });
	});

	app.get('/results-inbox/:id', requireStrictAuth, requireWriteRole, (req, res) => {
		const tenantId = tenantOf(req, res); if (!tenantId) return;
		const id = text(req.params.id, 40);
		if (!idPattern.test(id)) { res.status(404).json({ error: 'Not found.' }); return; }
		const dir = tenantDir(tenantId);
		const item = readIndex(dir).find((row) => row.id === id);
		if (!item) { res.status(404).json({ error: 'Not found.' }); return; }
		try {
			const file = JSON.parse(fs.readFileSync(path.join(dir, `${id}.json`), 'utf8'));
			res.set('Cache-Control', 'no-store');
			res.status(200).json({ ok: true, item, file });
		} catch { res.status(404).json({ error: 'Not found.' }); }
	});

	app.post('/results-inbox/:id/status', requireStrictAuth, requireWriteRole, (req, res) => {
		const tenantId = tenantOf(req, res); if (!tenantId) return;
		const id = text(req.params.id, 40);
		const status = text(req.body?.status, 20);
		if (!idPattern.test(id)) { res.status(404).json({ error: 'Not found.' }); return; }
		if (!STATUSES.has(status) || status === 'new') { res.status(400).json({ error: 'Status must be imported or dismissed.' }); return; }
		const dir = tenantDir(tenantId);
		serial(dir, () => {
			const index = readIndex(dir);
			const at = index.findIndex((row) => row.id === id);
			if (at < 0) return { status: 404, body: { error: 'Not found.' } };
			const item = { ...index[at], status, [`${status}At`]: new Date().toISOString(), [`${status}By`]: text(req.auth?.username, 120) };
			if (status === 'imported') item.importedSessionId = text(req.body?.sessionId, 120);
			index[at] = item;
			writeAtomic(path.join(dir, 'index.json'), index);
			return { status: 200, body: { ok: true, item } };
		}).then((out) => res.status(out.status).json(out.body))
			.catch(() => res.status(500).json({ error: 'Could not update the item.' }));
	});
}
