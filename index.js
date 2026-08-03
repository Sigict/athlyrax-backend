/* global process, Buffer */
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import crypto from 'crypto';
import { execFileSync } from 'child_process';
import nodemailer from 'nodemailer';
import Stripe from 'stripe';
import { validateDbWritePayload } from './scripts/db-write-validation.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = Number.parseInt(process.env.PORT || '3001', 10) || 3001;
const DB_PATH = path.join(__dirname, 'storage', 'db.json');
const TARGET_BACKUP_PATH = path.join(__dirname, 'storage', 'trainingPlannerTargets.backup.json');
const DB_SNAPSHOT_DIR = path.join(__dirname, 'storage', 'db-snapshots');
const DB_TENANTS_DIR = path.join(__dirname, 'storage', 'tenants');
const BILLING_CATALOG_PATH = path.join(__dirname, 'storage', 'billing-catalog.json');
const BILLING_CATALOG_BACKUP_DIR = path.join(__dirname, 'storage', 'billing-catalog-backups');
const SHARED_AUTH_USERS_PATH = path.resolve(__dirname, '..', 'storage', 'auth', 'auth-users.json');
const AUTH_USERS_PATH = (() => {
	const overridePath = String(process.env.AUTH_USERS_PATH || '').trim();
	if (overridePath) return path.resolve(overridePath);
	return SHARED_AUTH_USERS_PATH;
})();
const AUTH_USERS_BACKUP_PATH = (() => {
	const overridePath = String(process.env.AUTH_USERS_BACKUP_PATH || '').trim();
	if (overridePath) return path.resolve(overridePath);
	return path.join(path.dirname(AUTH_USERS_PATH), 'auth-users.backup.json');
})();
const AUTH_INVITES_PATH = path.join(__dirname, 'storage', 'auth-invites.json');
const SNAPSHOT_SUBMISSIONS_PATH = path.join(__dirname, 'storage', 'snapshot-submissions.json');
const AUTH_AUDIT_DIR = path.join(__dirname, 'storage', 'auth-audit');
const AUTH_AUDIT_ACTIVE_PATH = path.join(AUTH_AUDIT_DIR, 'events.jsonl');
const AUTH_AUDIT_BACKUP_DIR = path.join(AUTH_AUDIT_DIR, 'backups');
const MAX_DB_SNAPSHOTS = 15;
const AUTH_AUDIT_MAX_BYTES = Math.max(64 * 1024, Number.parseInt(process.env.AUTH_AUDIT_MAX_BYTES || `${2 * 1024 * 1024}`, 10) || (2 * 1024 * 1024));
const AUTH_AUDIT_MAX_ARCHIVE_FILES = Math.max(1, Number.parseInt(process.env.AUTH_AUDIT_MAX_ARCHIVE_FILES || '30', 10) || 30);
const AUTH_AUDIT_FETCH_MAX_ROWS = Math.max(50, Number.parseInt(process.env.AUTH_AUDIT_FETCH_MAX_ROWS || '1000', 10) || 1000);
const AUTH_AUDIT_MAX_BACKUP_FILES = Math.max(1, Number.parseInt(process.env.AUTH_AUDIT_MAX_BACKUP_FILES || '30', 10) || 30);
const BILLING_CATALOG_MAX_BACKUP_FILES = Math.max(1, Number.parseInt(process.env.BILLING_CATALOG_MAX_BACKUP_FILES || '40', 10) || 40);
const AUTH_AUDIT_BACKUP_INTERVAL_MS = Math.max(60 * 1000, Number.parseInt(process.env.AUTH_AUDIT_BACKUP_INTERVAL_MS || `${12 * 60 * 60 * 1000}`, 10) || (12 * 60 * 60 * 1000));
const NODE_ENV = String(process.env.NODE_ENV || 'development').toLowerCase();
const IS_PRODUCTION = NODE_ENV === 'production';
const BILLING_STRICT_RECOVERY = String(process.env.BILLING_STRICT_RECOVERY || (IS_PRODUCTION ? 'true' : 'false')).toLowerCase() === 'true';
const AUTH_REQUIRED = String(process.env.AUTH_REQUIRED || 'true').toLowerCase() === 'true';
const AUTH_SECRET = String(process.env.AUTH_SECRET || 'athlyrax-dev-secret-change-me').trim();
const AUTH_TOKEN_TTL_SECONDS = Math.max(300, Number.parseInt(process.env.AUTH_TOKEN_TTL_SECONDS || '43200', 10) || 43200);
const AUTH_LOGIN_RATE_WINDOW_MS = Math.max(1000, Number.parseInt(process.env.AUTH_LOGIN_RATE_WINDOW_MS || '60000', 10) || 60000);
const AUTH_LOGIN_RATE_MAX_ATTEMPTS = Math.max(1, Number.parseInt(process.env.AUTH_LOGIN_RATE_MAX_ATTEMPTS || '8', 10) || 8);
const AUTH_ADMIN_RATE_WINDOW_MS = Math.max(1000, Number.parseInt(process.env.AUTH_ADMIN_RATE_WINDOW_MS || '60000', 10) || 60000);
const AUTH_ADMIN_RATE_MAX_ATTEMPTS = Math.max(1, Number.parseInt(process.env.AUTH_ADMIN_RATE_MAX_ATTEMPTS || '60', 10) || 60);
const AUTH_ALLOW_COACH_SIGNUP = String(process.env.AUTH_ALLOW_COACH_SIGNUP || 'false').toLowerCase() === 'true';
const AUTH_ALLOW_COACH_INVITES = String(process.env.AUTH_ALLOW_COACH_INVITES || 'true').toLowerCase() === 'true';
const AUTH_ENABLE_DEMO_SEED_USERS = String(process.env.AUTH_ENABLE_DEMO_SEED_USERS || 'false').toLowerCase() === 'true';
const AUTH_ENFORCE_CANONICAL_STORE = String(process.env.AUTH_ENFORCE_CANONICAL_STORE || 'true').toLowerCase() !== 'false';
const BACKEND_ASSET_ID = String(process.env.BACKEND_ASSET_ID || process.env.RENDER_SERVICE_ID || 'athlyrax-backend').trim();
// Demo auto-realignment is strictly non-production to avoid mutating live auth state.
const DEMO_AUTO_REALIGN_ENABLED = false;
const DEMO_AUTO_REALIGN_COOLDOWN_MS = Math.max(5000, Number.parseInt(process.env.DEMO_AUTO_REALIGN_COOLDOWN_MS || '15000', 10) || 15000);
const DEMO_AUTO_REALIGN_SCRIPT_PATH = path.resolve(__dirname, '..', 'scripts', 'realign-demo-systems.mjs');
const DEMO_AUTO_REALIGN_USERNAMES = new Set(['demo.coach', 'demo.swimmer', 'demo.researcher']);
const CANONICAL_TENANT_BY_USERNAME = Object.freeze({
	'demo.coach': 'demo-company',
});
const AUTH_PREVENT_USER_SHRINK = String(process.env.AUTH_PREVENT_USER_SHRINK || 'true').toLowerCase() !== 'false';
const AUTH_PRIMARY_SOFTWARE_OWNER_USERNAME = String(process.env.AUTH_PRIMARY_SOFTWARE_OWNER_USERNAME || 'softwareowner').trim().toLowerCase();
const AUTH_INVITE_TTL_HOURS = Math.max(1, Number.parseInt(process.env.AUTH_INVITE_TTL_HOURS || '168', 10) || 168);
const AUTH_PASSWORD_RESET_TTL_MINUTES = Math.max(5, Number.parseInt(process.env.AUTH_PASSWORD_RESET_TTL_MINUTES || '20', 10) || 20);
const AUTH_PASSWORD_RESET_DELIVERY = String(process.env.AUTH_PASSWORD_RESET_DELIVERY || 'console').trim().toLowerCase();
const AUTH_PASSWORD_RESET_DEV_CODE_IN_RESPONSE = String(process.env.AUTH_PASSWORD_RESET_DEV_CODE_IN_RESPONSE || 'false').toLowerCase() === 'true';
const AUTH_AUTO_HEAL_SWIMMER_BINDINGS = String(process.env.AUTH_AUTO_HEAL_SWIMMER_BINDINGS || 'true').toLowerCase() !== 'false';
const AUTH_SMTP_HOST = String(process.env.AUTH_SMTP_HOST || '').trim();
const AUTH_SMTP_PORT = Math.max(1, Number.parseInt(process.env.AUTH_SMTP_PORT || '587', 10) || 587);
const AUTH_SMTP_SECURE = String(process.env.AUTH_SMTP_SECURE || 'false').toLowerCase() === 'true';
const AUTH_SMTP_USER = String(process.env.AUTH_SMTP_USER || '').trim();
const AUTH_SMTP_PASS = String(process.env.AUTH_SMTP_PASS || '').trim();
const AUTH_SMTP_FROM = String(process.env.AUTH_SMTP_FROM || AUTH_SMTP_USER || '').trim();
const AUTH_USERNAME_PATTERN = /^[a-zA-Z0-9._-]{3,32}$/;
const AUTH_EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const AUTH_PRESENCE_WINDOW_MS = Math.max(60 * 1000, Number.parseInt(process.env.AUTH_PRESENCE_WINDOW_MS || `${5 * 60 * 1000}`, 10) || (5 * 60 * 1000));
const BILLING_STRIPE_SECRET_KEY = String(process.env.STRIPE_SECRET_KEY || '').trim();
const BILLING_STRIPE_WEBHOOK_SECRET = String(process.env.STRIPE_WEBHOOK_SECRET || '').trim();
const BILLING_PRICE_TIER_1 = String(process.env.STRIPE_PRICE_TIER_1 || process.env.STRIPE_PRICE_MONTHLY || '').trim();
const BILLING_PRICE_TIER_2 = String(process.env.STRIPE_PRICE_TIER_2 || '').trim();
const BILLING_PRICE_TIER_3 = String(process.env.STRIPE_PRICE_TIER_3 || process.env.STRIPE_PRICE_ANNUAL || '').trim();
const BILLING_APP_BASE_URL = String(process.env.BILLING_APP_BASE_URL || process.env.APP_BASE_URL || '').trim().replace(/\/$/, '');
const BILLING_ENFORCED = String(process.env.BILLING_ENFORCED || 'false').toLowerCase() === 'true';
const BILLING_CHECKOUT_ENABLED = String(process.env.BILLING_CHECKOUT_ENABLED || 'true').toLowerCase() !== 'false';
const BILLING_TRIAL_DAYS = Math.max(0, Number.parseInt(process.env.BILLING_TRIAL_DAYS || '42', 10) || 0);
const BILLING_BASE_TRIAL_DAYS = Math.max(0, Number.parseInt(process.env.BILLING_BASE_TRIAL_DAYS || '28', 10) || 0);
const BILLING_REFERRAL_BONUS_DAYS = Math.max(0, Number.parseInt(process.env.BILLING_REFERRAL_BONUS_DAYS || '14', 10) || 0);
const BILLING_TIER_KEYS = ['tier-1', 'tier-2', 'tier-3'];
const SWIMMER_SYNC_MAX_SNAPSHOTS = Math.max(50, Number.parseInt(process.env.SWIMMER_SYNC_MAX_SNAPSHOTS || '2000', 10) || 2000);
const SWIMMER_SYNC_MAX_HISTORY_DAYS = Math.max(30, Number.parseInt(process.env.SWIMMER_SYNC_MAX_HISTORY_DAYS || '730', 10) || 730);
const SWIMMER_SYNC_MAX_PB_ROWS = Math.max(10, Number.parseInt(process.env.SWIMMER_SYNC_MAX_PB_ROWS || '300', 10) || 300);
const SWIMMER_SYNC_MAX_TEST_SETS = Math.max(5, Number.parseInt(process.env.SWIMMER_SYNC_MAX_TEST_SETS || '200', 10) || 200);
const BILLING_PARTNER_COMMISSION_PERCENT = Math.max(0, Number.parseInt(process.env.BILLING_PARTNER_COMMISSION_PERCENT || '10', 10) || 0);
const BILLING_PARTNER_COMMISSION_MONTHS = Math.max(0, Number.parseInt(process.env.BILLING_PARTNER_COMMISSION_MONTHS || '36', 10) || 0);
const BILLING_EMAIL_NOTIFICATIONS_ENABLED = String(process.env.BILLING_EMAIL_NOTIFICATIONS_ENABLED || 'true').toLowerCase() !== 'false';
const PHASE1_TENANT_ISOLATION = String(process.env.PHASE1_TENANT_ISOLATION || 'true').toLowerCase() === 'true';
const DEFAULT_BILLING_CATALOG = {
	version: 1,
	currency: 'GBP',
	settings: {
		enforceCharging: BILLING_ENFORCED,
		checkoutEnabled: BILLING_CHECKOUT_ENABLED,
		baseTrialDays: BILLING_BASE_TRIAL_DAYS,
		referralBonusDays: BILLING_REFERRAL_BONUS_DAYS,
	},
	plans: [
		{
			key: 'tier-1',
			label: 'Tier 1',
			interval: 'month',
			amountMinor: 1800,
			stripePriceId: BILLING_PRICE_TIER_1,
			limits: { maxCoaches: 1, maxSwimmers: 24, maxSquads: 1 },
		},
		{
			key: 'tier-2',
			label: 'Tier 2',
			interval: 'month',
			amountMinor: 2800,
			stripePriceId: BILLING_PRICE_TIER_2,
			limits: { maxCoaches: 1, maxSwimmers: 100, maxSquads: 4 },
		},
		{
			key: 'tier-3',
			label: 'Tier 3 Club',
			interval: 'month',
			amountMinor: 0,
			stripePriceId: BILLING_PRICE_TIER_3,
			limits: { maxCoaches: null, maxSwimmers: 250, maxSquads: null },
		},
	],
	addons: [
		{ key: 'extra-25-swimmers', label: 'Extra 25 swimmers', swimmers: 25, amountMinor: 1300 },
		{ key: 'extra-50-swimmers', label: 'Extra 50 swimmers', swimmers: 50, amountMinor: 2500 },
	],
};
const DEFAULT_AUTH_USERS = [
	{ username: 'softwareowner', password: 'softwareowner123', role: 'software-owner', createdVia: 'seed' },
	{
		username: 'demo.coach',
		password: 'DemoCoach123!',
		role: 'head-coach',
		tenantId: 'demo-company',
		swimClub: 'Demo Company',
		teamName: 'Demo Team',
		createdVia: 'seed',
	},
	...(AUTH_ENABLE_DEMO_SEED_USERS
		? [
			{ username: 'headcoach', password: 'headcoach123', role: 'head-coach', createdVia: 'seed' },
			{ username: 'assistant', password: 'assistant123', role: 'assistant-coach', createdVia: 'seed' },
			{ username: 'viewer', password: 'viewer123', role: 'viewer', createdVia: 'seed' },
		]
		: []),
];
const DEMO_SEED_USERNAMES = new Set(['headcoach', 'assistant', 'viewer']);
const WRITE_ALLOWED_ROLES = new Set(['software-owner', 'head-coach', 'assistant-coach']);
const ADMIN_ALLOWED_ROLES = new Set(['software-owner', 'head-coach']);
const DEFAULT_ALLOWED_ORIGINS = [
	'http://localhost:5173',
	'http://localhost:5174',
	'http://localhost:5175',
	'http://127.0.0.1:5173',
	'http://127.0.0.1:5174',
	'http://127.0.0.1:5175',
	'http://localhost:4173',
	'http://127.0.0.1:4173',
];
const allowedOrigins = parseAllowedOrigins();
const loginRateBuckets = new Map();
const adminRateBuckets = new Map();
const authPresenceByUser = new Map();
const authPasswordResetByUser = new Map();
const stripeClient = BILLING_STRIPE_SECRET_KEY
	? new Stripe(BILLING_STRIPE_SECRET_KEY, { apiVersion: '2025-03-31.basil' })
	: null;

if (AUTH_REQUIRED && IS_PRODUCTION && AUTH_SECRET === 'athlyrax-dev-secret-change-me') {
	console.warn('[auth] AUTH_SECRET is using the development default in production. Set a strong AUTH_SECRET immediately.');
}

let writeTail = Promise.resolve();
let authResetMailTransport = null;
let demoAutoRealignLastAt = 0;

function isDemoAutoRealignTarget(identifier) {
	const normalized = String(identifier || '').trim().toLowerCase();
	return DEMO_AUTO_REALIGN_USERNAMES.has(normalized);
}

function runDemoAutoRealign(reason) {
	if (!DEMO_AUTO_REALIGN_ENABLED) return false;
	if (!fs.existsSync(DEMO_AUTO_REALIGN_SCRIPT_PATH)) {
		console.warn(`[demo-auto-realign] Script not found: ${DEMO_AUTO_REALIGN_SCRIPT_PATH}`);
		return false;
	}
	const now = Date.now();
	if ((now - demoAutoRealignLastAt) < DEMO_AUTO_REALIGN_COOLDOWN_MS) {
		return false;
	}
	try {
		execFileSync(process.execPath, [DEMO_AUTO_REALIGN_SCRIPT_PATH], {
			cwd: path.resolve(__dirname, '..'),
			stdio: 'pipe',
		});
		demoAutoRealignLastAt = now;
		console.info(`[demo-auto-realign] Completed (${reason}).`);
		return true;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error || 'unknown error');
		console.warn(`[demo-auto-realign] Failed (${reason}): ${message}`);
		return false;
	}
}

if (
	AUTH_ENFORCE_CANONICAL_STORE
	&& path.resolve(AUTH_USERS_PATH) !== path.resolve(SHARED_AUTH_USERS_PATH)
) {
	throw new Error(`[auth] Canonical auth store enforcement failed. Expected ${SHARED_AUTH_USERS_PATH}, received ${AUTH_USERS_PATH}.`);
}

runDemoAutoRealign('startup');

const authBootstrap = loadOrCreateAuthUsers();
const authUsers = authBootstrap.users;
const authInvites = loadOrCreateAuthInvites();
let snapshotSubmissions = loadOrCreateSnapshotSubmissions();
let billingCatalog = loadOrCreateBillingCatalog();

if (!AUTH_REQUIRED) {
	console.warn('[auth] Authentication is disabled (AUTH_REQUIRED=false).');
}

if (AUTH_REQUIRED && authBootstrap.source === 'defaults') {
	console.warn('[auth] Using default seeded credentials from storage. Override before production.');
}

if (stripeClient && BILLING_ENFORCED) {
	console.info('[billing] Subscription enforcement is enabled for write operations.');
}

app.post('/billing/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
	if (!stripeClient) {
		res.status(200).json({ ok: true, skipped: 'stripe_not_configured' });
		return;
	}

	const signature = String(req.headers?.['stripe-signature'] || '').trim();
	let event;

	try {
		if (BILLING_STRIPE_WEBHOOK_SECRET && signature) {
			event = stripeClient.webhooks.constructEvent(req.body, signature, BILLING_STRIPE_WEBHOOK_SECRET);
		} else {
			const rawBody = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : String(req.body || '{}');
			event = JSON.parse(rawBody);
		}
	} catch (error) {
		res.status(400).json({ error: 'Invalid webhook payload.', details: error instanceof Error ? error.message : 'Unknown error' });
		return;
	}

	try {
		switch (String(event?.type || '')) {
			case 'checkout.session.completed': {
				const session = event?.data?.object;
				const username = String(session?.client_reference_id || session?.metadata?.username || '').trim();
				const customerId = String(session?.customer || '').trim();
				if (username) {
					upsertUserBillingByUsername(username, {
						customerId,
						checkoutSessionId: String(session?.id || '').trim(),
						status: String(session?.status || 'active').trim() || 'active',
						updatedAt: new Date().toISOString(),
					});
				}
				await sendBillingCheckoutCompletedEmail(session);
				break;
			}
			case 'customer.subscription.created':
			case 'customer.subscription.updated':
			case 'customer.subscription.deleted': {
				await handleStripeSubscriptionEvent(event?.data?.object);
				break;
			}
			case 'invoice.payment_failed': {
				const invoice = event?.data?.object;
				const customerId = String(invoice?.customer || '').trim();
				if (customerId) {
					upsertUserBillingByCustomerId(customerId, {
						status: 'past_due',
						updatedAt: new Date().toISOString(),
					});
				}
				await sendBillingInvoiceEmail(invoice, 'failed');
				break;
			}
			case 'invoice.paid': {
				const invoice = event?.data?.object;
				await sendBillingInvoiceEmail(invoice, 'paid');
				break;
			}
			default:
				break;
		}

		res.status(200).json({ received: true });
	} catch (error) {
		res.status(500).json({ error: 'Webhook handling failed.', details: error instanceof Error ? error.message : 'Unknown error' });
	}
});

app.use(express.json({ limit: '25mb' }));

function readJsonFile(filePath) {
	try {
		if (!fs.existsSync(filePath)) return null;
		const raw = fs.readFileSync(filePath, 'utf8');
		return JSON.parse(raw);
	} catch {
		return null;
	}
}

function loadOrCreateSnapshotSubmissions() {
	const parsed = readJsonFile(SNAPSHOT_SUBMISSIONS_PATH);
	if (Array.isArray(parsed)) return parsed;
	try {
		writeAtomicJsonFile(SNAPSHOT_SUBMISSIONS_PATH, []);
	} catch {
		// Keep boot resilient when first-write fails.
	}
	return [];
}

function persistSnapshotSubmissions() {
	writeAtomicJsonFile(SNAPSHOT_SUBMISSIONS_PATH, Array.isArray(snapshotSubmissions) ? snapshotSubmissions : []);
}

function clampPercent(value) {
	const n = Number(value);
	if (!Number.isFinite(n)) return 0;
	return Math.max(0, Math.min(100, Math.round(n)));
}

function parseNumericValue(value) {
	const text = String(value || '').trim();
	if (!text) return 0;
	const minutesMatch = text.match(/^(\d+)\s*[:m]\s*(\d+(?:\.\d+)?)$/i);
	if (minutesMatch) {
		const minutes = Number.parseFloat(minutesMatch[1]);
		const seconds = Number.parseFloat(minutesMatch[2]);
		if (Number.isFinite(minutes) && Number.isFinite(seconds)) {
			return (minutes * 60) + seconds;
		}
	}
	const direct = Number.parseFloat(text);
	return Number.isFinite(direct) ? direct : 0;
}

function parseRepArray(rawValues) {
	const values = Array.isArray(rawValues) ? rawValues : [];
	return values
		.map((value) => parseNumericValue(value))
		.filter((value) => Number.isFinite(value) && value > 0);
}

function boundedRangeText(center, spread = 4) {
	const low = clampPercent(center - spread);
	const high = clampPercent(center + spread);
	return `${low}-${high}`;
}

const CANONICAL_AXIS_KEYS = [
	'technical_control',
	'efficiency_cost',
	'robustness_of_efficiency',
	'aerobic_capacity',
	'anaerobic_capacity',
	'speed_expression',
	'performance_progression',
	'coach_observation',
];

const CANONICAL_DEFAULTS = {
	trainingBase: 40,
	structuredBase: 60,
	competitionBase: 70,
	frequencyFloor: 0.5,
	recencyK: 0.035,
	coachCap: 0.15,
	signal: {
		weak: 0.5,
		strong: 1.0,
		minWeight: 0.35,
		maxWeight: 1.4,
	},
	sourceWeights: {
		training: 1,
		test: 2,
		competition: 1.5,
		coach: 0.15,
	},
	exposureTargets: {
		technical_control: 8,
		efficiency_cost: 10,
		robustness_of_efficiency: 10,
		aerobic_capacity: 10,
		anaerobic_capacity: 8,
		speed_expression: 6,
		performance_progression: 8,
		coach_observation: 3,
	},
};

function mergeCanonicalConfig(raw) {
	const source = raw && typeof raw === 'object' ? raw : {};
	const signalRaw = source?.signalNoise && typeof source.signalNoise === 'object'
		? source.signalNoise
		: (source?.signal && typeof source.signal === 'object' ? source.signal : {});
	const sourceWeightsRaw = source?.sourceWeights && typeof source.sourceWeights === 'object' ? source.sourceWeights : {};
	const exposureRaw = source?.exposureTargets && typeof source.exposureTargets === 'object' ? source.exposureTargets : {};
	const next = {
		trainingBase: parseNumericValue(source?.trainingBase) || CANONICAL_DEFAULTS.trainingBase,
		structuredBase: parseNumericValue(source?.structuredBase) || CANONICAL_DEFAULTS.structuredBase,
		competitionBase: parseNumericValue(source?.competitionBase) || CANONICAL_DEFAULTS.competitionBase,
		frequencyFloor: Math.max(0.05, Math.min(1, parseNumericValue(source?.frequencyFloor) || CANONICAL_DEFAULTS.frequencyFloor)),
		recencyK: Math.max(0, Math.min(0.25, parseNumericValue(source?.recencyK) || CANONICAL_DEFAULTS.recencyK)),
		coachCap: Math.max(0, Math.min(1, parseNumericValue(source?.coachCap) || CANONICAL_DEFAULTS.coachCap)),
		signal: {
			weak: Math.max(0.1, Math.min(2, parseNumericValue(signalRaw?.weak) || CANONICAL_DEFAULTS.signal.weak)),
			strong: Math.max(0.2, Math.min(3, parseNumericValue(signalRaw?.strong) || CANONICAL_DEFAULTS.signal.strong)),
			minWeight: Math.max(0.1, Math.min(1, parseNumericValue(signalRaw?.minWeight) || CANONICAL_DEFAULTS.signal.minWeight)),
			maxWeight: Math.max(1, Math.min(2.5, parseNumericValue(signalRaw?.maxWeight) || CANONICAL_DEFAULTS.signal.maxWeight)),
		},
		sourceWeights: {
			training: Math.max(0, parseNumericValue(sourceWeightsRaw?.training) || CANONICAL_DEFAULTS.sourceWeights.training),
			test: Math.max(0, parseNumericValue(sourceWeightsRaw?.test) || CANONICAL_DEFAULTS.sourceWeights.test),
			competition: Math.max(0, parseNumericValue(sourceWeightsRaw?.competition) || CANONICAL_DEFAULTS.sourceWeights.competition),
			coach: Math.max(0, parseNumericValue(sourceWeightsRaw?.coach) || CANONICAL_DEFAULTS.sourceWeights.coach),
		},
		exposureTargets: {},
	};
	for (const axisKey of CANONICAL_AXIS_KEYS) {
		next.exposureTargets[axisKey] = Math.max(
			1,
			Math.round(parseNumericValue(exposureRaw?.[axisKey]) || CANONICAL_DEFAULTS.exposureTargets[axisKey] || 6)
		);
	}
	if (next.signal.strong <= next.signal.weak) {
		next.signal.strong = next.signal.weak + 0.01;
	}
	return next;
}

function canonicalSourceKind(row) {
	const kind = String(row?.sourceKind || row?.weightKind || '').trim().toLowerCase();
	if (kind === 'test' || kind === 'structured-set') return 'test';
	if (kind === 'competition') return 'competition';
	if (kind === 'coach') return 'coach';
	return 'training';
}

function canonicalAgeDays(row, referenceTs) {
	const dateText = String(row?.date || '').trim();
	if (!dateText) return 0;
	const rowTs = Date.parse(dateText);
	if (!Number.isFinite(rowTs)) return 0;
	const reference = Number.isFinite(referenceTs) ? referenceTs : Date.now();
	const delta = Math.max(0, reference - rowTs);
	return delta / (24 * 60 * 60 * 1000);
}

function canonicalSignalRatio(row) {
	const reps = Math.max(1, parseNumericValue(row?.reps) || 1) * Math.max(1, parseNumericValue(row?.rounds) || 1);
	let signal = 0;
	let noise = 0.6;
	if (row?.hasResult) signal += 1.0;
	else noise += 0.5;
	if (row?.hasSplit) signal += 0.35;
	else noise += 0.2;
	if (row?.hasStrokeCount) signal += 0.25;
	else noise += 0.2;
	const kind = canonicalSourceKind(row);
	if (kind === 'competition') signal += 0.35;
	if (kind === 'test') signal += 0.2;
	if (kind === 'coach') {
		signal += 0.15;
		noise += 0.25;
	}
	signal += Math.min(0.4, reps / 20);
	return signal / Math.max(0.1, noise);
}

function canonicalSignalFactor(row, config) {
	const ratio = canonicalSignalRatio(row);
	const weak = config.signal.weak;
	const strong = config.signal.strong;
	if (ratio <= weak) return config.signal.minWeight;
	if (ratio >= strong) return config.signal.maxWeight;
	const t = (ratio - weak) / Math.max(0.001, strong - weak);
	return config.signal.minWeight + ((config.signal.maxWeight - config.signal.minWeight) * t);
}

function canonicalRowWeight(row, config, referenceTs) {
	const sourceKind = canonicalSourceKind(row);
	let sourceWeight = config.sourceWeights[sourceKind] ?? 1;
	if (sourceKind === 'coach') sourceWeight = Math.min(sourceWeight, config.coachCap);
	const recencyWeight = Math.exp(-config.recencyK * canonicalAgeDays(row, referenceTs));
	const signalFactor = canonicalSignalFactor(row, config);
	return Math.max(0, sourceWeight * recencyWeight * signalFactor);
}

function emptyAxisScoreMap() {
	return Object.fromEntries(CANONICAL_AXIS_KEYS.map((axis) => [axis, 0]));
}

function calculateCanonicalAxisScores(rows, mode, config, referenceTs) {
	const sourceRows = Array.isArray(rows) ? rows : [];
	const scores = emptyAxisScoreMap();
	const counts = emptyAxisScoreMap();

	for (const axisKey of CANONICAL_AXIS_KEYS) {
		const matching = sourceRows.filter((row) => Array.isArray(row?.axes) && row.axes.includes(axisKey));
		const eligible = matching.filter((row) => {
			if (mode === 'training') return String(row?.sourceGroup || '').trim().toLowerCase() === 'training';
			if (mode === 'validation') return String(row?.sourceGroup || '').trim().toLowerCase() === 'validation';
			return true;
		});
		counts[axisKey] = eligible.length;
		if (!eligible.length) continue;

		const exposureTarget = Math.max(1, parseNumericValue(config.exposureTargets[axisKey]) || 6);
		const frequencyFactor = Math.max(config.frequencyFloor, Math.min(1, eligible.length / exposureTarget));
		let weightedTotal = 0;
		let weightTotal = 0;

		for (const row of eligible) {
			const m = clampPercent(row?.score);
			const w = canonicalRowWeight(row, config, referenceTs) * frequencyFactor;
			if (w <= 0) continue;
			weightedTotal += m * w;
			weightTotal += w;
		}

		if (weightTotal > 0) {
			scores[axisKey] = clampPercent(weightedTotal / weightTotal);
		}
	}

	return { scores, counts };
}

function calculateCanonicalIntegratedScores(rows, config, referenceTs) {
	const sourceRows = Array.isArray(rows) ? rows : [];
	const grouped = {
		training: sourceRows.filter((row) => canonicalSourceKind(row) === 'training'),
		test: sourceRows.filter((row) => canonicalSourceKind(row) === 'test'),
		competition: sourceRows.filter((row) => canonicalSourceKind(row) === 'competition'),
		coach: sourceRows.filter((row) => canonicalSourceKind(row) === 'coach'),
	};
	const perSource = {
		training: calculateCanonicalAxisScores(grouped.training, 'integrated', config, referenceTs),
		test: calculateCanonicalAxisScores(grouped.test, 'integrated', config, referenceTs),
		competition: calculateCanonicalAxisScores(grouped.competition, 'integrated', config, referenceTs),
		coach: calculateCanonicalAxisScores(grouped.coach, 'integrated', config, referenceTs),
	};
	const scores = emptyAxisScoreMap();
	const counts = emptyAxisScoreMap();

	for (const axisKey of CANONICAL_AXIS_KEYS) {
		const components = [
			{ key: 'training', weight: config.sourceWeights.training },
			{ key: 'test', weight: config.sourceWeights.test },
			{ key: 'competition', weight: config.sourceWeights.competition },
			{ key: 'coach', weight: Math.min(config.sourceWeights.coach, config.coachCap) },
		].filter((entry) => {
			const count = parseNumericValue(perSource[entry.key]?.counts?.[axisKey]);
			return entry.weight > 0 && count > 0;
		});

		if (!components.length) continue;
		let weightedTotal = 0;
		let weightTotal = 0;
		for (const component of components) {
			const axisScore = parseNumericValue(perSource[component.key]?.scores?.[axisKey]);
			weightedTotal += axisScore * component.weight;
			weightTotal += component.weight;
			counts[axisKey] = Math.max(counts[axisKey], parseNumericValue(perSource[component.key]?.counts?.[axisKey]));
		}
		scores[axisKey] = clampPercent(weightedTotal / Math.max(0.001, weightTotal));
	}

	return { scores, counts };
}

function normalizeCapabilityRows(rows) {
	const source = Array.isArray(rows) ? rows : [];
	return source.map((row, index) => ({
		id: String(row?.id || `row_${index + 1}`),
		date: String(row?.date || '').trim(),
		sourceGroup: String(row?.sourceGroup || 'training').trim().toLowerCase(),
		sourceKind: String(row?.sourceKind || row?.weightKind || 'training').trim().toLowerCase(),
		hasResult: row?.hasResult !== false,
		hasSplit: row?.hasSplit === true,
		hasStrokeCount: row?.hasStrokeCount === true,
		reps: Math.max(1, parseNumericValue(row?.reps) || 1),
		rounds: Math.max(1, parseNumericValue(row?.rounds) || 1),
		score: clampPercent(row?.score),
		axes: Array.isArray(row?.axes) ? row.axes.map((axis) => String(axis || '').trim()).filter(Boolean) : [],
	}));
}

function deriveCapabilityRowScore(row, config) {
	const preset = parseNumericValue(row?.score);
	if (preset > 0) return clampPercent(preset);
	const kind = canonicalSourceKind(row);
	if (kind === 'coach') return clampPercent(row?.score);
	let score = kind === 'competition'
		? config.competitionBase
		: kind === 'test'
			? config.structuredBase
			: config.trainingBase;
	if (row?.hasResult) score += 8;
	if (row?.hasSplit) score += 6;
	if (row?.hasStrokeCount) score += 4;
	if (kind === 'competition') score += 8;
	return clampPercent(score);
}

function scoreCapabilityRows(rows, config) {
	return normalizeCapabilityRows(rows).map((row) => ({
		...row,
		score: deriveCapabilityRowScore(row, config),
	}));
}

function parseSnapshotPbRows(rawPbs) {
	const source = Array.isArray(rawPbs) ? rawPbs : [];
	return source
		.map((row, index) => {
			const event = String(row?.event || row?.race || '').trim();
			const distance = parseNumericValue(row?.distance || event.match(/^(\d+)/)?.[1]);
			const seconds = parseNumericValue(row?.seconds || row?.time);
			if (!Number.isFinite(seconds) || seconds <= 0) return null;
			return {
				id: `pb_${index + 1}`,
				event,
				distance,
				seconds,
				time: String(row?.time || '').trim(),
				stroke: String(row?.stroke || '').trim(),
			};
		})
		.filter(Boolean);
}

function buildSnapshotEvidenceRows(payload, config) {
	const tests = payload && typeof payload.tests === 'object' ? payload.tests : {};
	const maxEffortStrokeCounts = payload && typeof payload.maxEffortStrokeCounts === 'object' ? payload.maxEffortStrokeCounts : {};
	const repTimes25 = parseRepArray(payload?.repTimes25?.reps);
	const repTimes50 = parseRepArray(payload?.repTimes50?.reps);
	const stroke25 = parseRepArray(payload?.strokeCounts25?.reps);
	const stroke50 = parseRepArray(payload?.strokeCounts50?.reps);
	const pbRows = parseSnapshotPbRows(payload?.pbs);
	const date = String(payload?.snapshotDate || payload?.date || new Date().toISOString()).trim();
	const rows = [];

	for (const distance of [25, 50, 100, 200, 400]) {
		const seconds = parseNumericValue(tests?.[`m${distance}`]);
		if (!Number.isFinite(seconds) || seconds <= 0) continue;
		const hasStrokeCount = parseNumericValue(maxEffortStrokeCounts?.[`m${distance}`]) > 0;
		const baseScore = clampPercent(108 - (seconds * (distance <= 50 ? 2.3 : 0.8)) + (distance * 0.08));
		rows.push({
			id: `test_${distance}`,
			date,
			sourceGroup: 'validation',
			sourceKind: 'test',
			hasResult: true,
			hasSplit: true,
			hasStrokeCount,
			reps: 1,
			rounds: 1,
			score: clampPercent((baseScore * 0.6) + (config.structuredBase * 0.4)),
			axes: ['speed_expression', 'anaerobic_capacity', 'performance_progression', 'aerobic_capacity'],
		});
	}

	if (repTimes25.length > 0 || stroke25.length > 0) {
		const avg = repTimes25.length > 0 ? repTimes25.reduce((sum, value) => sum + value, 0) / repTimes25.length : 0;
		rows.push({
			id: 'reps_25',
			date,
			sourceGroup: 'validation',
			sourceKind: 'structured-set',
			hasResult: repTimes25.length > 0,
			hasSplit: repTimes25.length > 0,
			hasStrokeCount: stroke25.length > 0,
			reps: Math.max(2, repTimes25.length || stroke25.length),
			rounds: 1,
			score: clampPercent((config.structuredBase * 0.7) + clampPercent(95 - (avg * 1.8)) * 0.3),
			axes: ['technical_control', 'efficiency_cost', 'robustness_of_efficiency', 'anaerobic_capacity'],
		});
	}

	if (repTimes50.length > 0 || stroke50.length > 0) {
		const avg = repTimes50.length > 0 ? repTimes50.reduce((sum, value) => sum + value, 0) / repTimes50.length : 0;
		rows.push({
			id: 'reps_50',
			date,
			sourceGroup: 'validation',
			sourceKind: 'structured-set',
			hasResult: repTimes50.length > 0,
			hasSplit: repTimes50.length > 0,
			hasStrokeCount: stroke50.length > 0,
			reps: Math.max(2, repTimes50.length || stroke50.length),
			rounds: 1,
			score: clampPercent((config.structuredBase * 0.7) + clampPercent(112 - (avg * 1.6)) * 0.3),
			axes: ['technical_control', 'efficiency_cost', 'robustness_of_efficiency', 'aerobic_capacity'],
		});
	}

	for (let index = 0; index < pbRows.length; index += 1) {
		const pb = pbRows[index];
		const pbScore = clampPercent((config.competitionBase * 0.7) + clampPercent(115 - (pb.seconds * 0.65)) * 0.3);
		rows.push({
			id: `pb_${index + 1}`,
			date,
			sourceGroup: 'validation',
			sourceKind: 'competition',
			hasResult: true,
			hasSplit: false,
			hasStrokeCount: false,
			reps: 1,
			rounds: 1,
			score: pbScore,
			axes: ['speed_expression', 'performance_progression', 'anaerobic_capacity', 'aerobic_capacity'],
		});
	}

	const coachObservation = clampPercent(parseNumericValue(
		payload?.coach_observation
		?? payload?.coachObservation
		?? payload?.coach_assessment
		?? payload?.coachAssessment
		?? payload?.coach
	));
	if (coachObservation > 0) {
		rows.push({
			id: 'coach_observation',
			date,
			sourceGroup: 'coach',
			sourceKind: 'coach',
			hasResult: true,
			hasSplit: false,
			hasStrokeCount: false,
			reps: 1,
			rounds: 1,
			score: coachObservation,
			axes: ['coach_observation'],
		});
	}

	return { rows, tests, repTimes25, repTimes50, stroke25, stroke50, maxEffortStrokeCounts, coachObservation };
}

function toRadarSeries(scores) {
	return CANONICAL_AXIS_KEYS.map((axisKey) => clampPercent(scores?.[axisKey]));
}

function buildSnapshotSummaryFromPayload(payload) {
	const config = mergeCanonicalConfig(payload?.calibration);
	const referenceTs = Date.now();
	const evidence = buildSnapshotEvidenceRows(payload, config);
	const validationCalc = calculateCanonicalAxisScores(evidence.rows, 'validation', config, referenceTs);
	const integratedCalc = calculateCanonicalIntegratedScores(evidence.rows, config, referenceTs);

	const integrated = integratedCalc.scores;
	const speedExpression = clampPercent(integrated.speed_expression);
	const repeatability = clampPercent(integrated.anaerobic_capacity);
	const efficiency = clampPercent(integrated.efficiency_cost);
	const stability = clampPercent(integrated.robustness_of_efficiency);
	const aerobic = clampPercent(integrated.aerobic_capacity);
	const progression = clampPercent(integrated.performance_progression);
	const powerSpeed = clampPercent((speedExpression * 0.65) + (repeatability * 0.35));
	const firstBreak = Math.max(0, Math.round(parseNumericValue(evidence.maxEffortStrokeCounts?.m25) || 0));
	const firstBreakPercent = clampPercent(firstBreak * 2);
	const drift = clampPercent(100 - stability);

	const metrics = {
		technical_control: clampPercent(integrated.technical_control),
		efficiency_cost: efficiency,
		robustness_of_efficiency: stability,
		aerobic_capacity: aerobic,
		anaerobic_capacity: repeatability,
		speed_expression: speedExpression,
		performance_progression: progression,
		coach_observation: clampPercent(evidence.coachObservation),
		speedExpression,
		repeatability,
		efficiency,
		aerobic,
		powerSpeed,
		progression,
		firstBreak,
		firstBreakPercent,
		stability,
		drift,
	};

	const indicators = {
		repeatabilityRange: boundedRangeText(repeatability, 5),
		efficiencyRange: boundedRangeText(efficiency, 5),
		firstBreakEstimate: `${firstBreak}m`,
		stabilityRange: boundedRangeText(stability, 4),
		driftRange: boundedRangeText(drift, 4),
	};

	const labels = [
		'Technical Control',
		'Efficiency',
		'Robustness of Efficiency',
		'Aerobic Capacity',
		'Anaerobic Capacity',
		'Power & Speed Expression',
		'Performance Progression',
		'Coach Assessment',
	];
	const capability = toRadarSeries(integrated);
	const isp = toRadarSeries(validationCalc.scores);
	const displayCapabilityRadar = capability.map((value) => clampPercent(value));

	const interpretationText = [
		`Integrated capability uses weighted source evidence with exposure, recency, and signal-quality factors.`,
		`Coach contribution is capped and blended into the final axis profile only when coach evidence exists.`,
		`Use this baseline snapshot to compare trend direction over future submissions.`,
	].join(' ');

	return {
		metrics,
		indicators,
		interpretationText,
		radar: {
			labels,
			isp,
			capability,
			integrated: capability,
			displayCapability: displayCapabilityRadar,
			drift,
		},
		presentation: {
			displayMetrics: metrics,
			displayCapabilityRadar,
		},
	};
}

function hashPassword(plainPassword) {
	const salt = crypto.randomBytes(16);
	const derivedKey = crypto.scryptSync(String(plainPassword || ''), salt, 64);
	return `scrypt$${salt.toString('base64')}$${derivedKey.toString('base64')}`;
}

function verifyPassword(plainPassword, storedHash) {
	const value = String(storedHash || '').trim();
	if (!value.startsWith('scrypt$')) return false;
	const parts = value.split('$');
	if (parts.length !== 3) return false;
	try {
		const salt = Buffer.from(parts[1], 'base64');
		const expected = Buffer.from(parts[2], 'base64');
		const candidate = crypto.scryptSync(String(plainPassword || ''), salt, expected.length);
		if (candidate.length !== expected.length) return false;
		return crypto.timingSafeEqual(candidate, expected);
	} catch {
		return false;
	}
}

function makePasswordResetCode() {
	let code = '';
	for (let index = 0; index < 6; index += 1) {
		code += String(crypto.randomInt(0, 10));
	}
	return code;
}

function hashPasswordResetCode(code) {
	return crypto.createHash('sha256').update(String(code || ''), 'utf8').digest('hex');
}

function findAuthUserByIdentifier(identifier) {
	const normalized = String(identifier || '').trim();
	if (!normalized) return null;
	const normalizedLower = normalized.toLowerCase();
	return authUsers.find((row) => {
		const username = String(row?.username || '').trim();
		const email = String(row?.email || '').trim().toLowerCase();
		return username.toLowerCase() === normalizedLower || (email && email === normalizedLower);
	}) || null;
}

function resolveLoginUserByIdentifier(identifier) {
	const normalized = String(identifier || '').trim();
	if (!normalized) {
		return { user: null, reason: 'missing_identifier' };
	}
	const normalizedLower = normalized.toLowerCase();
	const usernameMatches = authUsers.filter((row) => String(row?.username || '').trim().toLowerCase() === normalizedLower);
	if (usernameMatches.length > 1) {
		return { user: null, reason: 'duplicate_username' };
	}
	if (usernameMatches.length === 1) {
		return { user: usernameMatches[0], reason: '' };
	}

	if (!normalizedLower.includes('@')) {
		return { user: null, reason: 'unknown_identifier' };
	}

	const emailMatches = authUsers.filter((row) => String(row?.email || '').trim().toLowerCase() === normalizedLower);
	if (emailMatches.length > 1) {
		return { user: null, reason: 'ambiguous_email' };
	}
	if (emailMatches.length === 1) {
		return { user: emailMatches[0], reason: '' };
	}

	return { user: null, reason: 'unknown_identifier' };
}

function getAuthResetMailTransport() {
	if (authResetMailTransport) return authResetMailTransport;
	authResetMailTransport = nodemailer.createTransport({
		host: AUTH_SMTP_HOST,
		port: AUTH_SMTP_PORT,
		secure: AUTH_SMTP_SECURE,
		auth: AUTH_SMTP_USER && AUTH_SMTP_PASS
			? { user: AUTH_SMTP_USER, pass: AUTH_SMTP_PASS }
			: undefined,
	});
	return authResetMailTransport;
}

async function deliverPasswordResetCode({ user, resetCode }) {
	const username = String(user?.username || '').trim();
	const email = String(user?.email || '').trim();
	const deliveryMode = AUTH_PASSWORD_RESET_DELIVERY === 'smtp' ? 'smtp' : 'console';

	if (deliveryMode === 'smtp') {
		if (!email || !AUTH_EMAIL_PATTERN.test(email)) {
			throw new Error('Account has no valid email address for password reset.');
		}
		if (!AUTH_SMTP_HOST || !AUTH_SMTP_FROM) {
			throw new Error('SMTP delivery is enabled but SMTP config is incomplete.');
		}

		const transport = getAuthResetMailTransport();
		await transport.sendMail({
			from: AUTH_SMTP_FROM,
			to: email,
			subject: 'AthlyraX password reset code',
			text: [
				`Hi ${username || 'coach'},`,
				'',
				`Your AthlyraX password reset code is: ${resetCode}`,
				`This code expires in ${AUTH_PASSWORD_RESET_TTL_MINUTES} minutes.`,
				'',
				'If you did not request this reset, please ignore this email.',
			].join('\n'),
		});
		return { mode: 'smtp' };
	}

	console.log(`[auth] Password reset code for ${username}: ${resetCode} (expires in ${AUTH_PASSWORD_RESET_TTL_MINUTES} minutes)`);
	return { mode: 'console' };
}

function parseAuthUsersFromEnv() {
	const rawEnv = String(process.env.AUTH_USERS_JSON || '').trim();
	if (!rawEnv) return [];
	try {
		const parsed = JSON.parse(rawEnv);
		return Array.isArray(parsed)
			? parsed
				.map((row) => ({
					username: String(row?.username || '').trim(),
					role: String(row?.role || '').trim() || 'viewer',
					password: String(row?.password || ''),
					passwordHash: String(row?.passwordHash || '').trim(),
					tokenValidAfter: Number.parseInt(row?.tokenValidAfter || '0', 10) || 0,
					createdVia: String(row?.createdVia || '').trim() || 'legacy',
					createdAt: String(row?.createdAt || '').trim(),
					fullName: String(row?.fullName || '').trim(),
					email: String(row?.email || '').trim(),
					phone: String(row?.phone || '').trim(),
					swimClub: String(row?.swimClub || '').trim(),
					teamName: String(row?.teamName || '').trim(),
					city: String(row?.city || '').trim(),
					country: String(row?.country || '').trim(),
					isApproved: row?.isApproved !== false,
					onboardingCompletedAt: String(row?.onboardingCompletedAt || '').trim(),
				}))
				.filter((row) => row.username && (row.password || row.passwordHash))
			: [];
	} catch {
		return [];
	}
}

function getDefaultBillingState() {
	return {
		planKey: 'free',
		status: 'inactive',
		customerId: '',
		subscriptionId: '',
		priceId: '',
		checkoutSessionId: '',
		trialEndsAt: '',
		currentPeriodEnd: '',
		cancelAtPeriodEnd: false,
		updatedAt: new Date().toISOString(),
	};
}

function slugTenantPart(value, fallback = 'default') {
	const normalized = String(value || '')
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '');
	return normalized || fallback;
}

function normalizeTenantId(rawTenantId) {
	const normalized = String(rawTenantId || '')
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9_-]+/g, '-')
		.replace(/^-+|-+$/g, '');
	return normalized;
}

function isPrimarySoftwareOwnerAccount(user) {
	const role = String(user?.role || '').trim();
	const username = String(user?.username || '').trim().toLowerCase();
	return role === 'software-owner' && username === AUTH_PRIMARY_SOFTWARE_OWNER_USERNAME;
}

function resolveTenantKeyFromUser(user) {
	const username = slugTenantPart(String(user?.username || '').trim(), 'unknown-user');
	const canonicalTenantId = CANONICAL_TENANT_BY_USERNAME[String(user?.username || '').trim().toLowerCase()];
	if (canonicalTenantId) return canonicalTenantId;
	if (isPrimarySoftwareOwnerAccount(user)) return 'global-owner';

	const explicitTenantId = normalizeTenantId(user?.tenantId);
	if (explicitTenantId) return explicitTenantId;

	const rawSwimClub = String(user?.swimClub || '').trim();
	const rawTeamName = String(user?.teamName || '').trim();
	if (rawSwimClub && rawTeamName) {
		const swimClub = slugTenantPart(rawSwimClub, 'club');
		const teamName = slugTenantPart(rawTeamName, 'team');
		return `${swimClub}__${teamName}`;
	}
	return `user-${username}`;
}

function resolveStoragePathsForAuth(auth) {
	if (!PHASE1_TENANT_ISOLATION) {
		return {
			tenantKey: 'global',
			dbPath: DB_PATH,
			backupPath: TARGET_BACKUP_PATH,
			snapshotDir: DB_SNAPSHOT_DIR,
		};
	}

	const user = findAuthUser(String(auth?.username || '').trim()) || auth || {};
	const tenantKey = resolveTenantKeyFromUser(user);
	if (tenantKey === 'global-owner') {
		return {
			tenantKey,
			dbPath: DB_PATH,
			backupPath: TARGET_BACKUP_PATH,
			snapshotDir: DB_SNAPSHOT_DIR,
		};
	}

	const tenantDir = path.join(DB_TENANTS_DIR, tenantKey);
	return {
		tenantKey,
		dbPath: path.join(tenantDir, 'db.json'),
		backupPath: path.join(tenantDir, 'trainingPlannerTargets.backup.json'),
		snapshotDir: path.join(tenantDir, 'db-snapshots'),
	};
}

function resolveAuthTenantId(auth) {
	const user = findAuthUser(String(auth?.username || '').trim()) || auth || {};
	return resolveTenantKeyFromUser(user);
}

function canAdminManageUser(auth, targetUser) {
	if (isPrimarySoftwareOwnerAccount(auth)) return true;
	if (!targetUser || typeof targetUser !== 'object') return false;
	if (isPrimarySoftwareOwnerAccount(targetUser)) return false;
	const actorTenant = resolveAuthTenantId(auth);
	const targetTenant = resolveTenantKeyFromUser(targetUser);
	return Boolean(actorTenant && targetTenant && actorTenant === targetTenant);
}

function getTenantUsersByTenantId(tenantId) {
	const normalizedTenantId = normalizeTenantId(tenantId);
	if (!normalizedTenantId) return [];
	return authUsers.filter((row) => resolveTenantKeyFromUser(row) === normalizedTenantId);
}

function resolveTenantPlanLimits(tenantId) {
	const tenantUsers = getTenantUsersByTenantId(tenantId);
	if (tenantUsers.length < 1) return { planKey: 'free', limits: null };
	const selectedUser = tenantUsers.find((row) => {
		const planKey = String(row?.billing?.planKey || '').trim();
		return planKey && planKey !== 'free';
	}) || tenantUsers[0];
	const planKey = String(selectedUser?.billing?.planKey || 'free').trim() || 'free';
	const plan = getBillingPlansCatalog().find((row) => String(row?.key || '').trim() === planKey) || null;
	return {
		planKey,
		limits: plan?.limits || null,
	};
}

function countActiveTenantRoleUsers(tenantId, role, excludeUsername = '') {
	const normalizedTenantId = normalizeTenantId(tenantId);
	const excluded = String(excludeUsername || '').trim().toLowerCase();
	if (!normalizedTenantId) return 0;
	return authUsers.filter((row) => {
		const rowTenantId = resolveTenantKeyFromUser(row);
		if (rowTenantId !== normalizedTenantId) return false;
		if (String(row?.role || '').trim() !== role) return false;
		if (excluded && String(row?.username || '').trim().toLowerCase() === excluded) return false;
		return true;
	}).length;
}

function countOpenTenantHeadCoachInvites(tenantId) {
	const normalizedTenantId = normalizeTenantId(tenantId);
	if (!normalizedTenantId) return 0;
	const now = Date.now();
	return authInvites.reduce((acc, invite) => {
		if (normalizeTenantId(invite?.tenantId) !== normalizedTenantId) return acc;
		if (String(invite?.role || '').trim() !== 'head-coach') return acc;
		if (invite?.disabled === true) return acc;
		const expiresAtMs = Date.parse(String(invite?.expiresAt || ''));
		if (!Number.isFinite(expiresAtMs) || expiresAtMs <= now) return acc;
		const remaining = Math.max(0, Number(invite?.maxUses || 1) - Number(invite?.usedCount || 0));
		return acc + remaining;
	}, 0);
}

function getSessionCoordinatorCapacityError(tenantId, { includePendingInvites = false, excludeUsername = '' } = {}) {
	const normalizedTenantId = normalizeTenantId(tenantId);
	if (!normalizedTenantId || normalizedTenantId === 'global-owner') return '';
	const { limits } = resolveTenantPlanLimits(normalizedTenantId);
	const maxCoaches = limits?.maxCoaches;
	if (maxCoaches === null || maxCoaches === undefined) return '';
	const headCoachCount = countActiveTenantRoleUsers(normalizedTenantId, 'head-coach', excludeUsername);
	const pendingHeadCoachInvites = includePendingInvites ? countOpenTenantHeadCoachInvites(normalizedTenantId) : 0;
	if ((headCoachCount + pendingHeadCoachInvites) < maxCoaches) return '';
	return 'This subscription tier allows only one session coordinator for this team.';
}

function normalizeBillingLimitValue(value, fallback = null) {
	if (value === null || value === undefined || value === '' || String(value).toLowerCase() === 'unlimited') return null;
	const parsed = Number.parseInt(value, 10);
	if (!Number.isFinite(parsed) || parsed < 0) return fallback;
	return parsed;
}

function normalizeBillingPlanRow(plan) {
	const normalized = plan && typeof plan === 'object' ? plan : {};
	const key = String(normalized?.key || '').trim().toLowerCase();
	const label = String(normalized?.label || key || 'Plan').trim() || key || 'Plan';
	const interval = String(normalized?.interval || 'month').trim().toLowerCase() === 'year' ? 'year' : 'month';
	const amountMinor = Math.max(0, Number.parseInt(normalized?.amountMinor || '0', 10) || 0);
	const stripePriceId = String(normalized?.stripePriceId || '').trim();
	return {
		key,
		label,
		interval,
		amountMinor,
		stripePriceId,
		limits: {
			maxCoaches: normalizeBillingLimitValue(normalized?.limits?.maxCoaches, null),
			maxSwimmers: normalizeBillingLimitValue(normalized?.limits?.maxSwimmers, null),
			maxSquads: normalizeBillingLimitValue(normalized?.limits?.maxSquads, null),
		},
	};
}

function normalizeBillingAddonRow(addon) {
	const normalized = addon && typeof addon === 'object' ? addon : {};
	const key = String(normalized?.key || '').trim().toLowerCase();
	const label = String(normalized?.label || key || 'Add-on').trim() || key || 'Add-on';
	return {
		key,
		label,
		swimmers: Math.max(0, Number.parseInt(normalized?.swimmers || '0', 10) || 0),
		amountMinor: Math.max(0, Number.parseInt(normalized?.amountMinor || '0', 10) || 0),
	};
}

function normalizeBillingCatalog(rawCatalog) {
	function normalizeBillingSettings(rawSettings) {
		const normalizePageVisibilityByTier = (rawVisibility) => {
			const sourceVisibility = rawVisibility && typeof rawVisibility === 'object' && !Array.isArray(rawVisibility)
				? rawVisibility
				: {};
			const nextVisibility = {};
			for (const tierKey of BILLING_TIER_KEYS) {
				const tierValue = sourceVisibility?.[tierKey];
				if (!tierValue || typeof tierValue !== 'object' || Array.isArray(tierValue)) {
					nextVisibility[tierKey] = {};
					continue;
				}
				const normalizedTier = {};
				for (const [pageKey, visible] of Object.entries(tierValue)) {
					const normalizedPageKey = String(pageKey || '').trim();
					if (!normalizedPageKey) continue;
					normalizedTier[normalizedPageKey] = visible !== false;
				}
				nextVisibility[tierKey] = normalizedTier;
			}
			return nextVisibility;
		};

		const source = rawSettings && typeof rawSettings === 'object' ? rawSettings : {};
		const hasLegacyTrialDays = Number.isFinite(Number(source?.trialDays));
		const legacyTrialDays = Math.max(0, Number.parseInt(source?.trialDays || '0', 10) || 0);
		const defaultBaseTrial = Math.max(0, BILLING_BASE_TRIAL_DAYS || BILLING_TRIAL_DAYS);
		return {
			enforceCharging: source?.enforceCharging === true ? true : source?.enforceCharging === false ? false : BILLING_ENFORCED,
			checkoutEnabled: source?.checkoutEnabled === true ? true : source?.checkoutEnabled === false ? false : BILLING_CHECKOUT_ENABLED,
			baseTrialDays: hasLegacyTrialDays
				? legacyTrialDays
				: Math.max(0, Number.parseInt(source?.baseTrialDays || `${defaultBaseTrial}`, 10) || defaultBaseTrial),
			referralBonusDays: Math.max(0, Number.parseInt(source?.referralBonusDays || `${BILLING_REFERRAL_BONUS_DAYS}`, 10) || BILLING_REFERRAL_BONUS_DAYS),
			pageVisibilityByTier: normalizePageVisibilityByTier(source?.pageVisibilityByTier),
		};
	}

	const source = rawCatalog && typeof rawCatalog === 'object' ? rawCatalog : {};
	const plans = Array.isArray(source?.plans)
		? source.plans.map(normalizeBillingPlanRow).filter((row) => row.key)
		: [];
	const addons = Array.isArray(source?.addons)
		? source.addons.map(normalizeBillingAddonRow).filter((row) => row.key)
		: [];
	const fallbackPlans = [
		normalizeBillingPlanRow(DEFAULT_BILLING_CATALOG.plans[0]),
		normalizeBillingPlanRow(DEFAULT_BILLING_CATALOG.plans[1]),
		normalizeBillingPlanRow(DEFAULT_BILLING_CATALOG.plans[2]),
	];
	const fallbackAddons = [
		normalizeBillingAddonRow(DEFAULT_BILLING_CATALOG.addons[0]),
		normalizeBillingAddonRow(DEFAULT_BILLING_CATALOG.addons[1]),
	];
	return {
		version: Math.max(1, Number.parseInt(source?.version || '1', 10) || 1),
		currency: String(source?.currency || 'GBP').trim().toUpperCase() || 'GBP',
		settings: normalizeBillingSettings(source?.settings || source),
		plans: plans.length > 0 ? plans : fallbackPlans,
		addons: addons.length > 0 ? addons : fallbackAddons,
	};
}

function loadOrCreateBillingCatalog() {
	ensureStorageLayout();
	const existing = readJsonFile(BILLING_CATALOG_PATH);
	if (existing && typeof existing === 'object') {
		const normalized = normalizeBillingCatalog(existing);
		writeAtomicJsonFile(BILLING_CATALOG_PATH, normalized);
		backupBillingCatalogSnapshot(normalized, 'bootstrap-current');
		return normalized;
	}

	const recovered = loadLatestBillingCatalogBackup();
	if (recovered) {
		console.warn('[billing] billing-catalog.json missing/invalid; restored latest backup snapshot.');
		writeAtomicJsonFile(BILLING_CATALOG_PATH, recovered);
		return recovered;
	}

	if (BILLING_STRICT_RECOVERY) {
		throw new Error('[billing] billing-catalog.json missing/invalid and no backup available. Refusing to bootstrap defaults in strict recovery mode.');
	}

	const normalized = normalizeBillingCatalog(null);
	console.warn('[billing] No billing catalog or backup found; bootstrapping defaults (strict recovery disabled).');
	writeAtomicJsonFile(BILLING_CATALOG_PATH, normalized);
	backupBillingCatalogSnapshot(normalized, 'bootstrap-default');
	return normalized;
}

function persistBillingCatalog() {
	ensureStorageLayout();
	writeAtomicJsonFile(BILLING_CATALOG_PATH, billingCatalog);
	backupBillingCatalogSnapshot(billingCatalog, 'save');
}

function loadLatestBillingCatalogBackup() {
	if (!fs.existsSync(BILLING_CATALOG_BACKUP_DIR)) return null;
	const snapshots = fs.readdirSync(BILLING_CATALOG_BACKUP_DIR)
		.filter((name) => name.startsWith('billing-catalog-') && name.endsWith('.json'))
		.map((name) => ({
			name,
			fullPath: path.join(BILLING_CATALOG_BACKUP_DIR, name),
			mtime: fs.statSync(path.join(BILLING_CATALOG_BACKUP_DIR, name)).mtimeMs,
		}))
		.sort((a, b) => b.mtime - a.mtime);

	for (const snapshot of snapshots) {
		const parsed = readJsonFile(snapshot.fullPath);
		if (!parsed || typeof parsed !== 'object') continue;
		const normalized = normalizeBillingCatalog(parsed);
		if (Array.isArray(normalized?.plans) && normalized.plans.length > 0) {
			return normalized;
		}
	}

	return null;
}

function rotateBillingCatalogBackups() {
	if (!fs.existsSync(BILLING_CATALOG_BACKUP_DIR)) return;
	const snapshots = fs.readdirSync(BILLING_CATALOG_BACKUP_DIR)
		.filter((name) => name.startsWith('billing-catalog-') && name.endsWith('.json'))
		.map((name) => ({
			name,
			fullPath: path.join(BILLING_CATALOG_BACKUP_DIR, name),
			mtime: fs.statSync(path.join(BILLING_CATALOG_BACKUP_DIR, name)).mtimeMs,
		}))
		.sort((a, b) => b.mtime - a.mtime);

	if (snapshots.length <= BILLING_CATALOG_MAX_BACKUP_FILES) return;
	for (const stale of snapshots.slice(BILLING_CATALOG_MAX_BACKUP_FILES)) {
		try {
			fs.unlinkSync(stale.fullPath);
		} catch {
			// Ignore cleanup failures to avoid blocking billing saves.
		}
	}
}

function backupBillingCatalogSnapshot(rawCatalog, reason = 'save') {
	try {
		ensureStorageLayout();
		const normalized = normalizeBillingCatalog(rawCatalog);
		const stamp = new Date().toISOString().replace(/[.:]/g, '-');
		const safeReason = String(reason || 'save').trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-');
		const backupPath = path.join(BILLING_CATALOG_BACKUP_DIR, `billing-catalog-${stamp}-${safeReason}.json`);
		writeAtomicJsonFile(backupPath, normalized);
		rotateBillingCatalogBackups();
	} catch {
		// Backup writes are best-effort and should never block billing save flow.
	}
}

function getBillingPlansCatalog() {
	return Array.isArray(billingCatalog?.plans) ? billingCatalog.plans : [];
}

function getBillingPolicy() {
	const source = billingCatalog?.settings && typeof billingCatalog.settings === 'object' ? billingCatalog.settings : {};
	return {
		enforceCharging: source?.enforceCharging === true,
		checkoutEnabled: source?.checkoutEnabled !== false,
		baseTrialDays: Math.max(0, Number.parseInt(String(source?.baseTrialDays || BILLING_BASE_TRIAL_DAYS), 10) || BILLING_BASE_TRIAL_DAYS),
		referralBonusDays: Math.max(0, Number.parseInt(String(source?.referralBonusDays || BILLING_REFERRAL_BONUS_DAYS), 10) || BILLING_REFERRAL_BONUS_DAYS),
		pageVisibilityByTier: source?.pageVisibilityByTier && typeof source.pageVisibilityByTier === 'object'
			? source.pageVisibilityByTier
			: {},
	};
}

function getBillingPlanPriceMaps() {
	const byPlan = new Map();
	const byPrice = new Map();
	for (const plan of getBillingPlansCatalog()) {
		const key = String(plan?.key || '').trim();
		const priceId = String(plan?.stripePriceId || '').trim();
		if (!key || !priceId) continue;
		byPlan.set(key, priceId);
		byPrice.set(priceId, key);
	}
	return { byPlan, byPrice };
}

function formatMoneyMinor(amountMinor, currency = 'GBP') {
	const value = Number.isFinite(Number(amountMinor)) ? Number(amountMinor) : 0;
	const major = value / 100;
	const code = String(currency || 'GBP').toUpperCase();
	if (code === 'GBP') return `\u00a3${major.toFixed(2)}`;
	return `${major.toFixed(2)} ${code}`;
}

function serializeBillingPlanForResponse(plan) {
	const normalized = normalizeBillingPlanRow(plan);
	return {
		key: normalized.key,
		label: normalized.label,
		interval: normalized.interval,
		amountMinor: normalized.amountMinor,
		amountLabel: formatMoneyMinor(normalized.amountMinor, billingCatalog?.currency),
		currency: String(billingCatalog?.currency || 'GBP').toUpperCase(),
		stripePriceId: String(normalized?.stripePriceId || '').trim(),
		configured: Boolean(String(normalized?.stripePriceId || '').trim()),
		limits: {
			maxCoaches: normalized?.limits?.maxCoaches ?? null,
			maxSwimmers: normalized?.limits?.maxSwimmers ?? null,
			maxSquads: normalized?.limits?.maxSquads ?? null,
		},
	};
}

function serializeBillingAddonForResponse(addon) {
	const normalized = normalizeBillingAddonRow(addon);
	return {
		key: normalized.key,
		label: normalized.label,
		swimmers: normalized.swimmers,
		amountMinor: normalized.amountMinor,
		amountLabel: formatMoneyMinor(normalized.amountMinor, billingCatalog?.currency),
		currency: String(billingCatalog?.currency || 'GBP').toUpperCase(),
	};
}

function normalizeBillingState(raw) {
	const fallback = getDefaultBillingState();
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return fallback;
	return {
		planKey: String(raw?.planKey || fallback.planKey).trim() || fallback.planKey,
		status: String(raw?.status || fallback.status).trim() || fallback.status,
		customerId: String(raw?.customerId || '').trim(),
		subscriptionId: String(raw?.subscriptionId || '').trim(),
		priceId: String(raw?.priceId || '').trim(),
		checkoutSessionId: String(raw?.checkoutSessionId || '').trim(),
		trialEndsAt: String(raw?.trialEndsAt || '').trim(),
		currentPeriodEnd: String(raw?.currentPeriodEnd || '').trim(),
		cancelAtPeriodEnd: raw?.cancelAtPeriodEnd === true,
		updatedAt: String(raw?.updatedAt || fallback.updatedAt).trim() || fallback.updatedAt,
	};
}

function buildBillingAccessForUser(user) {
	const role = String(user?.role || '').trim();
	const username = String(user?.username || '').trim().toLowerCase();
	const isPrimarySoftwareOwner = role === 'software-owner' && username === AUTH_PRIMARY_SOFTWARE_OWNER_USERNAME;
	const billing = normalizeBillingState(user?.billing);
	const plan = getBillingPlansCatalog().find((row) => String(row?.key || '').trim() === String(billing?.planKey || '').trim()) || null;
	const planLimits = {
		maxCoaches: plan?.limits?.maxCoaches ?? null,
		maxSwimmers: plan?.limits?.maxSwimmers ?? null,
		maxSquads: plan?.limits?.maxSquads ?? null,
	};
	const isBillingEnabled = Boolean(stripeClient);
	const isBillingEnforced = isBillingEnabled && BILLING_ENFORCED;
	const isPaidStatus = new Set(['active', 'trialing']);
	const isPaid = isPrimarySoftwareOwner || isPaidStatus.has(String(billing?.status || '').trim().toLowerCase());

	return {
		billingEnabled: isBillingEnabled,
		enforced: isBillingEnforced,
		isPaid,
		canUsePremium: isPaid || !isBillingEnforced,
		canWriteData: isPaid || !isBillingEnforced,
		canManageBilling: isPrimarySoftwareOwner || isPaid,
		planLimits,
		planLabel: String(plan?.label || billing?.planKey || 'Free').trim(),
		billing,
	};
}

function buildAuthUserPayload(user) {
	const normalizedUser = user && typeof user === 'object' ? user : {};
	const access = buildBillingAccessForUser(normalizedUser);
	const resolvedTenantId = resolveTenantKeyFromUser(normalizedUser);
	return {
		username: String(normalizedUser?.username || '').trim(),
		role: String(normalizedUser?.role || 'viewer').trim() || 'viewer',
		tenantId: String(resolvedTenantId || '').trim(),
		onboardingRequired: Boolean(normalizedUser?.onboardingCompletedAt ? false : true),
		billing: access.billing,
		access,
	};
}

function parseEpochSecondsToIso(seconds) {
	const value = Number.parseInt(seconds, 10);
	if (!Number.isFinite(value) || value <= 0) return '';
	return new Date(value * 1000).toISOString();
}

function resolveSubscriptionPlanFromStripe(subscription) {
	const { byPrice } = getBillingPlanPriceMaps();
	const linePriceId = String(subscription?.items?.data?.[0]?.price?.id || '').trim();
	if (linePriceId && byPrice.has(linePriceId)) {
		return { planKey: byPrice.get(linePriceId), priceId: linePriceId };
	}
	if (String(subscription?.status || '').trim().toLowerCase() === 'active') {
		return { planKey: 'tier-1', priceId: linePriceId };
	}
	return { planKey: 'free', priceId: linePriceId };
}

function upsertUserBillingByUsername(username, partialBilling) {
	const target = String(username || '').trim();
	if (!target) return null;
	const index = authUsers.findIndex((row) => String(row?.username || '').trim() === target);
	if (index < 0) return null;
	const previous = normalizeBillingState(authUsers[index]?.billing);
	authUsers[index] = {
		...authUsers[index],
		billing: normalizeBillingState({
			...previous,
			...(partialBilling && typeof partialBilling === 'object' ? partialBilling : {}),
			updatedAt: new Date().toISOString(),
		}),
	};
	persistAuthUsers();
	return authUsers[index];
}

function upsertUserBillingByCustomerId(customerId, partialBilling) {
	const target = String(customerId || '').trim();
	if (!target) return null;
	const index = authUsers.findIndex((row) => String(row?.billing?.customerId || '').trim() === target);
	if (index < 0) return null;
	const previous = normalizeBillingState(authUsers[index]?.billing);
	authUsers[index] = {
		...authUsers[index],
		billing: normalizeBillingState({
			...previous,
			...(partialBilling && typeof partialBilling === 'object' ? partialBilling : {}),
			customerId: target,
			updatedAt: new Date().toISOString(),
		}),
	};
	persistAuthUsers();
	return authUsers[index];
}

async function handleStripeSubscriptionEvent(subscriptionObject) {
	const subscription = subscriptionObject && typeof subscriptionObject === 'object' ? subscriptionObject : {};
	const customerId = String(subscription?.customer || '').trim();
	if (!customerId) return;

	const { planKey, priceId } = resolveSubscriptionPlanFromStripe(subscription);
	const nextBilling = {
		customerId,
		subscriptionId: String(subscription?.id || '').trim(),
		status: String(subscription?.status || 'inactive').trim() || 'inactive',
		planKey,
		priceId,
		trialEndsAt: parseEpochSecondsToIso(subscription?.trial_end),
		currentPeriodEnd: parseEpochSecondsToIso(subscription?.current_period_end),
		cancelAtPeriodEnd: subscription?.cancel_at_period_end === true,
		updatedAt: new Date().toISOString(),
	};

	const updated = upsertUserBillingByCustomerId(customerId, nextBilling);
	if (updated) return;

	const usernameFromMetadata = String(subscription?.metadata?.username || '').trim();
	if (usernameFromMetadata) {
		upsertUserBillingByUsername(usernameFromMetadata, nextBilling);
	}
}

function findAuthUserByCustomerId(customerId) {
	const target = String(customerId || '').trim();
	if (!target) return null;
	return authUsers.find((row) => String(row?.billing?.customerId || '').trim() === target) || null;
}

function resolveBillingPlanLabel(planKey) {
	const key = String(planKey || '').trim();
	if (!key) return 'Free';
	const matched = getBillingPlansCatalog().find((plan) => String(plan?.key || '').trim() === key);
	return String(matched?.label || key || 'Free').trim();
}

function resolveAmountLabelFromInvoice(invoice) {
	const amountMinor = Math.max(0, Number.parseInt(invoice?.amount_paid ?? invoice?.amount_due ?? 0, 10) || 0);
	const currency = String(invoice?.currency || billingCatalog?.currency || 'GBP').trim().toUpperCase() || 'GBP';
	return formatMoneyMinor(amountMinor, currency);
}

function resolvePlanKeyFromInvoice(invoice) {
	const { byPrice } = getBillingPlanPriceMaps();
	const priceId = String(invoice?.lines?.data?.[0]?.price?.id || '').trim();
	if (!priceId) return '';
	return String(byPrice.get(priceId) || '').trim();
}

async function deliverBillingEmail({ user, subject, lines }) {
	try {
		if (!BILLING_EMAIL_NOTIFICATIONS_ENABLED) return { mode: 'skipped', reason: 'disabled' };
		const email = String(user?.email || '').trim();
		if (!AUTH_EMAIL_PATTERN.test(email)) return { mode: 'skipped', reason: 'invalid_email' };
		const username = String(user?.username || '').trim();
		const fullName = String(user?.fullName || '').trim();
		const greetingName = fullName || username || 'coach';
		const textBody = [`Hi ${greetingName},`, '', ...lines, '', 'AthlyraX Billing'].join('\n');

		if (!AUTH_SMTP_HOST || !AUTH_SMTP_FROM) {
			console.log(`[billing-email] ${email}\n${subject}\n${textBody}`);
			return { mode: 'console' };
		}

		const transport = getAuthResetMailTransport();
		await transport.sendMail({
			from: AUTH_SMTP_FROM,
			to: email,
			subject,
			text: textBody,
		});
		return { mode: 'smtp' };
	} catch (error) {
		console.warn('[billing-email] Could not send billing email:', error instanceof Error ? error.message : error);
		return { mode: 'error' };
	}
}

async function sendBillingCheckoutCompletedEmail(session) {
	const payload = session && typeof session === 'object' ? session : {};
	const username = String(payload?.client_reference_id || payload?.metadata?.username || '').trim();
	const customerId = String(payload?.customer || '').trim();
	const user = findAuthUser(username) || findAuthUserByCustomerId(customerId);
	if (!user) return;

	const billing = normalizeBillingState(user?.billing);
	const planKey = String(payload?.metadata?.planKey || billing?.planKey || '').trim();
	const planLabel = resolveBillingPlanLabel(planKey);
	const matchedPlan = getBillingPlansCatalog().find((plan) => String(plan?.key || '').trim() === planKey);
	const amountLabel = matchedPlan ? formatMoneyMinor(matchedPlan.amountMinor, billingCatalog?.currency) : 'See invoice';

	await deliverBillingEmail({
		user,
		subject: 'AthlyraX subscription checkout received',
		lines: [
			'Thank you. Your subscription checkout has been received.',
			`Tier: ${planLabel}`,
			`Amount: ${amountLabel}`,
			'Invoice details will follow by email after payment is finalized.',
		],
	});
}

async function sendBillingInvoiceEmail(invoice, kind) {
	const payload = invoice && typeof invoice === 'object' ? invoice : {};
	const customerId = String(payload?.customer || '').trim();
	const user = findAuthUserByCustomerId(customerId);
	if (!user) return;

	const billing = normalizeBillingState(user?.billing);
	const planKeyFromInvoice = resolvePlanKeyFromInvoice(payload);
	const planLabel = resolveBillingPlanLabel(planKeyFromInvoice || billing?.planKey);
	const amountLabel = resolveAmountLabelFromInvoice(payload);
	const invoiceNumber = String(payload?.number || payload?.id || '').trim() || 'Not available';
	const hostedInvoiceUrl = String(payload?.hosted_invoice_url || '').trim();
	const invoiceUrlLabel = hostedInvoiceUrl || 'Not available';
	const failed = String(kind || '').trim().toLowerCase() === 'failed';

	await deliverBillingEmail({
		user,
		subject: failed ? 'AthlyraX invoice payment failed' : 'AthlyraX invoice receipt',
		lines: [
			failed ? 'We could not process your latest invoice payment.' : 'Your invoice payment has been confirmed.',
			`Tier: ${planLabel}`,
			`Amount: ${amountLabel}`,
			`Invoice: ${invoiceNumber}`,
			`Invoice link: ${invoiceUrlLabel}`,
		],
	});
}

function normalizeAuthUserRows(rows) {
	if (!Array.isArray(rows)) return [];
	return rows
		.map((row) => {
			const username = String(row?.username || '').trim();
			const role = String(row?.role || '').trim() || 'viewer';
			const fromHash = String(row?.passwordHash || '').trim();
			const fromPassword = String(row?.password || '');
			const tokenValidAfter = Math.max(0, Number.parseInt(row?.tokenValidAfter || '0', 10) || 0);
			const createdVia = String(row?.createdVia || '').trim() || 'legacy';
			const createdAt = String(row?.createdAt || '').trim() || new Date().toISOString();
			const fullName = String(row?.fullName || '').trim();
			const email = String(row?.email || '').trim();
			const phone = String(row?.phone || '').trim();
			const swimClub = String(row?.swimClub || '').trim();
			const teamName = String(row?.teamName || '').trim();
			const city = String(row?.city || '').trim();
			const country = String(row?.country || '').trim();
			const isApproved = row?.isApproved !== false;
			const onboardingCompletedAt = String(row?.onboardingCompletedAt || '').trim();
			const referralCode = String(row?.referralCode || '').trim().toUpperCase();
			const referredByUsername = String(row?.referredByUsername || '').trim();
			const partnerCommissionPercent = Math.max(0, Number.parseInt(row?.partnerCommissionPercent || '0', 10) || 0);
			const partnerCommissionMonths = Math.max(0, Number.parseInt(row?.partnerCommissionMonths || '0', 10) || 0);
			const partnerAttributionAt = String(row?.partnerAttributionAt || '').trim();
			const billing = normalizeBillingState(row?.billing);
			const tenantId = normalizeTenantId(row?.tenantId) || resolveTenantKeyFromUser({
				username,
				role,
				swimClub,
				teamName,
			});
			const passwordHash = fromHash || (fromPassword ? hashPassword(fromPassword) : '');
			if (!username || !passwordHash) return null;
			return {
				username,
				role,
				passwordHash,
				tokenValidAfter,
				createdVia,
				createdAt,
				fullName,
				email,
				phone,
				swimClub,
				teamName,
				city,
				country,
				isApproved,
				onboardingCompletedAt,
				referralCode,
				referredByUsername,
				partnerCommissionPercent,
				partnerCommissionMonths,
				partnerAttributionAt,
				tenantId,
				billing,
			};
		})
		.filter(Boolean);
}

function resolveTrialDaysForUser(user) {
	const normalized = user && typeof user === 'object' ? user : {};
	const hasReferralAttribution = normalized?.inviteCodeUsed === true
		|| String(normalized?.createdVia || '').trim() === 'self-signup-invite'
		|| Boolean(String(normalized?.referralCode || '').trim());
	return Math.max(0, BILLING_BASE_TRIAL_DAYS + (hasReferralAttribution ? BILLING_REFERRAL_BONUS_DAYS : 0));
}

function normalizeInviteRows(rows) {
	if (!Array.isArray(rows)) return [];
	return rows
		.map((row) => {
			const code = String(row?.code || '').trim();
			const role = String(row?.role || 'assistant-coach').trim() || 'assistant-coach';
			const createdBy = String(row?.createdBy || '').trim() || 'system';
			const createdAt = String(row?.createdAt || '').trim() || new Date().toISOString();
			const expiresAt = String(row?.expiresAt || '').trim();
			const targetEmail = String(row?.targetEmail || '').trim();
			const tenantId = normalizeTenantId(row?.tenantId);
			const swimClub = String(row?.swimClub || '').trim();
			const teamName = String(row?.teamName || '').trim();
			const maxUses = Math.max(1, Number.parseInt(row?.maxUses || '1', 10) || 1);
			const usedCount = Math.max(0, Number.parseInt(row?.usedCount || '0', 10) || 0);
			const disabled = row?.disabled === true;
			if (!code || !expiresAt) return null;
			return {
				code,
				role,
				createdBy,
				createdAt,
				expiresAt,
				targetEmail,
				tenantId,
				swimClub,
				teamName,
				maxUses,
				usedCount,
				disabled,
			};
		})
		.filter(Boolean);
}

function loadOrCreateAuthInvites() {
	ensureStorageLayout();
	const fromFile = normalizeInviteRows(readJsonFile(AUTH_INVITES_PATH));
	if (fromFile.length > 0) return fromFile;
	writeJsonFile(AUTH_INVITES_PATH, []);
	return [];
}

function persistAuthInvites() {
	const payload = normalizeInviteRows(authInvites);
	writeAtomicJsonFile(AUTH_INVITES_PATH, payload);
}

function makeInviteCode() {
	const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
	let raw = '';
	for (let index = 0; index < 12; index += 1) {
		raw += alphabet[Math.floor(Math.random() * alphabet.length)];
	}
	return `${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8, 12)}`;
}

function cleanExpiredInvites() {
	const now = Date.now();
	for (let index = authInvites.length - 1; index >= 0; index -= 1) {
		const invite = authInvites[index];
		const expiresAtMs = Date.parse(String(invite?.expiresAt || ''));
		const fullyUsed = Number(invite?.usedCount || 0) >= Number(invite?.maxUses || 1);
		if (invite?.disabled || fullyUsed || !Number.isFinite(expiresAtMs) || expiresAtMs <= now) {
			authInvites.splice(index, 1);
		}
	}
}

function findUsableInvite(inviteCode, email) {
	const normalizedCode = String(inviteCode || '').trim().toUpperCase();
	if (!normalizedCode) return null;
	const normalizedEmail = String(email || '').trim().toLowerCase();
	const now = Date.now();
	const invite = authInvites.find((row) => String(row?.code || '').trim().toUpperCase() === normalizedCode);
	if (!invite) return null;
	if (invite.disabled) return null;
	const expiresAtMs = Date.parse(String(invite?.expiresAt || ''));
	if (!Number.isFinite(expiresAtMs) || expiresAtMs <= now) return null;
	if (Number(invite?.usedCount || 0) >= Number(invite?.maxUses || 1)) return null;
	const targetEmail = String(invite?.targetEmail || '').trim().toLowerCase();
	if (targetEmail && targetEmail !== normalizedEmail) return null;
	return invite;
}

function findAuthUser(username) {
	const target = String(username || '').trim();
	if (!target) return null;
	return authUsers.find((row) => String(row?.username || '').trim() === target) || null;
}

function getTokenValidAfter(user) {
	return Math.max(0, Number.parseInt(user?.tokenValidAfter || '0', 10) || 0);
}

function getNowEpochSeconds() {
	return Math.floor(Date.now() / 1000);
}

function loadOrCreateAuthUsers() {
	ensureStorageLayout();

	const sanitizeDemoUsers = (rows) => {
		if (AUTH_ENABLE_DEMO_SEED_USERS) return rows;
		return rows.filter((row) => !DEMO_SEED_USERNAMES.has(String(row?.username || '').trim().toLowerCase()));
	};

	const fromFile = normalizeAuthUserRows(readJsonFile(AUTH_USERS_PATH));
	const cleanedFromFile = sanitizeDemoUsers(fromFile);
	const fromBackup = normalizeAuthUserRows(readJsonFile(AUTH_USERS_BACKUP_PATH));
	const cleanedFromBackup = sanitizeDemoUsers(fromBackup);

	if (
		AUTH_PREVENT_USER_SHRINK
		&& cleanedFromFile.length > 0
		&& cleanedFromBackup.length > 0
		&& cleanedFromFile.length < cleanedFromBackup.length
	) {
		// Warn only: restoring by count can resurrect stale/deleted users after legitimate admin changes.
		console.warn(`[auth] Detected auth user shrink (${cleanedFromFile.length} < ${cleanedFromBackup.length}); keeping primary store and refreshing backup.`);
	}

	if (cleanedFromFile.length > 0) {
		if (cleanedFromFile.length !== fromFile.length) {
			writeJsonFile(AUTH_USERS_PATH, cleanedFromFile);
		}
		writeJsonFile(AUTH_USERS_BACKUP_PATH, cleanedFromFile);
		return { users: cleanedFromFile, source: 'file' };
	}

	if (cleanedFromBackup.length > 0) {
		writeJsonFile(AUTH_USERS_PATH, cleanedFromBackup);
		if (cleanedFromBackup.length !== fromBackup.length) {
			writeJsonFile(AUTH_USERS_BACKUP_PATH, cleanedFromBackup);
		}
		return { users: cleanedFromBackup, source: 'backup' };
	}

	const fromEnv = normalizeAuthUserRows(parseAuthUsersFromEnv());
	const cleanedFromEnv = sanitizeDemoUsers(fromEnv);
	if (cleanedFromEnv.length > 0) {
		writeJsonFile(AUTH_USERS_PATH, cleanedFromEnv);
		writeJsonFile(AUTH_USERS_BACKUP_PATH, cleanedFromEnv);
		return { users: cleanedFromEnv, source: 'env' };
	}

	const fromDefaults = sanitizeDemoUsers(normalizeAuthUserRows(DEFAULT_AUTH_USERS));
	writeJsonFile(AUTH_USERS_PATH, fromDefaults);
	writeJsonFile(AUTH_USERS_BACKUP_PATH, fromDefaults);
	return { users: fromDefaults, source: 'defaults' };
}

function toBase64Url(value) {
	return Buffer.from(value, 'utf8')
		.toString('base64')
		.replace(/\+/g, '-')
		.replace(/\//g, '_')
		.replace(/=+$/g, '');
}

function fromBase64Url(value) {
	const normalized = String(value || '').replace(/-/g, '+').replace(/_/g, '/');
	const pad = normalized.length % 4;
	const padded = normalized + (pad ? '='.repeat(4 - pad) : '');
	return Buffer.from(padded, 'base64').toString('utf8');
}

function signTokenPayload(payloadBase64) {
	return crypto
		.createHmac('sha256', AUTH_SECRET)
		.update(payloadBase64)
		.digest('base64')
		.replace(/\+/g, '-')
		.replace(/\//g, '_')
		.replace(/=+$/g, '');
}

function issueAuthToken(user) {
	const now = getNowEpochSeconds();
	const payload = {
		sub: String(user?.username || ''),
		role: String(user?.role || 'viewer'),
		iat: now,
		exp: now + AUTH_TOKEN_TTL_SECONDS,
	};
	const payloadBase64 = toBase64Url(JSON.stringify(payload));
	const signature = signTokenPayload(payloadBase64);
	return `v1.${payloadBase64}.${signature}`;
}

function verifyAuthToken(token) {
	const parts = String(token || '').split('.');
	if (parts.length !== 3 || parts[0] !== 'v1') return null;
	const payloadBase64 = parts[1];
	const signature = parts[2];
	const expectedSignature = signTokenPayload(payloadBase64);
	if (!safeEqualText(signature, expectedSignature)) return null;
	try {
		const payload = JSON.parse(fromBase64Url(payloadBase64));
		const now = getNowEpochSeconds();
		if (!payload?.sub || !payload?.role) return null;
		if (!Number.isFinite(payload?.iat)) return null;
		if (!Number.isFinite(payload?.exp) || payload.exp <= now) return null;
		const user = findAuthUser(payload.sub);
		if (!user) return null;
		if (payload.iat < getTokenValidAfter(user)) return null;
		return {
			username: String(user.username),
			role: String(user.role || 'viewer'),
			iat: Number(payload.iat),
			exp: Number(payload.exp),
		};
	} catch {
		return null;
	}
}

function safeEqualText(left, right) {
	const leftBuf = Buffer.from(String(left || ''), 'utf8');
	const rightBuf = Buffer.from(String(right || ''), 'utf8');
	if (leftBuf.length !== rightBuf.length) return false;
	return crypto.timingSafeEqual(leftBuf, rightBuf);
}

function parseAllowedOrigins() {
	const raw = String(process.env.ALLOWED_ORIGINS || '').trim();
	if (!raw) return new Set(DEFAULT_ALLOWED_ORIGINS);
	return new Set(
		raw
			.split(',')
			.map((value) => String(value || '').trim())
			.filter(Boolean)
	);
}

function isOriginAllowed(origin) {
	if (!origin) return true;
	return allowedOrigins.has(String(origin).trim());
}

function extractBearerToken(req) {
	const authHeader = String(req.headers?.authorization || '').trim();
	if (!authHeader.toLowerCase().startsWith('bearer ')) return '';
	return authHeader.slice(7).trim();
}

function attachAuthContext(req, _res, next) {
	const token = extractBearerToken(req);
	req.auth = token ? verifyAuthToken(token) : null;
	if (req.auth?.username) {
		authPresenceByUser.set(String(req.auth.username), Date.now());
	}
	next();
}

function getAuthPresenceSummary() {
	const now = Date.now();
	for (const [username, lastSeenAt] of authPresenceByUser.entries()) {
		if (now - Number(lastSeenAt || 0) > AUTH_PRESENCE_WINDOW_MS) {
			authPresenceByUser.delete(username);
		}
	}

	const connectedUsers = Array.from(authPresenceByUser.entries())
		.map(([username, lastSeenAt]) => {
			const row = authUsers.find((item) => String(item?.username || '') === String(username));
			return {
				username,
				role: String(row?.role || 'viewer').trim() || 'viewer',
				lastSeenAt: new Date(lastSeenAt).toISOString(),
			};
		})
		.sort((a, b) => String(b.lastSeenAt).localeCompare(String(a.lastSeenAt)));

	const connectedByRole = connectedUsers.reduce((acc, row) => {
		const role = String(row?.role || 'viewer').trim() || 'viewer';
		acc[role] = Number(acc[role] || 0) + 1;
		return acc;
	}, {});

	const totalUsers = authUsers.length;
	const totalCoachUsers = authUsers.filter((row) => {
		const role = String(row?.role || '').trim();
		return role === 'software-owner' || role === 'head-coach' || role === 'assistant-coach';
	}).length;
	const signedUpUsers = authUsers
		.filter((row) => {
			const createdVia = String(row?.createdVia || '').trim();
			const inviteCodeUsed = row?.inviteCodeUsed === true;
			return createdVia === 'self-signup' && !inviteCodeUsed;
		})
		.map((row) => ({
			username: String(row?.username || '').trim(),
			role: String(row?.role || 'viewer').trim() || 'viewer',
			createdAt: String(row?.createdAt || '').trim(),
			fullName: String(row?.fullName || '').trim(),
			email: String(row?.email || '').trim(),
			phone: String(row?.phone || '').trim(),
			swimClub: String(row?.swimClub || '').trim(),
			teamName: String(row?.teamName || '').trim(),
			city: String(row?.city || '').trim(),
			country: String(row?.country || '').trim(),
			lastSeenAt: authPresenceByUser.has(String(row?.username || '').trim())
				? new Date(authPresenceByUser.get(String(row?.username || '').trim())).toISOString()
				: '',
		}))
		.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));

	return {
		windowMs: AUTH_PRESENCE_WINDOW_MS,
		connectedCount: connectedUsers.length,
		connectedUsers,
		connectedByRole,
		totalUsers,
		totalCoachUsers,
		signedUpUsers,
	};
}

function requireAuth(req, res, next) {
	if (!AUTH_REQUIRED) return next();
	if (req.auth) return next();
	appendAuthAuditEvent({
		action: 'unauthorized_access_blocked',
		req,
		status: 'blocked',
		reason: 'auth_required',
		details: { method: req.method, path: req.path },
	});
	res.status(401).json({ error: 'Authentication required.' });
}

function requireWriteRole(req, res, next) {
	if (!AUTH_REQUIRED) return next();
	const role = String(req.auth?.role || '').trim();
	if (WRITE_ALLOWED_ROLES.has(role)) return next();
	res.status(403).json({ error: 'Insufficient role privileges for write operation.' });
}

function requireBillingWriteAccess(req, res, next) {
	if (!AUTH_REQUIRED) return next();
	if (!BILLING_ENFORCED || !stripeClient) return next();
	const user = findAuthUser(String(req.auth?.username || '').trim());
	const access = buildBillingAccessForUser(user || req.auth);
	if (access.canWriteData) {
		next();
		return;
	}
	res.status(402).json({
		error: 'Active subscription required for write operations.',
		access,
	});
}

function requireStrictAuth(req, res, next) {
	if (!req.auth) {
		appendAuthAuditEvent({
			action: 'unauthorized_access_blocked',
			req,
			status: 'blocked',
			reason: 'strict_auth_required',
			details: { method: req.method, path: req.path },
		});
		res.status(401).json({ error: 'Authentication required.' });
		return;
	}
	next();
}

function requireAdminRole(req, res, next) {
	const role = String(req.auth?.role || '').trim();
	if (ADMIN_ALLOWED_ROLES.has(role)) {
		next();
		return;
	}
	appendAuthAuditEvent({
		action: 'unauthorized_access_blocked',
		req,
		status: 'blocked',
		reason: 'admin_role_required',
		details: { method: req.method, path: req.path, role },
	});
	res.status(403).json({ error: 'Admin privileges required.' });
}

function requireSoftwareOwnerRole(req, res, next) {
	const role = String(req.auth?.role || '').trim();
	const username = String(req.auth?.username || '').trim().toLowerCase();
	if (role === 'software-owner' && username === AUTH_PRIMARY_SOFTWARE_OWNER_USERNAME) {
		next();
		return;
	}
	appendAuthAuditEvent({
		action: 'unauthorized_access_blocked',
		req,
		status: 'blocked',
		reason: 'software_owner_required',
		details: { method: req.method, path: req.path, role, username },
	});
	res.status(403).json({ error: 'Primary software owner privileges required.' });
}

function sanitizeAuditText(value, fallback = '') {
	const normalized = String(value ?? fallback)
		.replace(/\r/g, ' ')
		.replace(/\n/g, ' ')
		.trim();
	return normalized || fallback;
}

function rotateAuthAuditIfNeeded() {
	try {
		if (!fs.existsSync(AUTH_AUDIT_ACTIVE_PATH)) return;
		const stat = fs.statSync(AUTH_AUDIT_ACTIVE_PATH);
		if (!Number.isFinite(stat.size) || stat.size < AUTH_AUDIT_MAX_BYTES) return;

		const stamp = new Date().toISOString().replace(/[:.]/g, '-');
		const archivePath = path.join(AUTH_AUDIT_DIR, `events-${stamp}.jsonl`);
		fs.renameSync(AUTH_AUDIT_ACTIVE_PATH, archivePath);

		const archives = fs.readdirSync(AUTH_AUDIT_DIR)
			.filter((name) => /^events-.*\.jsonl$/i.test(name))
			.map((name) => ({
				name,
				fullPath: path.join(AUTH_AUDIT_DIR, name),
				mtime: fs.statSync(path.join(AUTH_AUDIT_DIR, name)).mtimeMs,
			}))
			.sort((a, b) => b.mtime - a.mtime);

		pruneAuthAuditFiles(archives.map((row) => row.fullPath), AUTH_AUDIT_MAX_ARCHIVE_FILES);
	} catch {
		// Ignore rotation failures to keep auth flow available.
	}
}

function pruneAuthAuditFiles(paths, keepCount) {
	for (const stalePath of (Array.isArray(paths) ? paths : []).slice(keepCount)) {
		try {
			fs.unlinkSync(stalePath);
		} catch {
			// Ignore cleanup failures for best-effort retention.
		}
	}
}

function createAuthAuditBackupIfDue() {
	try {
		if (!fs.existsSync(AUTH_AUDIT_ACTIVE_PATH)) return;
		const activeStat = fs.statSync(AUTH_AUDIT_ACTIVE_PATH);
		if (!Number.isFinite(activeStat.size) || activeStat.size <= 0) return;

		const backups = fs.readdirSync(AUTH_AUDIT_BACKUP_DIR)
			.filter((name) => /^auth-audit-backup-.*\.jsonl$/i.test(name))
			.map((name) => ({
				fullPath: path.join(AUTH_AUDIT_BACKUP_DIR, name),
				mtime: fs.statSync(path.join(AUTH_AUDIT_BACKUP_DIR, name)).mtimeMs,
			}))
			.sort((a, b) => b.mtime - a.mtime);

		const newestBackupTime = backups[0]?.mtime || 0;
		if (Date.now() - newestBackupTime < AUTH_AUDIT_BACKUP_INTERVAL_MS) return;

		const stamp = new Date().toISOString().replace(/[:.]/g, '-');
		const backupPath = path.join(AUTH_AUDIT_BACKUP_DIR, `auth-audit-backup-${stamp}.jsonl`);
		fs.copyFileSync(AUTH_AUDIT_ACTIVE_PATH, backupPath);

		const nextBackups = [backupPath, ...backups.map((entry) => entry.fullPath)];
		pruneAuthAuditFiles(nextBackups, AUTH_AUDIT_MAX_BACKUP_FILES);
	} catch {
		// Ignore backup failures to keep auth flow available.
	}
}

function appendAuthAuditEvent({ action, req, status = 'info', target = '', reason = '', details = {}, actor = '', actorRole = '' }) {
	try {
		ensureStorageLayout();
		const resolvedActor = sanitizeAuditText(actor || req?.auth?.username || 'anonymous', 'anonymous');
		const resolvedActorRole = sanitizeAuditText(actorRole || req?.auth?.role || 'unknown', 'unknown');
		const ip = sanitizeAuditText(resolveClientKey(req), 'unknown');
		const method = sanitizeAuditText(req?.method || '', '');
		const routePath = sanitizeAuditText(req?.path || '', '');
		const payload = {
			at: new Date().toISOString(),
			action: sanitizeAuditText(action, 'unknown_action'),
			status: sanitizeAuditText(status, 'info'),
			actor: resolvedActor,
			actorRole: resolvedActorRole,
			target: sanitizeAuditText(target, ''),
			reason: sanitizeAuditText(reason, ''),
			ip,
			method,
			path: routePath,
			details: details && typeof details === 'object' ? details : {},
		};

		rotateAuthAuditIfNeeded();
		fs.appendFileSync(AUTH_AUDIT_ACTIVE_PATH, `${JSON.stringify(payload)}\n`, 'utf8');
		createAuthAuditBackupIfDue();
	} catch {
		// Best-effort logging only.
	}
}

function readAuthAuditEvents(limit = 250, filters = {}) {
	const requested = Number.parseInt(limit, 10);
	const safeLimit = Math.min(AUTH_AUDIT_FETCH_MAX_ROWS, Math.max(1, Number.isFinite(requested) ? requested : 250));
	const actionFilter = String(filters?.action || '').trim().toLowerCase();
	const statusFilter = String(filters?.status || '').trim().toLowerCase();
	const actorFilter = String(filters?.actor || '').trim().toLowerCase();
	const queryFilter = String(filters?.query || '').trim().toLowerCase();
	if (!fs.existsSync(AUTH_AUDIT_DIR)) return [];

	const archivePaths = fs.readdirSync(AUTH_AUDIT_DIR)
		.filter((name) => /^events-.*\.jsonl$/i.test(name))
		.map((name) => path.join(AUTH_AUDIT_DIR, name))
		.sort((a, b) => {
			try {
				return fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs;
			} catch {
				return 0;
			}
		});

	const allPaths = [AUTH_AUDIT_ACTIVE_PATH, ...archivePaths].filter((filePath) => fs.existsSync(filePath));
	const rows = [];
	for (const filePath of allPaths) {
		let raw = '';
		try {
			raw = fs.readFileSync(filePath, 'utf8');
		} catch {
			continue;
		}
		const lines = String(raw || '').split(/\r?\n/).filter(Boolean).reverse();
		for (const line of lines) {
			try {
				const parsed = JSON.parse(line);
				if (actionFilter && String(parsed?.action || '').toLowerCase() !== actionFilter) continue;
				if (statusFilter && String(parsed?.status || '').toLowerCase() !== statusFilter) continue;
				if (actorFilter && String(parsed?.actor || '').toLowerCase().indexOf(actorFilter) === -1) continue;
				if (queryFilter) {
					const text = [
						String(parsed?.action || ''),
						String(parsed?.status || ''),
						String(parsed?.actor || ''),
						String(parsed?.actorRole || ''),
						String(parsed?.target || ''),
						String(parsed?.path || ''),
						String(parsed?.reason || ''),
						String(parsed?.method || ''),
						String(parsed?.ip || ''),
					].join(' ').toLowerCase();
					if (text.indexOf(queryFilter) === -1) continue;
				}
				rows.push(parsed);
			} catch {
				// Ignore malformed line and keep reading.
			}
			if (rows.length >= safeLimit) return rows;
		}
	}

	return rows;
}

function resolveClientKey(req) {
	const forwarded = String(req.headers?.['x-forwarded-for'] || '').trim();
	if (forwarded) {
		return forwarded.split(',')[0].trim();
	}
	return String(req.socket?.remoteAddress || req.ip || 'unknown').trim() || 'unknown';
}

function nowMs() {
	return Date.now();
}

function getOrCreateRateBucket(store, key, windowMs) {
	const currentNow = nowMs();
	const existing = store.get(key);
	if (!existing || existing.resetAt <= currentNow) {
		const created = { count: 0, resetAt: currentNow + windowMs };
		store.set(key, created);
		return created;
	}
	return existing;
}

function pruneRateBuckets(store) {
	const currentNow = nowMs();
	for (const [key, bucket] of store.entries()) {
		if (!bucket || bucket.resetAt <= currentNow) {
			store.delete(key);
		}
	}
}

function checkRateLimit({ store, key, windowMs, maxAttempts }) {
	pruneRateBuckets(store);
	const bucket = getOrCreateRateBucket(store, key, windowMs);
	bucket.count += 1;
	const remaining = Math.max(0, maxAttempts - bucket.count);
	const resetMs = Math.max(0, bucket.resetAt - nowMs());
	return {
		allowed: bucket.count <= maxAttempts,
		remaining,
		resetSeconds: Math.ceil(resetMs / 1000),
	};
}

function applyRateLimitHeaders(res, { maxAttempts, remaining, resetSeconds }) {
	res.setHeader('X-RateLimit-Limit', String(maxAttempts));
	res.setHeader('X-RateLimit-Remaining', String(remaining));
	res.setHeader('X-RateLimit-Reset', String(resetSeconds));
}

function requireLoginRateLimit(req, res, next) {
	const clientKey = resolveClientKey(req);
	const username = String(req.body?.username || '').trim().toLowerCase();
	const key = username ? `${clientKey}:${username}` : clientKey;
	const result = checkRateLimit({
		store: loginRateBuckets,
		key,
		windowMs: AUTH_LOGIN_RATE_WINDOW_MS,
		maxAttempts: AUTH_LOGIN_RATE_MAX_ATTEMPTS,
	});
	applyRateLimitHeaders(res, {
		maxAttempts: AUTH_LOGIN_RATE_MAX_ATTEMPTS,
		remaining: result.remaining,
		resetSeconds: result.resetSeconds,
	});
	if (!result.allowed) {
		appendAuthAuditEvent({
			action: 'rate_limit_blocked',
			req,
			status: 'blocked',
			reason: 'login_rate_limit',
			details: { limit: AUTH_LOGIN_RATE_MAX_ATTEMPTS, windowMs: AUTH_LOGIN_RATE_WINDOW_MS },
		});
		res.setHeader('Retry-After', String(result.resetSeconds));
		res.status(429).json({ error: 'Too many login attempts. Please wait and retry.' });
		return;
	}
	next();
}

function requireAdminRateLimit(req, res, next) {
	const clientKey = resolveClientKey(req);
	const userKey = String(req.auth?.username || 'anonymous').trim().toLowerCase();
	const key = `${clientKey}:${userKey}`;
	const result = checkRateLimit({
		store: adminRateBuckets,
		key,
		windowMs: AUTH_ADMIN_RATE_WINDOW_MS,
		maxAttempts: AUTH_ADMIN_RATE_MAX_ATTEMPTS,
	});
	applyRateLimitHeaders(res, {
		maxAttempts: AUTH_ADMIN_RATE_MAX_ATTEMPTS,
		remaining: result.remaining,
		resetSeconds: result.resetSeconds,
	});
	if (!result.allowed) {
		appendAuthAuditEvent({
			action: 'rate_limit_blocked',
			req,
			status: 'blocked',
			reason: 'admin_rate_limit',
			details: { limit: AUTH_ADMIN_RATE_MAX_ATTEMPTS, windowMs: AUTH_ADMIN_RATE_WINDOW_MS },
		});
		res.setHeader('Retry-After', String(result.resetSeconds));
		res.status(429).json({ error: 'Too many admin requests. Please wait and retry.' });
		return;
	}
	next();
}

function sanitizeAuthUsers(users) {
	return Array.isArray(users)
		? users.map((row) => ({
			username: String(row?.username || '').trim(),
			role: String(row?.role || 'viewer').trim() || 'viewer',
			tenantId: String(row?.tenantId || resolveTenantKeyFromUser(row) || '').trim(),
			createdVia: String(row?.createdVia || 'legacy').trim() || 'legacy',
			createdAt: String(row?.createdAt || '').trim(),
			fullName: String(row?.fullName || '').trim(),
			email: String(row?.email || '').trim(),
			phone: String(row?.phone || '').trim(),
			swimClub: String(row?.swimClub || '').trim(),
			teamName: String(row?.teamName || '').trim(),
			city: String(row?.city || '').trim(),
			country: String(row?.country || '').trim(),
			isApproved: row?.isApproved !== false,
			onboardingCompletedAt: String(row?.onboardingCompletedAt || '').trim(),
			billing: normalizeBillingState(row?.billing),
		}))
		: [];
}

function persistAuthUsers() {
	const payload = normalizeAuthUserRows(authUsers);
	writeAtomicJsonFile(AUTH_USERS_PATH, payload);
	writeAtomicJsonFile(AUTH_USERS_BACKUP_PATH, payload);
}

function writeJsonFile(filePath, data) {
	try {
		fs.mkdirSync(path.dirname(filePath), { recursive: true });
		fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
		return true;
	} catch {
		return false;
	}
}

function ensureStorageLayout(storagePaths = null) {
	const dbPath = storagePaths?.dbPath || DB_PATH;
	const backupPath = storagePaths?.backupPath || TARGET_BACKUP_PATH;
	const snapshotDir = storagePaths?.snapshotDir || DB_SNAPSHOT_DIR;
	try {
		fs.mkdirSync(path.dirname(dbPath), { recursive: true });
		fs.mkdirSync(path.dirname(backupPath), { recursive: true });
		fs.mkdirSync(path.dirname(AUTH_USERS_PATH), { recursive: true });
		fs.mkdirSync(path.dirname(AUTH_USERS_BACKUP_PATH), { recursive: true });
		fs.mkdirSync(snapshotDir, { recursive: true });
		fs.mkdirSync(DB_TENANTS_DIR, { recursive: true });
		fs.mkdirSync(BILLING_CATALOG_BACKUP_DIR, { recursive: true });
		fs.mkdirSync(AUTH_AUDIT_DIR, { recursive: true });
		fs.mkdirSync(AUTH_AUDIT_BACKUP_DIR, { recursive: true });
	} catch {
		// Ignore directory creation failures and let write paths report errors.
	}
}

function writeAtomicJsonFile(filePath, data) {
	const dir = path.dirname(filePath);
	fs.mkdirSync(dir, { recursive: true });
	const tmpPath = path.join(
		dir,
		`${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`
	);
	const serialized = `${JSON.stringify(data, null, 2)}\n`;
	fs.writeFileSync(tmpPath, serialized, 'utf8');
	fs.renameSync(tmpPath, filePath);
}

function rotateSnapshotFiles(snapshotDir = DB_SNAPSHOT_DIR) {
	if (!fs.existsSync(snapshotDir)) return;
	const snapshotFiles = fs.readdirSync(snapshotDir)
		.filter((name) => name.startsWith('db-') && name.endsWith('.json'))
		.map((name) => ({
			name,
			fullPath: path.join(snapshotDir, name),
			mtime: fs.statSync(path.join(snapshotDir, name)).mtimeMs,
		}))
		.sort((a, b) => b.mtime - a.mtime);

	if (snapshotFiles.length <= MAX_DB_SNAPSHOTS) return;
	for (const stale of snapshotFiles.slice(MAX_DB_SNAPSHOTS)) {
		try {
			fs.unlinkSync(stale.fullPath);
		} catch {
			// Ignore cleanup failures to avoid blocking writes.
		}
	}
}

function writeDbSnapshotIfPossible(dbPath = DB_PATH, snapshotDir = DB_SNAPSHOT_DIR) {
	try {
		if (!fs.existsSync(dbPath)) return;
		const stamp = new Date().toISOString().replace(/[:.]/g, '-');
		const snapshotPath = path.join(snapshotDir, `db-${stamp}.json`);
		fs.mkdirSync(snapshotDir, { recursive: true });
		fs.copyFileSync(dbPath, snapshotPath);
		rotateSnapshotFiles(snapshotDir);
	} catch {
		// Snapshot is best-effort only.
	}
}

function enqueueWrite(task) {
	const next = writeTail.then(task);
	writeTail = next.catch(() => {});
	return next;
}

function normalizeTargetFixtureId(weekRow) {
	const targetKey = String(weekRow?.primaryTargetCompetitionKey || '').trim();
	const explicitFixtureId = String(weekRow?.primaryTargetCompetitionFixtureId || '').trim();
	if (explicitFixtureId) return explicitFixtureId;
	if (targetKey.includes('|')) return String(targetKey.split('|')[0] || '').trim();
	return '';
}

function extractPlannerTargetRows(dbShape) {
	const rows = Array.isArray(dbShape?.trainingPlannerWeeks) ? dbShape.trainingPlannerWeeks : [];
	return rows
		.map((week) => {
			const squadId = String(week?.squadId || '').trim();
			const weekStart = String(week?.weekStart || '').trim();
			const targetKey = String(week?.primaryTargetCompetitionKey || '').trim();
			const targetName = String(week?.primaryTargetCompetitionName || '').trim();
			if (!squadId || !weekStart || !targetKey) return null;
			return {
				id: String(week?.id || '').trim(),
				squadId,
				weekStart,
				primaryTargetCompetitionKey: targetKey,
				primaryTargetCompetitionName: targetName,
				primaryTargetCompetitionFixtureId: normalizeTargetFixtureId(week),
			};
		})
		.filter(Boolean);
}

function mergePlannerTargets(dbShape, backupRows) {
	const sourceWeeks = Array.isArray(dbShape?.trainingPlannerWeeks) ? dbShape.trainingPlannerWeeks : [];
	const backup = Array.isArray(backupRows) ? backupRows : [];
	if (backup.length === 0) {
		return {
			nextWeeks: sourceWeeks,
			recoveredTargets: 0,
			recoveredFixtureIds: 0,
		};
	}

	const nextWeeks = [...sourceWeeks];
	const weekIndexByKey = new Map();
	nextWeeks.forEach((week, index) => {
		const squadId = String(week?.squadId || '').trim();
		const weekStart = String(week?.weekStart || '').trim();
		if (!squadId || !weekStart) return;
		weekIndexByKey.set(`${squadId}|${weekStart}`, index);
	});

	let recoveredTargets = 0;
	let recoveredFixtureIds = 0;

	for (const target of backup) {
		const squadId = String(target?.squadId || '').trim();
		const weekStart = String(target?.weekStart || '').trim();
		const targetKey = String(target?.primaryTargetCompetitionKey || '').trim();
		const targetName = String(target?.primaryTargetCompetitionName || '').trim();
		const targetFixtureId = String(target?.primaryTargetCompetitionFixtureId || '').trim();
		if (!squadId || !weekStart || !targetKey) continue;

		const key = `${squadId}|${weekStart}`;
		const existingIndex = weekIndexByKey.get(key);

		if (existingIndex === undefined) {
			nextWeeks.push({
				id: String(target?.id || ''),
				squadId,
				weekStart,
				primaryTargetCompetitionKey: targetKey,
				primaryTargetCompetitionName: targetName,
				primaryTargetCompetitionFixtureId: targetFixtureId,
			});
			weekIndexByKey.set(key, nextWeeks.length - 1);
			recoveredTargets += 1;
			if (targetFixtureId) recoveredFixtureIds += 1;
			continue;
		}

		const existingWeek = nextWeeks[existingIndex] || {};
		const existingTargetKey = String(existingWeek?.primaryTargetCompetitionKey || '').trim();
		const existingTargetName = String(existingWeek?.primaryTargetCompetitionName || '').trim();
		const existingFixtureId = normalizeTargetFixtureId(existingWeek);
		const hasExplicitTargetField = Object.prototype.hasOwnProperty.call(existingWeek || {}, 'primaryTargetCompetitionKey');
		const existingUpdatedAtMs = Date.parse(String(existingWeek?.updatedAt || existingWeek?.createdAt || ''));
		const hasTimestampedIntentionalClear = hasExplicitTargetField
			&& !existingTargetKey
			&& Number.isFinite(existingUpdatedAtMs);
		const shouldRecoverTarget = !existingTargetKey && !hasTimestampedIntentionalClear;
		const shouldRecoverName = Boolean(existingTargetKey) && !existingTargetName && Boolean(targetName);
		const shouldRecoverFixtureId = Boolean(existingTargetKey) && !existingFixtureId && Boolean(targetFixtureId);

		if (!shouldRecoverTarget && !shouldRecoverName && !shouldRecoverFixtureId) continue;

		nextWeeks[existingIndex] = {
			...existingWeek,
			primaryTargetCompetitionKey: shouldRecoverTarget ? targetKey : existingTargetKey,
			primaryTargetCompetitionName: (shouldRecoverTarget || shouldRecoverName)
				? (targetName || existingTargetName)
				: existingTargetName,
			primaryTargetCompetitionFixtureId: (shouldRecoverTarget || shouldRecoverFixtureId)
				? (targetFixtureId || existingFixtureId)
				: existingFixtureId,
		};

		if (shouldRecoverTarget) recoveredTargets += 1;
		if (shouldRecoverFixtureId || (shouldRecoverTarget && targetFixtureId)) recoveredFixtureIds += 1;
	}

	return {
		nextWeeks,
		recoveredTargets,
		recoveredFixtureIds,
	};
}

function getDbShapeUpdatedAtMs(dbShape) {
	const metaUpdatedAtMs = Date.parse(String(dbShape?.__meta?.updatedAt || ''));
	if (Number.isFinite(metaUpdatedAtMs)) return metaUpdatedAtMs;
	const savedAtMs = Date.parse(String(dbShape?.__savedAt || ''));
	if (Number.isFinite(savedAtMs)) return savedAtMs;
	return Number.NaN;
}

const OWNERSHIP_TRACKED_COLLECTION_KEYS = Object.freeze([
	'coaches',
	'squads',
	'swimmers',
	'venues',
	'sessionTypes',
	'timetables',
	'timetableSlots',
	'schedule',
	'trainingSessions',
	'trainingSessionSets',
	'templateSets',
	'templateTests',
	'trainingSetBlocks',
	'seasonPlans',
	'mesoCycles',
	'microCycles',
	'attendance',
	'tests',
	'fixtures',
	'seasons',
	'trainingPlannerWeeks',
	'conflictResolutions',
	'changeLog',
	'auditLog',
	'notifications',
	'documents',
]);

function toRowId(value) {
	const normalized = String(value || '').trim();
	return normalized;
}

function buildExistingDbRowIdIndex(dbShape) {
	const index = new Map();
	for (const key of OWNERSHIP_TRACKED_COLLECTION_KEYS) {
		const rows = Array.isArray(dbShape?.[key]) ? dbShape[key] : [];
		const rowIds = new Set();
		for (const row of rows) {
			const rowId = toRowId(row?.id);
			if (rowId) rowIds.add(rowId);
		}
		index.set(key, rowIds);
	}
	return index;
}

function applyOwnershipMetadataToDbShape(dbShape, existingDbShape, auth) {
	const actorUsername = String(auth?.username || '').trim().toLowerCase() || 'unknown-actor';
	const actorTenantId = String(resolveAuthTenantId(auth) || '').trim().toLowerCase();
	const nowIsoValue = new Date().toISOString();
	const nextShape = dbShape && typeof dbShape === 'object' ? { ...dbShape } : {};
	const existingRowIdIndex = buildExistingDbRowIdIndex(existingDbShape);

	for (const key of OWNERSHIP_TRACKED_COLLECTION_KEYS) {
		const rows = Array.isArray(nextShape?.[key]) ? nextShape[key] : null;
		if (!rows) continue;
		const existingIds = existingRowIdIndex.get(key) || new Set();
		nextShape[key] = rows.map((row) => {
			if (!row || typeof row !== 'object' || Array.isArray(row)) return row;
			const rowId = toRowId(row?.id);
			const isExistingRow = Boolean(rowId && existingIds.has(rowId));
			const existingCreatedBy = String(row?.createdByUserId || '').trim().toLowerCase();
			const createdByUserId = existingCreatedBy
				|| (isExistingRow ? 'legacy-unattributed' : actorUsername);
			const attributionStatus = createdByUserId === 'legacy-unattributed' ? 'unattributed-legacy' : 'attributed';
			return {
				...row,
				createdByUserId,
				createdAt: String(row?.createdAt || nowIsoValue).trim() || nowIsoValue,
				updatedByUserId: actorUsername,
				updatedAt: nowIsoValue,
				tenantId: actorTenantId,
				attributionStatus,
			};
		});
	}

	nextShape.__meta = {
		...(nextShape?.__meta && typeof nextShape.__meta === 'object' ? nextShape.__meta : {}),
		ownershipVersion: 'v1',
		ownershipUpdatedAt: nowIsoValue,
		ownershipUpdatedBy: actorUsername,
	};

	return nextShape;
}

function collectForeignTenantRowViolations(dbShape, actorTenantId) {
	const normalizedActorTenantId = normalizeTenantId(actorTenantId);
	if (!normalizedActorTenantId) return [];

	const violationsByCollection = new Map();
	for (const key of OWNERSHIP_TRACKED_COLLECTION_KEYS) {
		const rows = Array.isArray(dbShape?.[key]) ? dbShape[key] : null;
		if (!rows) continue;
		for (const row of rows) {
			if (!row || typeof row !== 'object' || Array.isArray(row)) continue;
			const rowTenantId = normalizeTenantId(row?.tenantId);
			if (!rowTenantId || rowTenantId === normalizedActorTenantId) continue;
			const current = violationsByCollection.get(key) || 0;
			violationsByCollection.set(key, current + 1);
		}
	}

	return Array.from(violationsByCollection.entries()).map(([key, rows]) => ({ key, rows }));
}

function buildOwnershipSummary(dbShape) {
	const collections = [];
	const ownerTotals = new Map();
	let totalRows = 0;
	let attributedRows = 0;
	let unattributedRows = 0;

	for (const key of OWNERSHIP_TRACKED_COLLECTION_KEYS) {
		const rows = Array.isArray(dbShape?.[key]) ? dbShape[key] : [];
		let collectionAttributed = 0;
		let collectionUnattributed = 0;
		for (const row of rows) {
			if (!row || typeof row !== 'object') continue;
			const owner = String(row?.createdByUserId || '').trim().toLowerCase();
			if (!owner || owner === 'legacy-unattributed') {
				collectionUnattributed += 1;
				continue;
			}
			collectionAttributed += 1;
			ownerTotals.set(owner, Number(ownerTotals.get(owner) || 0) + 1);
		}
		const collectionTotal = rows.length;
		totalRows += collectionTotal;
		attributedRows += collectionAttributed;
		unattributedRows += collectionUnattributed;
		collections.push({
			key,
			totalRows: collectionTotal,
			attributedRows: collectionAttributed,
			unattributedRows: collectionUnattributed,
		});
	}

	const ownerBreakdown = Array.from(ownerTotals.entries())
		.map(([username, rows]) => ({ username, rows }))
		.sort((a, b) => b.rows - a.rows || a.username.localeCompare(b.username));

	return {
		totalRows,
		attributedRows,
		unattributedRows,
		collections,
		ownerBreakdown,
	};
}

app.use((req, res, next) => {
	const requestOrigin = String(req.headers?.origin || '').trim();

	if (requestOrigin && !isOriginAllowed(requestOrigin)) {
		res.status(403).json({ error: 'CORS origin not allowed.' });
		return;
	}

	if (requestOrigin) {
		res.setHeader('Access-Control-Allow-Origin', requestOrigin);
		res.setHeader('Vary', 'Origin');
	}

	res.setHeader('Access-Control-Allow-Methods', 'GET,PUT,POST,DELETE,OPTIONS');
	res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
	if (req.method === 'OPTIONS') {
		res.status(204).end();
		return;
	}
	next();
});

app.use(attachAuthContext);

app.get('/auth/config', (req, res) => {
	res.status(200).json({
		authRequired: AUTH_REQUIRED,
		allowCoachSignup: AUTH_ALLOW_COACH_SIGNUP || AUTH_ALLOW_COACH_INVITES,
		requireInviteCode: !AUTH_ALLOW_COACH_SIGNUP,
		allowCoachInvites: AUTH_ALLOW_COACH_INVITES,
		securityMode: IS_PRODUCTION ? 'production' : 'development',
		assetId: BACKEND_ASSET_ID,
	});
});

app.post('/auth/register', requireLoginRateLimit, (req, res) => {
	if (!AUTH_ALLOW_COACH_SIGNUP && !AUTH_ALLOW_COACH_INVITES) {
		appendAuthAuditEvent({
			action: 'register_blocked',
			req,
			status: 'blocked',
			reason: 'signup_disabled',
		});
		res.status(403).json({ error: 'Self-signup is currently disabled.' });
		return;
	}

	const requestedUsername = String(req.body?.username || '').trim();
	const password = String(req.body?.password || '');
	const fullName = String(req.body?.fullName || '').trim();
	const email = String(req.body?.email || '').trim();
	const phone = String(req.body?.phone || '').trim();
	const swimClub = String(req.body?.swimClub || '').trim();
	const teamName = String(req.body?.teamName || '').trim();
	const city = String(req.body?.city || '').trim();
	const country = String(req.body?.country || '').trim();
	const inviteCode = String(req.body?.inviteCode || '').trim();
	if (!password) {
		appendAuthAuditEvent({
			action: 'register_failed',
			req,
			status: 'error',
			target: requestedUsername || 'unknown',
			reason: 'missing_credentials',
		});
		res.status(400).json({ error: 'Password is required.' });
		return;
	}

	if (!fullName || !email) {
		appendAuthAuditEvent({
			action: 'register_failed',
			req,
			status: 'error',
			target: requestedUsername || 'unknown',
			reason: 'missing_profile_fields',
		});
		res.status(400).json({ error: 'Full name and email are required.' });
		return;
	}

	if (!AUTH_EMAIL_PATTERN.test(email)) {
		appendAuthAuditEvent({
			action: 'register_failed',
			req,
			status: 'error',
			target: requestedUsername || 'unknown',
			reason: 'invalid_email',
		});
		res.status(400).json({ error: 'Enter a valid email address.' });
		return;
	}

	const emailBase = String(email.split('@')[0] || '')
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9._-]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, 24) || 'coach';
	let username = String(requestedUsername || emailBase)
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9._-]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, 32);
	if (!AUTH_USERNAME_PATTERN.test(username)) {
		username = emailBase;
	}
	if (!AUTH_USERNAME_PATTERN.test(username)) {
		username = `coach-${Date.now().toString().slice(-6)}`;
	}

	if (!AUTH_USERNAME_PATTERN.test(username)) {
		appendAuthAuditEvent({
			action: 'register_failed',
			req,
			status: 'error',
			target: username,
			reason: 'invalid_username_format',
		});
		res.status(400).json({ error: 'Username must be 3-32 chars and only use letters, numbers, dot, underscore, or dash.' });
		return;
	}

	if (String(password).length < 8) {
		appendAuthAuditEvent({
			action: 'register_failed',
			req,
			status: 'error',
			target: username,
			reason: 'password_too_short',
		});
		res.status(400).json({ error: 'Password must be at least 8 characters.' });
		return;
	}

	const uniqueBase = String(username || 'coach').slice(0, 24) || 'coach';
	let suffix = 0;
	while (authUsers.some((row) => row.username === username) && suffix < 1000) {
		suffix += 1;
		username = `${uniqueBase}-${suffix}`.slice(0, 32);
	}
	if (authUsers.some((row) => row.username === username)) {
		res.status(500).json({ error: 'Could not allocate a unique username. Try again.' });
		return;
	}

	if (authUsers.some((row) => String(row?.email || '').toLowerCase() === String(email || '').toLowerCase())) {
		appendAuthAuditEvent({
			action: 'register_failed',
			req,
			status: 'error',
			target: username,
			reason: 'email_taken',
		});
		res.status(409).json({ error: 'Email is already registered.' });
		return;
	}

	const usableInvite = AUTH_ALLOW_COACH_INVITES ? findUsableInvite(inviteCode, email) : null;
	if (!AUTH_ALLOW_COACH_SIGNUP && !usableInvite) {
		appendAuthAuditEvent({
			action: 'register_failed',
			req,
			status: 'error',
			target: username,
			reason: 'invite_required',
		});
		res.status(403).json({ error: 'A valid invite code is required to join this team.' });
		return;
	}

	const role = String(usableInvite?.role || (AUTH_ALLOW_COACH_SIGNUP ? 'head-coach' : 'assistant-coach')).trim() || 'assistant-coach';
	const isApproved = true;
	const effectiveSwimClub = String(usableInvite?.swimClub || swimClub).trim();
	const effectiveTeamName = String(usableInvite?.teamName || teamName).trim();
	const tenantId = normalizeTenantId(usableInvite?.tenantId)
		|| resolveTenantKeyFromUser({ username, role, swimClub: effectiveSwimClub, teamName: effectiveTeamName });

	if (!usableInvite) {
		const tenantHasMembers = getTenantUsersByTenantId(tenantId)
			.some((row) => !isPrimarySoftwareOwnerAccount(row));
		if (tenantHasMembers) {
			appendAuthAuditEvent({
				action: 'register_failed',
				req,
				status: 'blocked',
				target: username,
				reason: 'tenant_requires_invite',
				details: { tenantId },
			});
			res.status(409).json({ error: 'This team already exists. Ask an admin for an invite code.' });
			return;
		}
	}

	if (role === 'head-coach') {
		const sessionCoordinatorCapacityError = getSessionCoordinatorCapacityError(tenantId);
		if (sessionCoordinatorCapacityError) {
			res.status(403).json({ error: sessionCoordinatorCapacityError });
			return;
		}
	}
	authUsers.push({
		username,
		role,
		tenantId,
		passwordHash: hashPassword(password),
		tokenValidAfter: 0,
		createdVia: usableInvite ? 'self-signup-invite' : 'self-signup',
		inviteCodeUsed: Boolean(usableInvite),
		createdAt: new Date().toISOString(),
		fullName,
		email,
		phone,
		swimClub: effectiveSwimClub,
		teamName: effectiveTeamName,
		city,
		country,
		isApproved,
		onboardingCompletedAt: '',
		referralCode: usableInvite ? String(usableInvite?.code || '').trim().toUpperCase() : '',
		referredByUsername: usableInvite ? String(usableInvite?.createdBy || '').trim() : '',
		partnerCommissionPercent: usableInvite ? BILLING_PARTNER_COMMISSION_PERCENT : 0,
		partnerCommissionMonths: usableInvite ? BILLING_PARTNER_COMMISSION_MONTHS : 0,
		partnerAttributionAt: usableInvite ? new Date().toISOString() : '',
		billing: getDefaultBillingState(),
	});

	try {
		if (usableInvite) {
			usableInvite.usedCount = Number(usableInvite.usedCount || 0) + 1;
			cleanExpiredInvites();
			persistAuthInvites();
		}
		persistAuthUsers();
		appendAuthAuditEvent({
			action: 'register_success',
			req,
			status: 'success',
			target: username,
			details: { role, email, swimClub, teamName, invited: Boolean(usableInvite), isApproved },
		});

		const token = issueAuthToken({ username, role });
		res.status(201).json({
			ok: true,
			token,
			user: buildAuthUserPayload({ username, role, onboardingCompletedAt: '', billing: getDefaultBillingState() }),
		});
	} catch (error) {
		authUsers.pop();
		if (usableInvite) {
			usableInvite.usedCount = Math.max(0, Number(usableInvite.usedCount || 0) - 1);
		}
		res.status(500).json({
			error: 'Could not create account.',
			details: error instanceof Error ? error.message : 'Unknown error',
		});
	}
});

app.post('/auth/login', requireLoginRateLimit, (req, res) => {
	const username = String(req.body?.username || '').trim();
	const password = String(req.body?.password || '');
	if (!username || !password) {
		appendAuthAuditEvent({
			action: 'login_failed',
			req,
			status: 'error',
			target: username || 'unknown',
			reason: 'missing_credentials',
		});
		res.status(400).json({ error: 'Username and password are required.' });
		return;
	}

	let { user, reason: loginResolveReason } = resolveLoginUserByIdentifier(username);
	let loginValid = Boolean(user) && verifyPassword(password, user.passwordHash);
	if (!loginValid && isDemoAutoRealignTarget(username)) {
		if (runDemoAutoRealign('login-retry')) {
			const refreshedAuthUsers = normalizeAuthUserRows(readJsonFile(AUTH_USERS_PATH));
			authUsers.splice(0, authUsers.length, ...refreshedAuthUsers);
			({ user, reason: loginResolveReason } = resolveLoginUserByIdentifier(username));
			loginValid = Boolean(user) && verifyPassword(password, user?.passwordHash);
		}
	}
	if (loginResolveReason === 'ambiguous_email' || loginResolveReason === 'duplicate_username') {
		appendAuthAuditEvent({
			action: 'login_blocked',
			req,
			status: 'blocked',
			target: username,
			reason: loginResolveReason,
		});
		res.status(409).json({ error: 'This sign-in identifier matches multiple accounts. Contact support to resolve account identity.' });
		return;
	}
	if (!loginValid || !user) {
		appendAuthAuditEvent({
			action: 'login_failed',
			req,
			status: 'error',
			target: username,
			reason: 'invalid_credentials',
		});
		res.status(401).json({ error: 'Invalid credentials.' });
		return;
	}

	if (user?.isApproved === false) {
		appendAuthAuditEvent({
			action: 'login_blocked',
			req,
			status: 'blocked',
			target: user.username,
			reason: 'approval_required',
		});
		res.status(403).json({ error: 'Your account is pending software-owner approval.' });
		return;
	}

	const canonicalTenantId = CANONICAL_TENANT_BY_USERNAME[String(user?.username || '').trim().toLowerCase()];
	if (canonicalTenantId && normalizeTenantId(user?.tenantId) !== canonicalTenantId) {
		const userIndex = authUsers.findIndex((row) => String(row?.username || '').trim().toLowerCase() === String(user?.username || '').trim().toLowerCase());
		if (userIndex >= 0) {
			authUsers[userIndex] = {
				...authUsers[userIndex],
				tenantId: canonicalTenantId,
			};
			user = authUsers[userIndex];
			try {
				persistAuthUsers();
			} catch {
				// Keep login flow available even if tenant self-heal persistence fails.
			}
		}
	}

	if (AUTH_AUTO_HEAL_SWIMMER_BINDINGS && String(user?.role || '').trim().toLowerCase() === 'swimmer') {
		try {
			ensureSwimmerAccountBindingInStorage(user);
		} catch {
			// Never block login on auto-heal failures.
		}
	}

	const token = issueAuthToken(user);
	appendAuthAuditEvent({
		action: 'login_success',
		req,
		status: 'success',
		actor: user.username,
		actorRole: String(user?.role || 'unknown'),
		target: user.username,
		details: {
			role: user.role,
			swimClub: String(user?.swimClub || '').trim(),
			teamName: String(user?.teamName || '').trim(),
			email: String(user?.email || '').trim(),
		},
	});
	res.status(200).json({
		token,
		user: buildAuthUserPayload(user),
	});
});

app.post('/auth/password-reset/request', requireLoginRateLimit, async (req, res) => {
	const identifier = String(req.body?.identifier || '').trim();
	if (!identifier) {
		res.status(400).json({ error: 'Username or email is required.' });
		return;
	}

	const user = findAuthUserByIdentifier(identifier);
	if (!user) {
		appendAuthAuditEvent({
			action: 'password_reset_request',
			req,
			status: 'blocked',
			target: identifier,
			reason: 'unknown_user',
		});
		res.status(200).json({ ok: true, message: 'If an account exists, a reset code has been issued.' });
		return;
	}

	const username = String(user.username || '').trim();
	const resetCode = makePasswordResetCode();
	const expiresAtMs = Date.now() + (AUTH_PASSWORD_RESET_TTL_MINUTES * 60 * 1000);
	try {
		await deliverPasswordResetCode({ user, resetCode });
		authPasswordResetByUser.set(username.toLowerCase(), {
			codeHash: hashPasswordResetCode(resetCode),
			expiresAtMs,
			requestedAt: new Date().toISOString(),
		});

		appendAuthAuditEvent({
			action: 'password_reset_request',
			req,
			status: 'success',
			target: username,
		});

		const payload = {
			ok: true,
			message: 'If an account exists, a reset code has been issued.',
			resetCodeTtlMinutes: AUTH_PASSWORD_RESET_TTL_MINUTES,
		};
		if (!IS_PRODUCTION && AUTH_PASSWORD_RESET_DEV_CODE_IN_RESPONSE) {
			payload.devResetCode = resetCode;
			payload.devResetUser = username;
		}
		res.status(200).json(payload);
	} catch (error) {
		appendAuthAuditEvent({
			action: 'password_reset_request',
			req,
			status: 'error',
			target: username,
			reason: 'delivery_failed',
			details: { message: error instanceof Error ? error.message : 'Unknown delivery error' },
		});
		res.status(500).json({ error: 'Could not issue reset code. Please contact your administrator.' });
	}
});

app.post('/auth/password-reset/confirm', requireLoginRateLimit, (req, res) => {
	const username = String(req.body?.username || '').trim();
	const resetCode = String(req.body?.code || '').trim();
	const nextPassword = String(req.body?.password || '');

	if (!username || !resetCode || !nextPassword) {
		res.status(400).json({ error: 'Username, reset code, and new password are required.' });
		return;
	}

	if (nextPassword.length < 8) {
		res.status(400).json({ error: 'Password must be at least 8 characters.' });
		return;
	}

	const userKey = username.toLowerCase();
	const resetEntry = authPasswordResetByUser.get(userKey);
	if (!resetEntry || Number(resetEntry.expiresAtMs || 0) <= Date.now()) {
		authPasswordResetByUser.delete(userKey);
		appendAuthAuditEvent({
			action: 'password_reset_confirm',
			req,
			status: 'blocked',
			target: username,
			reason: 'expired_or_missing_code',
		});
		res.status(400).json({ error: 'Reset code is invalid or expired.' });
		return;
	}

	if (hashPasswordResetCode(resetCode) !== String(resetEntry.codeHash || '')) {
		appendAuthAuditEvent({
			action: 'password_reset_confirm',
			req,
			status: 'blocked',
			target: username,
			reason: 'invalid_code',
		});
		res.status(400).json({ error: 'Reset code is invalid or expired.' });
		return;
	}

	const index = authUsers.findIndex((row) => String(row?.username || '').trim().toLowerCase() === userKey);
	if (index < 0) {
		authPasswordResetByUser.delete(userKey);
		res.status(404).json({ error: 'User not found.' });
		return;
	}

	const previous = authUsers[index];
	authUsers[index] = {
		...previous,
		passwordHash: hashPassword(nextPassword),
		tokenValidAfter: getNowEpochSeconds(),
	};

	try {
		persistAuthUsers();
		authPasswordResetByUser.delete(userKey);
		appendAuthAuditEvent({
			action: 'password_reset_confirm',
			req,
			status: 'success',
			target: authUsers[index].username,
		});
		res.status(200).json({ ok: true, username: authUsers[index].username });
	} catch (error) {
		authUsers[index] = previous;
		res.status(500).json({
			error: 'Could not update password.',
			details: error instanceof Error ? error.message : 'Unknown error',
		});
	}
});

app.get('/auth/me', (req, res) => {
	if (!AUTH_REQUIRED) {
		res.status(200).json({
			authRequired: false,
			authenticated: Boolean(req.auth),
			user: req.auth ? { username: req.auth.username, role: req.auth.role } : null,
		});
		return;
	}

	if (!req.auth) {
		res.status(401).json({ error: 'Authentication required.' });
		return;
	}

	res.status(200).json({
		authRequired: true,
		authenticated: true,
		user: {
			...buildAuthUserPayload(findAuthUser(req.auth.username) || req.auth),
			expiresAt: req.auth.exp,
		},
	});
});

app.get('/auth/guard', (req, res) => {
	const audience = String(req.query?.audience || '').trim().toLowerCase();
	if (audience !== 'coach' && audience !== 'swimmer') {
		res.status(400).json({ error: 'Audience must be "coach" or "swimmer".' });
		return;
	}

	if (!AUTH_REQUIRED) {
		res.status(200).json({
			authRequired: false,
			authenticated: Boolean(req.auth),
			audience,
			allowed: true,
			user: req.auth ? { username: req.auth.username, role: req.auth.role } : null,
		});
		return;
	}

	if (!req.auth) {
		appendAuthAuditEvent({
			action: 'unauthorized_access_blocked',
			req,
			status: 'blocked',
			reason: 'auth_guard_requires_login',
			details: { audience },
		});
		res.status(401).json({ error: 'Authentication required.', audience, allowed: false });
		return;
	}

	const user = findAuthUser(req.auth.username) || req.auth;
	const role = String(user?.role || req.auth.role || '').trim().toLowerCase();
	const coachRoles = new Set(['software-owner', 'head-coach', 'assistant-coach', 'viewer']);
	const isAllowed = audience === 'coach' ? coachRoles.has(role) : role === 'swimmer';

	if (!isAllowed) {
		appendAuthAuditEvent({
			action: 'unauthorized_access_blocked',
			req,
			status: 'blocked',
			reason: 'auth_guard_role_mismatch',
			details: { audience, role },
		});
		res.status(403).json({
			error: audience === 'coach' ? 'Coach-only software sign-in required. Use Swimmer Sign In for swimmer accounts.' : 'Swimmer access required.',
			audience,
			allowed: false,
			role,
		});
		return;
	}

	res.status(200).json({
		authRequired: true,
		authenticated: true,
		audience,
		allowed: true,
		user: {
			...buildAuthUserPayload(user),
			expiresAt: req.auth.exp,
		},
	});
});

app.get('/billing/config', requireStrictAuth, (req, res) => {
	const user = findAuthUser(String(req.auth?.username || '').trim()) || req.auth || {};
	const policy = getBillingPolicy();
	const plans = getBillingPlansCatalog().map(serializeBillingPlanForResponse);
	const addons = Array.isArray(billingCatalog?.addons) ? billingCatalog.addons.map(serializeBillingAddonForResponse) : [];
	res.status(200).json({
		enabled: Boolean(stripeClient),
		enforced: Boolean(stripeClient) && policy.enforceCharging,
		checkoutEnabled: Boolean(policy.checkoutEnabled),
		trialDays: resolveTrialDaysForUser(user),
		currency: String(billingCatalog?.currency || 'GBP').toUpperCase(),
		plans,
		addons,
		settings: policy,
	});
});

app.get('/billing/catalog', requireStrictAuth, requireSoftwareOwnerRole, (_req, res) => {
	res.status(200).json({
		catalog: {
			version: Number(billingCatalog?.version || 1),
			currency: String(billingCatalog?.currency || 'GBP').toUpperCase(),
			settings: getBillingPolicy(),
			plans: getBillingPlansCatalog().map(serializeBillingPlanForResponse),
			addons: Array.isArray(billingCatalog?.addons) ? billingCatalog.addons.map(serializeBillingAddonForResponse) : [],
		},
	});
});

app.put('/billing/catalog', requireStrictAuth, requireSoftwareOwnerRole, (req, res) => {
	const payload = req.body && typeof req.body === 'object' && !Array.isArray(req.body)
		? req.body
		: null;
	if (!payload) {
		res.status(400).json({ error: 'Invalid billing catalog payload.' });
		return;
	}

	const normalized = normalizeBillingCatalog(payload);
	if (!Array.isArray(normalized?.plans) || normalized.plans.length < 1) {
		res.status(400).json({ error: 'At least one billing plan is required.' });
		return;
	}

	const payloadHasPageVisibilityByTier = payload?.settings
		&& typeof payload.settings === 'object'
		&& Object.prototype.hasOwnProperty.call(payload.settings, 'pageVisibilityByTier');
	const existingPolicy = getBillingPolicy();
	const normalizedPageVisibilityByTier = normalized?.settings?.pageVisibilityByTier;
	const normalizedPageVisibilityHasEntries = BILLING_TIER_KEYS.some((tierKey) => {
		const tierMap = normalizedPageVisibilityByTier?.[tierKey];
		return tierMap && typeof tierMap === 'object' && !Array.isArray(tierMap) && Object.keys(tierMap).length > 0;
	});
	const shouldPreserveExistingPageVisibility = !normalizedPageVisibilityHasEntries;
	const mergedSettings = {
		...(normalized?.settings && typeof normalized.settings === 'object' ? normalized.settings : existingPolicy),
		...(!payloadHasPageVisibilityByTier || shouldPreserveExistingPageVisibility
			? { pageVisibilityByTier: existingPolicy?.pageVisibilityByTier }
			: {}),
	};

	billingCatalog = {
		version: Number(billingCatalog?.version || 1) + 1,
		currency: String(normalized?.currency || 'GBP').toUpperCase(),
		settings: mergedSettings,
		plans: normalized.plans,
		addons: Array.isArray(normalized?.addons) ? normalized.addons : [],
	};
	persistBillingCatalog();

	res.status(200).json({
		ok: true,
		catalog: {
			version: Number(billingCatalog?.version || 1),
			currency: String(billingCatalog?.currency || 'GBP').toUpperCase(),
			settings: getBillingPolicy(),
			plans: getBillingPlansCatalog().map(serializeBillingPlanForResponse),
			addons: Array.isArray(billingCatalog?.addons) ? billingCatalog.addons.map(serializeBillingAddonForResponse) : [],
		},
	});
});

app.get('/billing/subscription', requireStrictAuth, (req, res) => {
	const user = findAuthUser(String(req.auth?.username || '').trim());
	if (!user) {
		res.status(404).json({ error: 'User not found.' });
		return;
	}

	res.status(200).json({
		user: buildAuthUserPayload(user),
		trialDays: resolveTrialDaysForUser(user),
		currency: String(billingCatalog?.currency || 'GBP').toUpperCase(),
		plans: getBillingPlansCatalog().map(serializeBillingPlanForResponse),
		addons: Array.isArray(billingCatalog?.addons) ? billingCatalog.addons.map(serializeBillingAddonForResponse) : [],
		settings: getBillingPolicy(),
	});
});

app.post('/billing/checkout-session', requireStrictAuth, async (req, res) => {
	if (!stripeClient) {
		res.status(503).json({ error: 'Stripe is not configured on backend.' });
		return;
	}
	if (!BILLING_APP_BASE_URL) {
		res.status(400).json({ error: 'BILLING_APP_BASE_URL is required to create checkout sessions.' });
		return;
	}

	const planKey = String(req.body?.planKey || 'tier-1').trim();
	const { byPlan } = getBillingPlanPriceMaps();
	const priceId = byPlan.get(planKey);
	if (!priceId) {
		res.status(400).json({ error: 'Invalid or unconfigured billing plan.' });
		return;
	}

	const username = String(req.auth?.username || '').trim();
	const user = findAuthUser(username);
	if (!user) {
		res.status(404).json({ error: 'User not found.' });
		return;
	}

	try {
		const billing = normalizeBillingState(user?.billing);
		const hasUsedSubscription = Boolean(String(billing?.subscriptionId || '').trim());
		const trialDays = resolveTrialDaysForUser(user);
		const referralCode = String(user?.referralCode || '').trim().toUpperCase();
		const referredByUsername = String(user?.referredByUsername || '').trim();
		const partnerCommissionPercent = Math.max(0, Number.parseInt(user?.partnerCommissionPercent || '0', 10) || 0);
		const partnerCommissionMonths = Math.max(0, Number.parseInt(user?.partnerCommissionMonths || '0', 10) || 0);
		const checkoutMetadata = {
			username,
			planKey,
			...(referralCode ? { referralCode } : {}),
			...(referredByUsername ? { referredByUsername } : {}),
			...(partnerCommissionPercent > 0 ? { partnerCommissionPercent: String(partnerCommissionPercent) } : {}),
			...(partnerCommissionMonths > 0 ? { partnerCommissionMonths: String(partnerCommissionMonths) } : {}),
		};
		let customerId = String(billing?.customerId || '').trim();
		if (!customerId) {
			const createdCustomer = await stripeClient.customers.create({
				email: String(user?.email || '').trim() || undefined,
				name: String(user?.fullName || user?.username || '').trim() || undefined,
				metadata: checkoutMetadata,
			});
			customerId = String(createdCustomer?.id || '').trim();
			upsertUserBillingByUsername(username, { customerId, updatedAt: new Date().toISOString() });
		}

		const checkoutSession = await stripeClient.checkout.sessions.create({
			mode: 'subscription',
			customer: customerId,
			line_items: [{ price: priceId, quantity: 1 }],
			success_url: `${BILLING_APP_BASE_URL}/?billing=success`,
			cancel_url: `${BILLING_APP_BASE_URL}/?billing=cancel`,
			allow_promotion_codes: true,
			client_reference_id: username,
			metadata: checkoutMetadata,
			subscription_data: {
				metadata: checkoutMetadata,
				...(trialDays > 0 && !hasUsedSubscription ? { trial_period_days: trialDays } : {}),
			},
		});

		upsertUserBillingByUsername(username, {
			planKey,
			priceId,
			checkoutSessionId: String(checkoutSession?.id || '').trim(),
			status: 'checkout_pending',
			updatedAt: new Date().toISOString(),
		});

		res.status(200).json({
			ok: true,
			sessionId: String(checkoutSession?.id || '').trim(),
			url: String(checkoutSession?.url || '').trim(),
		});
	} catch (error) {
		res.status(500).json({ error: 'Could not create checkout session.', details: error instanceof Error ? error.message : 'Unknown error' });
	}
});

app.post('/billing/portal-session', requireStrictAuth, async (req, res) => {
	if (!stripeClient) {
		res.status(503).json({ error: 'Stripe is not configured on backend.' });
		return;
	}
	if (!BILLING_APP_BASE_URL) {
		res.status(400).json({ error: 'BILLING_APP_BASE_URL is required to create portal sessions.' });
		return;
	}

	const username = String(req.auth?.username || '').trim();
	const user = findAuthUser(username);
	if (!user) {
		res.status(404).json({ error: 'User not found.' });
		return;
	}

	const customerId = String(user?.billing?.customerId || '').trim();
	if (!customerId) {
		res.status(400).json({ error: 'No billing customer exists yet. Start a subscription checkout first.' });
		return;
	}

	try {
		const session = await stripeClient.billingPortal.sessions.create({
			customer: customerId,
			return_url: `${BILLING_APP_BASE_URL}/?billing=portal-return`,
		});
		res.status(200).json({ ok: true, url: String(session?.url || '').trim() });
	} catch (error) {
		res.status(500).json({ error: 'Could not create billing portal session.', details: error instanceof Error ? error.message : 'Unknown error' });
	}
});

app.post('/auth/onboarding/complete', requireStrictAuth, (req, res) => {
	const username = String(req.auth?.username || '').trim();
	const fullName = String(req.body?.fullName || '').trim();
	const email = String(req.body?.email || '').trim();
	const phone = String(req.body?.phone || '').trim();
	const swimClub = String(req.body?.swimClub || '').trim();
	const teamName = String(req.body?.teamName || '').trim();
	const city = String(req.body?.city || '').trim();
	const country = String(req.body?.country || '').trim();

	if (!fullName || !email) {
		res.status(400).json({ error: 'Full name and email are required.' });
		return;
	}
	if (!AUTH_EMAIL_PATTERN.test(email)) {
		res.status(400).json({ error: 'Enter a valid email address.' });
		return;
	}

	const index = authUsers.findIndex((row) => String(row?.username || '').trim() === username);
	if (index < 0) {
		res.status(404).json({ error: 'User not found.' });
		return;
	}

	const previous = authUsers[index];
	authUsers[index] = {
		...previous,
		fullName,
		email,
		phone,
		swimClub,
		teamName,
		city,
		country,
		onboardingCompletedAt: new Date().toISOString(),
	};

	try {
		persistAuthUsers();
		appendAuthAuditEvent({
			action: 'onboarding_completed',
			req,
			status: 'success',
			target: username,
		});
		res.status(200).json({ ok: true });
	} catch (error) {
		authUsers[index] = previous;
		res.status(500).json({
			error: 'Could not save onboarding details.',
			details: error instanceof Error ? error.message : 'Unknown error',
		});
	}
});

app.post('/auth/logout', requireStrictAuth, (req, res) => {
	const username = String(req.auth?.username || '').trim();
	const index = authUsers.findIndex((row) => String(row?.username || '').trim() === username);
	if (index < 0) {
		res.status(401).json({ error: 'Authentication required.' });
		return;
	}

	const previous = authUsers[index];
	authUsers[index] = {
		...previous,
		tokenValidAfter: getNowEpochSeconds(),
	};

	try {
		persistAuthUsers();
		appendAuthAuditEvent({
			action: 'logout',
			req,
			status: 'success',
			target: username,
		});
		res.status(200).json({ ok: true });
	} catch (error) {
		authUsers[index] = previous;
		res.status(500).json({
			error: 'Could not complete logout.',
			details: error instanceof Error ? error.message : 'Unknown error',
		});
	}
});

app.get('/auth/audit/events', requireStrictAuth, requireSoftwareOwnerRole, (req, res) => {
	const limit = Number.parseInt(String(req.query?.limit || '250'), 10) || 250;
	const rows = readAuthAuditEvents(limit, {
		action: req.query?.action,
		status: req.query?.status,
		actor: req.query?.actor,
		query: req.query?.query,
	});
	res.status(200).json({
		rows,
		limit: Math.min(AUTH_AUDIT_FETCH_MAX_ROWS, Math.max(1, limit)),
	});
});

app.post('/auth/presence/ping', requireStrictAuth, (req, res) => {
	authPresenceByUser.set(String(req.auth?.username || ''), Date.now());
	res.status(200).json({ ok: true });
});

app.get('/auth/presence/summary', requireStrictAuth, requireSoftwareOwnerRole, (req, res) => {
	res.status(200).json(getAuthPresenceSummary());
});

app.post('/auth/invites', requireStrictAuth, requireAdminRole, requireAdminRateLimit, (req, res) => {
	if (!AUTH_ALLOW_COACH_INVITES) {
		res.status(403).json({ error: 'Coach invites are disabled.' });
		return;
	}

	const role = String(req.body?.role || 'assistant-coach').trim() || 'assistant-coach';
	const targetEmail = String(req.body?.email || '').trim();
	const maxUses = Math.max(1, Number.parseInt(req.body?.maxUses || '1', 10) || 1);
	const actor = findAuthUser(String(req.auth?.username || '').trim()) || req.auth || {};
	const actorIsPrimaryOwner = isPrimarySoftwareOwnerAccount(actor);
	const inviteSwimClub = actorIsPrimaryOwner
		? String(req.body?.swimClub || '').trim()
		: String(actor?.swimClub || '').trim();
	const inviteTeamName = actorIsPrimaryOwner
		? String(req.body?.teamName || '').trim()
		: String(actor?.teamName || '').trim();
	const inviteTenantId = actorIsPrimaryOwner
		? (normalizeTenantId(req.body?.tenantId) || resolveTenantKeyFromUser({ swimClub: inviteSwimClub, teamName: inviteTeamName }))
		: resolveTenantKeyFromUser(actor);
	if (!actorIsPrimaryOwner && !['assistant-coach', 'head-coach'].includes(role)) {
		res.status(403).json({ error: 'Only assistant-coach or head-coach invites are allowed for tenant admins.' });
		return;
	}
	if (role === 'head-coach') {
		const sessionCoordinatorCapacityError = getSessionCoordinatorCapacityError(inviteTenantId, { includePendingInvites: true });
		if (sessionCoordinatorCapacityError) {
			res.status(403).json({ error: sessionCoordinatorCapacityError });
			return;
		}
	}
	if (targetEmail && !AUTH_EMAIL_PATTERN.test(targetEmail)) {
		res.status(400).json({ error: 'Enter a valid invite email address.' });
		return;
	}

	cleanExpiredInvites();
	let code = makeInviteCode();
	for (let attempt = 0; attempt < 4; attempt += 1) {
		if (!authInvites.some((row) => String(row?.code || '').trim().toUpperCase() === code)) break;
		code = makeInviteCode();
	}

	const createdAt = new Date();
	const expiresAt = new Date(createdAt.getTime() + (AUTH_INVITE_TTL_HOURS * 60 * 60 * 1000));
	const invite = {
		code,
		role,
		createdBy: String(req.auth?.username || '').trim() || 'unknown',
		tenantId: inviteTenantId,
		swimClub: inviteSwimClub,
		teamName: inviteTeamName,
		createdAt: createdAt.toISOString(),
		expiresAt: expiresAt.toISOString(),
		targetEmail,
		maxUses,
		usedCount: 0,
		disabled: false,
	};

	authInvites.push(invite);

	try {
		persistAuthInvites();
		appendAuthAuditEvent({
			action: 'invite_created',
			req,
			status: 'success',
			target: targetEmail || code,
			details: { role, maxUses, expiresAt: invite.expiresAt },
		});
		res.status(201).json({
			ok: true,
			invite: {
				code: invite.code,
				role: invite.role,
				targetEmail: invite.targetEmail,
				expiresAt: invite.expiresAt,
				maxUses: invite.maxUses,
			},
		});
	} catch (error) {
		authInvites.pop();
		res.status(500).json({
			error: 'Could not create invite.',
			details: error instanceof Error ? error.message : 'Unknown error',
		});
	}
});

app.get('/auth/users', requireStrictAuth, requireSoftwareOwnerRole, requireAdminRateLimit, (_req, res) => {
	res.status(200).json({
		users: sanitizeAuthUsers(authUsers),
	});
});

app.post('/auth/users', requireStrictAuth, requireAdminRole, requireAdminRateLimit, (req, res) => {
	const username = String(req.body?.username || '').trim();
	const requestedRole = String(req.body?.role || 'viewer').trim() || 'viewer';
	const password = String(req.body?.password || '');
	const actor = findAuthUser(String(req.auth?.username || '').trim()) || req.auth || {};
	const actorIsPrimaryOwner = isPrimarySoftwareOwnerAccount(actor);
	const role = !actorIsPrimaryOwner && requestedRole === 'software-owner' ? 'head-coach' : requestedRole;
	const actorTenantId = resolveTenantKeyFromUser(actor);
	const swimClub = actorIsPrimaryOwner
		? String(req.body?.swimClub || '').trim()
		: String(actor?.swimClub || '').trim();
	const teamName = actorIsPrimaryOwner
		? String(req.body?.teamName || '').trim()
		: String(actor?.teamName || '').trim();
	const requestedTenantId = normalizeTenantId(req.body?.tenantId)
		|| resolveTenantKeyFromUser({ username, role, swimClub, teamName });
	const tenantId = role === 'software-owner'
		? 'global-owner'
		: (actorIsPrimaryOwner ? requestedTenantId : actorTenantId);
	if (role === 'head-coach') {
		const sessionCoordinatorCapacityError = getSessionCoordinatorCapacityError(tenantId);
		if (sessionCoordinatorCapacityError) {
			res.status(403).json({ error: sessionCoordinatorCapacityError });
			return;
		}
	}

	if (!username || !password) {
		res.status(400).json({ error: 'Username and password are required.' });
		return;
	}

	if (authUsers.some((row) => row.username === username)) {
		res.status(409).json({ error: 'User already exists.' });
		return;
	}

	authUsers.push({
		username,
		role,
		tenantId,
		passwordHash: hashPassword(password),
		tokenValidAfter: 0,
		createdVia: 'admin',
		createdAt: new Date().toISOString(),
		swimClub,
		teamName,
		billing: getDefaultBillingState(),
	});

	try {
		persistAuthUsers();
		appendAuthAuditEvent({
			action: 'user_created',
			req,
			status: 'success',
			target: username,
			details: { role },
		});
		res.status(201).json({
			ok: true,
			user: { username, role },
		});
	} catch (error) {
		authUsers.pop();
		res.status(500).json({
			error: 'Could not persist auth user.',
			details: error instanceof Error ? error.message : 'Unknown error',
		});
	}
});

app.put('/auth/users/:username/password', requireStrictAuth, requireAdminRole, requireAdminRateLimit, (req, res) => {
	const targetUsername = String(req.params?.username || '').trim();
	const nextPassword = String(req.body?.password || '');
	if (!targetUsername || !nextPassword) {
		res.status(400).json({ error: 'Username and password are required.' });
		return;
	}

	const index = authUsers.findIndex((row) => row.username === targetUsername);
	if (index < 0) {
		res.status(404).json({ error: 'User not found.' });
		return;
	}
	if (!canAdminManageUser(req.auth, authUsers[index])) {
		res.status(403).json({ error: 'Tenant scope does not allow managing this user.' });
		return;
	}

	const previous = authUsers[index];
	authUsers[index] = {
		...previous,
		passwordHash: hashPassword(nextPassword),
		tokenValidAfter: getNowEpochSeconds(),
	};

	try {
		persistAuthUsers();
		appendAuthAuditEvent({
			action: 'password_reset',
			req,
			status: 'success',
			target: targetUsername,
		});
		res.status(200).json({ ok: true, username: targetUsername });
	} catch (error) {
		authUsers[index] = previous;
		res.status(500).json({
			error: 'Could not update password.',
			details: error instanceof Error ? error.message : 'Unknown error',
		});
	}
});

app.put('/auth/users/:username/role', requireStrictAuth, requireAdminRole, requireAdminRateLimit, (req, res) => {
	const targetUsername = String(req.params?.username || '').trim();
	const nextRole = String(req.body?.role || '').trim();
	if (!targetUsername || !nextRole) {
		res.status(400).json({ error: 'Username and role are required.' });
		return;
	}

	const index = authUsers.findIndex((row) => row.username === targetUsername);
	if (index < 0) {
		res.status(404).json({ error: 'User not found.' });
		return;
	}
	if (!canAdminManageUser(req.auth, authUsers[index])) {
		res.status(403).json({ error: 'Tenant scope does not allow managing this user.' });
		return;
	}
	if (!isPrimarySoftwareOwnerAccount(req.auth) && nextRole === 'software-owner') {
		res.status(403).json({ error: 'Tenant admins cannot assign software-owner role.' });
		return;
	}
	if (nextRole === 'head-coach') {
		const targetTenantId = resolveTenantKeyFromUser(authUsers[index]);
		const sessionCoordinatorCapacityError = getSessionCoordinatorCapacityError(targetTenantId, { excludeUsername: targetUsername });
		if (sessionCoordinatorCapacityError) {
			res.status(403).json({ error: sessionCoordinatorCapacityError });
			return;
		}
	}

	const previous = authUsers[index];
	authUsers[index] = {
		...previous,
		role: nextRole,
		tokenValidAfter: getNowEpochSeconds(),
	};

	try {
		persistAuthUsers();
		appendAuthAuditEvent({
			action: 'role_changed',
			req,
			status: 'success',
			target: targetUsername,
			details: { role: nextRole },
		});
		res.status(200).json({
			ok: true,
			user: { username: targetUsername, role: nextRole },
		});
	} catch (error) {
		authUsers[index] = previous;
		res.status(500).json({
			error: 'Could not update role.',
			details: error instanceof Error ? error.message : 'Unknown error',
		});
	}
});

app.put('/auth/users/:username/approval', requireStrictAuth, requireAdminRole, requireAdminRateLimit, (req, res) => {
	const targetUsername = String(req.params?.username || '').trim();
	const approved = req.body?.approved !== false;
	if (!targetUsername) {
		res.status(400).json({ error: 'Username is required.' });
		return;
	}

	const index = authUsers.findIndex((row) => row.username === targetUsername);
	if (index < 0) {
		res.status(404).json({ error: 'User not found.' });
		return;
	}
	if (!canAdminManageUser(req.auth, authUsers[index])) {
		res.status(403).json({ error: 'Tenant scope does not allow managing this user.' });
		return;
	}

	const previous = authUsers[index];
	authUsers[index] = {
		...previous,
		isApproved: approved,
		tokenValidAfter: getNowEpochSeconds(),
	};

	try {
		persistAuthUsers();
		appendAuthAuditEvent({
			action: approved ? 'user_approved' : 'user_unapproved',
			req,
			status: 'success',
			target: targetUsername,
		});
		res.status(200).json({ ok: true, username: targetUsername, approved });
	} catch (error) {
		authUsers[index] = previous;
		res.status(500).json({
			error: 'Could not update approval state.',
			details: error instanceof Error ? error.message : 'Unknown error',
		});
	}
});

app.delete('/auth/users/:username', requireStrictAuth, requireAdminRole, requireAdminRateLimit, (req, res) => {
	const targetUsername = String(req.params?.username || '').trim();
	if (!targetUsername) {
		res.status(400).json({ error: 'Username is required.' });
		return;
	}

	const index = authUsers.findIndex((row) => row.username === targetUsername);
	if (index < 0) {
		res.status(404).json({ error: 'User not found.' });
		return;
	}
	if (!canAdminManageUser(req.auth, authUsers[index])) {
		res.status(403).json({ error: 'Tenant scope does not allow managing this user.' });
		return;
	}

	const currentUserName = String(req.auth?.username || '').trim();
	if (targetUsername === currentUserName) {
		res.status(400).json({ error: 'You cannot delete your own active account.' });
		return;
	}

	const [removed] = authUsers.splice(index, 1);
	try {
		persistAuthUsers();
		appendAuthAuditEvent({
			action: 'user_deleted',
			req,
			status: 'success',
			target: targetUsername,
		});
		res.status(200).json({ ok: true, username: targetUsername });
	} catch (error) {
		authUsers.splice(index, 0, removed);
		res.status(500).json({
			error: 'Could not delete user.',
			details: error instanceof Error ? error.message : 'Unknown error',
		});
	}
});

function normalizeDocumentsForPermission(rows) {
	const source = Array.isArray(rows) ? rows : [];
	return source
		.map((row) => ({
			id: String(row?.id || ''),
			title: String(row?.title || ''),
			placeholderKey: String(row?.placeholderKey || ''),
			contentType: String(row?.contentType || 'text'),
			pageKey: String(row?.pageKey || ''),
			sectionKey: String(row?.sectionKey || ''),
			elementKey: String(row?.elementKey || ''),
			buttonUrl: String(row?.buttonUrl || ''),
			category: String(row?.category || ''),
			notes: String(row?.notes || ''),
			contentHtml: String(row?.contentHtml || ''),
			isPublished: Boolean(row?.isPublished),
			fileName: String(row?.fileName || ''),
			fileType: String(row?.fileType || ''),
			fileSize: Number(row?.fileSize || 0),
			fileDataUrl: String(row?.fileDataUrl || ''),
			version: Math.max(1, Number(row?.version || 1)),
			updatedAt: String(row?.updatedAt || ''),
		}))
		.sort((a, b) => String(a.id).localeCompare(String(b.id)));
}

function hasUnauthorizedDocumentsChange(currentDb, nextDb, auth) {
	const role = String(auth?.role || '').trim();
	const username = String(auth?.username || '').trim().toLowerCase();
	if (role === 'software-owner' && username === AUTH_PRIMARY_SOFTWARE_OWNER_USERNAME) {
		return false;
	}
	const currentDocs = normalizeDocumentsForPermission(currentDb?.documents);
	const nextDocs = normalizeDocumentsForPermission(nextDb?.documents);
	return JSON.stringify(currentDocs) !== JSON.stringify(nextDocs);
}

app.get('/content/placeholders', (req, res) => {
	fs.readFile(DB_PATH, 'utf8', (err, data) => {
		if (err) {
			res.status(500).json({ error: 'Could not read db.json' });
			return;
		}

		try {
			const parsed = JSON.parse(data);
			const sourceRows = Array.isArray(parsed?.documents) ? parsed.documents : [];
			const publishedRows = sourceRows
				.filter((row) => row && typeof row === 'object' && row.isPublished)
				.map((row) => ({
					id: String(row?.id || ''),
					title: String(row?.title || ''),
					placeholderKey: String(row?.placeholderKey || ''),
					contentType: String(row?.contentType || 'text'),
					pageKey: String(row?.pageKey || ''),
					sectionKey: String(row?.sectionKey || ''),
					elementKey: String(row?.elementKey || ''),
					buttonUrl: String(row?.buttonUrl || ''),
					category: String(row?.category || ''),
					notes: String(row?.notes || ''),
					contentHtml: String(row?.contentHtml || ''),
					fileName: String(row?.fileName || ''),
					fileType: String(row?.fileType || ''),
					fileSize: Number(row?.fileSize || 0),
					fileDataUrl: String(row?.fileDataUrl || ''),
					version: Math.max(1, Number(row?.version || 1)),
					updatedAt: String(row?.updatedAt || row?.createdAt || ''),
				}))
				.filter((row) => row.placeholderKey);

			const placeholders = {};
			for (const row of publishedRows) {
				const key = String(row.placeholderKey || '').trim();
				if (!key) continue;
				const existing = placeholders[key];
				if (!existing) {
					placeholders[key] = row;
					continue;
				}
				const existingMs = Date.parse(String(existing?.updatedAt || ''));
				const rowMs = Date.parse(String(row?.updatedAt || ''));
				if (Number.isFinite(rowMs) && (!Number.isFinite(existingMs) || rowMs > existingMs)) {
					placeholders[key] = row;
				}
			}

			res.setHeader('Content-Type', 'application/json');
			res.setHeader('Cache-Control', 'no-store');
			res.status(200).json({
				ok: true,
				count: Object.keys(placeholders).length,
				updatedAt: new Date().toISOString(),
				placeholders,
			});
		} catch {
			res.status(500).json({ error: 'Could not parse db.json payload.' });
		}
	});
});

function buildCapabilityEngineScores(payload) {
	const config = mergeCanonicalConfig(payload?.calibration);
	const referenceTsRaw = Date.parse(String(payload?.referenceDate || '').trim());
	const referenceTs = Number.isFinite(referenceTsRaw) ? referenceTsRaw : Date.now();

	const trainingRows = scoreCapabilityRows(payload?.trainingRows, config);
	const validationSignalRows = scoreCapabilityRows(payload?.validationSignalRows, config);
	const capabilityBlendRows = scoreCapabilityRows(payload?.capabilityBlendRows, config);
	const effectiveCoachRows = scoreCapabilityRows(payload?.effectiveCoachRows, config);
	const integratedRows = scoreCapabilityRows(payload?.integratedRows, config);
	const competitionSignalRows = scoreCapabilityRows(payload?.competitionSignalRows, config);
	const previousValidationSignalRows = scoreCapabilityRows(payload?.previousValidationSignalRows, config);
	const historyValidationSignalRows = scoreCapabilityRows(payload?.historyValidationSignalRows, config);
	const previousIntegratedRows = scoreCapabilityRows(payload?.previousIntegratedRows, config);
	const historyIntegratedRows = scoreCapabilityRows(payload?.historyIntegratedRows, config);

	return {
		trainingCalc: calculateCanonicalAxisScores(trainingRows, 'training', config, referenceTs),
		validationCalc: calculateCanonicalAxisScores(validationSignalRows, 'validation', config, referenceTs),
		competitionCalc: calculateCanonicalAxisScores(competitionSignalRows, 'validation', config, referenceTs),
		capabilityOnlyCalc: calculateCanonicalAxisScores(capabilityBlendRows, 'integrated', config, referenceTs),
		coachOnlyCalc: calculateCanonicalAxisScores(effectiveCoachRows, 'integrated', config, referenceTs),
		integratedCalc: calculateCanonicalIntegratedScores(integratedRows, config, referenceTs),
		previousValidationCalc: calculateCanonicalAxisScores(previousValidationSignalRows, 'validation', config, referenceTs),
		historyValidationCalc: calculateCanonicalAxisScores(historyValidationSignalRows, 'validation', config, referenceTs),
		previousIntegratedCalc: calculateCanonicalIntegratedScores(previousIntegratedRows, config, referenceTs),
		historyIntegratedCalc: calculateCanonicalIntegratedScores(historyIntegratedRows, config, referenceTs),
	};
}

app.post('/content/capability/score', requireAuth, (req, res) => {
	try {
		res.status(200).json({
			ok: true,
			scores: buildCapabilityEngineScores(req.body || {}),
			generatedAt: new Date().toISOString(),
		});
	} catch (error) {
		res.status(500).json({
			error: 'Could not compute capability scores.',
			details: error instanceof Error ? error.message : 'Unknown error',
		});
	}
});

app.post('/snapshot/account/auth', requireLoginRateLimit, (req, res) => {
	const identifier = String(req.body?.email || '').trim();
	const password = String(req.body?.password || '');
	const fullName = String(req.body?.fullName || '').trim();
	const createAccount = req.body?.createAccount === true;

	if (!identifier || !password) {
		res.status(400).json({ error: 'Email/username and password are required.' });
		return;
	}

	if (createAccount) {
		if (!fullName) {
			res.status(400).json({ error: 'Full name is required.' });
			return;
		}
		if (password.length < 8) {
			res.status(400).json({ error: 'Password must be at least 8 characters.' });
			return;
		}

		const normalizedEmail = String(identifier || '').trim().toLowerCase();
		if (!AUTH_EMAIL_PATTERN.test(normalizedEmail)) {
			res.status(400).json({ error: 'Enter a valid email address.' });
			return;
		}
		if (authUsers.some((row) => String(row?.email || '').trim().toLowerCase() === normalizedEmail)) {
			res.status(409).json({ error: 'Email is already registered.' });
			return;
		}

		const emailBase = String(normalizedEmail.split('@')[0] || '')
			.trim()
			.toLowerCase()
			.replace(/[^a-z0-9._-]+/g, '-')
			.replace(/^-+|-+$/g, '')
			.slice(0, 24) || 'swimmer';
		let username = emailBase;
		const uniqueBase = String(username || 'swimmer').slice(0, 24) || 'swimmer';
		let suffix = 0;
		while (authUsers.some((row) => String(row?.username || '').trim() === username) && suffix < 1000) {
			suffix += 1;
			username = `${uniqueBase}-${suffix}`.slice(0, 32);
		}
		if (authUsers.some((row) => String(row?.username || '').trim() === username)) {
			res.status(500).json({ error: 'Could not allocate a unique username. Try again.' });
			return;
		}

		authUsers.push({
			username,
			role: 'swimmer',
			tenantId: 'snapshot-public',
			passwordHash: hashPassword(password),
			tokenValidAfter: 0,
			createdVia: 'snapshot-self-signup',
			inviteCodeUsed: false,
			createdAt: new Date().toISOString(),
			fullName,
			email: normalizedEmail,
			phone: '',
			swimClub: 'AthlyraX Snapshot',
			teamName: 'AthlyraX Snapshot',
			city: '',
			country: '',
			isApproved: true,
			onboardingCompletedAt: '',
			billing: getDefaultBillingState(),
		});

		try {
			persistAuthUsers();
			const token = issueAuthToken({ username, role: 'swimmer' });
			res.status(201).json({
				ok: true,
				token,
				user: buildAuthUserPayload(findAuthUser(username)),
			});
		} catch (error) {
			authUsers.pop();
			res.status(500).json({
				error: 'Could not create snapshot account.',
				details: error instanceof Error ? error.message : 'Unknown error',
			});
		}
		return;
	}

	const user = findAuthUserByIdentifier(identifier);
	if (!user || !verifyPassword(password, user.passwordHash)) {
		res.status(401).json({ error: 'Invalid credentials.' });
		return;
	}

	const token = issueAuthToken(user);
	res.status(200).json({ token, user: buildAuthUserPayload(user) });
});

app.post('/snapshot/account/password-reset/request', requireLoginRateLimit, async (req, res) => {
	const identifier = String(req.body?.identifier || '').trim();
	if (!identifier) {
		res.status(400).json({ error: 'Email or username is required.' });
		return;
	}

	const user = findAuthUserByIdentifier(identifier);
	if (!user) {
		res.status(200).json({ ok: true, message: 'If an account exists, a reset code has been issued.' });
		return;
	}

	const username = String(user.username || '').trim().toLowerCase();
	const resetCode = makePasswordResetCode();
	const expiresAtMs = Date.now() + (AUTH_PASSWORD_RESET_TTL_MINUTES * 60 * 1000);
	try {
		await deliverPasswordResetCode({ user, resetCode });
		authPasswordResetByUser.set(username, {
			codeHash: hashPasswordResetCode(resetCode),
			expiresAtMs,
			requestedAt: new Date().toISOString(),
		});

		const payload = {
			ok: true,
			message: 'If an account exists, a reset code has been issued.',
			resetCodeTtlMinutes: AUTH_PASSWORD_RESET_TTL_MINUTES,
		};
		if (!IS_PRODUCTION && AUTH_PASSWORD_RESET_DEV_CODE_IN_RESPONSE) {
			payload.devResetCode = resetCode;
			payload.devResetUser = username;
		}
		res.status(200).json(payload);
	} catch (error) {
		res.status(500).json({
			error: 'Could not issue reset code. Please try again.',
			details: error instanceof Error ? error.message : 'Unknown error',
		});
	}
});

app.post('/snapshot/account/password-reset/confirm', requireLoginRateLimit, (req, res) => {
	const identifier = String(req.body?.identifier || '').trim();
	const resetCode = String(req.body?.code || '').trim();
	const nextPassword = String(req.body?.password || '');

	if (!identifier || !resetCode || !nextPassword) {
		res.status(400).json({ error: 'Email/username, reset code, and new password are required.' });
		return;
	}
	if (nextPassword.length < 8) {
		res.status(400).json({ error: 'Password must be at least 8 characters.' });
		return;
	}

	const user = findAuthUserByIdentifier(identifier);
	if (!user) {
		res.status(404).json({ error: 'User not found.' });
		return;
	}

	const userKey = String(user.username || '').trim().toLowerCase();
	const resetEntry = authPasswordResetByUser.get(userKey);
	if (!resetEntry || Number(resetEntry.expiresAtMs || 0) <= Date.now()) {
		authPasswordResetByUser.delete(userKey);
		res.status(400).json({ error: 'Reset code is invalid or expired.' });
		return;
	}

	if (hashPasswordResetCode(resetCode) !== String(resetEntry.codeHash || '')) {
		res.status(400).json({ error: 'Reset code is invalid or expired.' });
		return;
	}

	const index = authUsers.findIndex((row) => String(row?.username || '').trim().toLowerCase() === userKey);
	if (index < 0) {
		authPasswordResetByUser.delete(userKey);
		res.status(404).json({ error: 'User not found.' });
		return;
	}

	const previous = authUsers[index];
	authUsers[index] = {
		...previous,
		passwordHash: hashPassword(nextPassword),
		tokenValidAfter: getNowEpochSeconds(),
	};

	try {
		persistAuthUsers();
		authPasswordResetByUser.delete(userKey);
		res.status(200).json({ ok: true, username: authUsers[index].username });
	} catch (error) {
		authUsers[index] = previous;
		res.status(500).json({
			error: 'Could not update password.',
			details: error instanceof Error ? error.message : 'Unknown error',
		});
	}
});

function sanitizeSnapshotSummaryForClient(summary) {
	const source = summary && typeof summary === 'object' ? summary : {};
	const metrics = source.metrics && typeof source.metrics === 'object' ? source.metrics : {};
	const radar = source.radar && typeof source.radar === 'object' ? source.radar : {};
	const labels = Array.isArray(radar.labels) ? radar.labels : [];
	const displayCapability = Array.isArray(radar.displayCapability)
		? radar.displayCapability.map((value) => clampPercent(value))
		: [];
	const capability = Array.isArray(radar.capability)
		? radar.capability.map((value) => clampPercent(value))
		: [];
	const resolvedDisplayCapability = displayCapability.length === labels.length
		? displayCapability
		: (capability.length === labels.length ? capability : labels.map(() => 0));

	return {
		metrics,
		radar: {
			labels,
			displayCapability: resolvedDisplayCapability,
			drift: clampPercent(radar?.drift),
		},
	};
}

app.post('/snapshot/instant', requireLoginRateLimit, (req, res) => {
	const summary = buildSnapshotSummaryFromPayload(req.body || {});
	const safeSummary = sanitizeSnapshotSummaryForClient(summary);
	res.status(200).json({
		ok: true,
		mode: 'instant',
		summary: safeSummary,
		storage: 'not-saved',
		reliability: 'Instant mode is for quick feedback and does not save history.',
	});
});

app.post('/snapshot/account', requireStrictAuth, (req, res) => {
	const authUser = findAuthUser(String(req.auth?.username || '').trim()) || req.auth || {};
	const role = String(authUser?.role || '').trim().toLowerCase();
	if (role !== 'swimmer') {
		res.status(403).json({ error: 'Snapshot account mode is available only for swimmer accounts.' });
		return;
	}

	const summary = buildSnapshotSummaryFromPayload(req.body || {});
	const username = String(authUser?.username || '').trim();
	const rawEmail = String(req.body?.email || authUser?.email || '').trim().toLowerCase();
	const email = AUTH_EMAIL_PATTERN.test(rawEmail) ? rawEmail : '';
	const stroke = String(req.body?.stroke || 'freestyle').trim().toLowerCase() || 'freestyle';
	const submission = {
		id: `snapshot_${Date.now().toString(36)}_${crypto.randomBytes(3).toString('hex')}`,
		mode: 'account',
		userId: username,
		username,
		email,
		stroke,
		snapshotDate: new Date().toISOString(),
		createdAt: new Date().toISOString(),
		summary,
		metrics: summary.metrics,
		indicators: summary.indicators,
		interpretationText: summary.interpretationText,
		radar: summary.radar,
		results: summary,
	};

	snapshotSubmissions.unshift(submission);
	if (snapshotSubmissions.length > 5000) {
		snapshotSubmissions.length = 5000;
	}

	try {
		persistSnapshotSubmissions();
		res.status(200).json({
			ok: true,
			mode: 'account',
			submissionId: submission.id,
			summary: sanitizeSnapshotSummaryForClient(summary),
			storage: 'saved',
			reliability: 'Account mode stores your snapshot so it appears in history and viewer routes.',
			emailNotificationsEnabled: Boolean(authUser?.snapshotEmailNotificationsEnabled !== false),
		});
	} catch (error) {
		snapshotSubmissions = snapshotSubmissions.filter((row) => String(row?.id || '') !== submission.id);
		res.status(500).json({
			error: 'Could not save snapshot submission.',
			details: error instanceof Error ? error.message : 'Unknown error',
		});
	}
});

app.get('/snapshot/account/history', requireStrictAuth, (req, res) => {
	const username = String(req.auth?.username || '').trim().toLowerCase();
	const rows = snapshotSubmissions
		.filter((row) => String(row?.userId || row?.username || '').trim().toLowerCase() === username)
		.slice(0, 300)
		.map((row) => {
			const safeSummary = sanitizeSnapshotSummaryForClient(row?.summary || row?.results || row);
			return {
				id: row?.id,
				mode: row?.mode,
				userId: row?.userId,
				username: row?.username,
				email: row?.email,
				stroke: row?.stroke,
				snapshotDate: row?.snapshotDate,
				createdAt: row?.createdAt,
				metrics: safeSummary.metrics,
				radar: safeSummary.radar,
			};
		});
	res.status(200).json({ ok: true, rows });
});

app.get('/snapshot/account/history/:submissionId', requireStrictAuth, (req, res) => {
	const username = String(req.auth?.username || '').trim().toLowerCase();
	const submissionId = String(req.params?.submissionId || '').trim();
	if (!submissionId) {
		res.status(400).json({ error: 'Submission id is required.' });
		return;
	}
	const row = snapshotSubmissions.find((entry) => {
		const entryId = String(entry?.id || '').trim();
		const entryUser = String(entry?.userId || entry?.username || '').trim().toLowerCase();
		return entryId === submissionId && entryUser === username;
	});
	if (!row) {
		res.status(404).json({ error: 'Snapshot submission not found.' });
		return;
	}
	const safeSummary = sanitizeSnapshotSummaryForClient(row?.summary || row?.results || row);
	res.status(200).json({
		ok: true,
		row: {
			id: row?.id,
			mode: row?.mode,
			userId: row?.userId,
			username: row?.username,
			email: row?.email,
			stroke: row?.stroke,
			snapshotDate: row?.snapshotDate,
			createdAt: row?.createdAt,
			metrics: safeSummary.metrics,
			radar: safeSummary.radar,
			results: safeSummary,
		},
	});
});

app.get('/snapshot/account/settings', requireStrictAuth, (req, res) => {
	const authUser = findAuthUser(String(req.auth?.username || '').trim()) || req.auth || {};
	res.status(200).json({
		ok: true,
		emailNotificationsEnabled: Boolean(authUser?.snapshotEmailNotificationsEnabled !== false),
	});
});

app.post('/snapshot/account/settings', requireStrictAuth, (req, res) => {
	const username = String(req.auth?.username || '').trim().toLowerCase();
	const enabled = req.body?.emailNotificationsEnabled !== false;
	const index = authUsers.findIndex((row) => String(row?.username || '').trim().toLowerCase() === username);
	if (index >= 0) {
		const previous = authUsers[index];
		authUsers[index] = {
			...previous,
			snapshotEmailNotificationsEnabled: Boolean(enabled),
		};
		try {
			persistAuthUsers();
		} catch (error) {
			authUsers[index] = previous;
			res.status(500).json({
				error: 'Could not save snapshot settings.',
				details: error instanceof Error ? error.message : 'Unknown error',
			});
			return;
		}
	}
	res.status(200).json({ ok: true, emailNotificationsEnabled: Boolean(enabled) });
});

function normalizeNameKey(value) {
	return String(value || '')
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();
}

function splitFullName(fullName) {
	const cleaned = String(fullName || '').trim().replace(/\s+/g, ' ');
	if (!cleaned) return { firstName: '', lastName: '' };
	const parts = cleaned.split(' ');
	if (parts.length < 2) {
		return { firstName: parts[0], lastName: '' };
	}
	return {
		firstName: parts[0],
		lastName: parts.slice(1).join(' '),
	};
}

function normalizeTargetPreference(rawPreference) {
	const source = rawPreference && typeof rawPreference === 'object' ? rawPreference : {};
	const ignored = Boolean(source?.ignored);
	const event = ignored ? '' : String(source?.event || '').trim();
	const date = ignored ? '' : String(source?.date || '').trim();
	const mode = String(source?.mode || 'independent').trim() || 'independent';
	const status = String(source?.status || 'none').trim() || 'none';
	return {
		ignored,
		event,
		date,
		notes: String(source?.notes || '').trim(),
		status,
		mode,
		updatedAt: String(source?.updatedAt || new Date().toISOString()).trim() || new Date().toISOString(),
	};
}

function normalizeTargetHistoryRows(rows) {
	const sourceRows = Array.isArray(rows) ? rows : [];
	return sourceRows
		.map((row, index) => {
			const at = String(row?.at || '').trim();
			if (!at) return null;
			return {
				id: String(row?.id || `target-history-${index}-${Date.now().toString(36)}`).trim(),
				at,
				action: String(row?.action || 'Target update').trim() || 'Target update',
				mode: String(row?.mode || 'independent').trim() || 'independent',
				status: String(row?.status || 'none').trim() || 'none',
				event: String(row?.event || '').trim(),
				date: String(row?.date || '').trim(),
				notes: String(row?.notes || '').trim(),
			};
		})
		.filter(Boolean)
		.slice(0, 240);
}

function normalizeSwimmerPathway(value) {
	return String(value || '').trim().toLowerCase() === 'club' ? 'club' : 'individual';
}

function normalizeCoachLinkStatus(value) {
	const normalized = String(value || '').trim().toLowerCase();
	if (normalized === 'pending' || normalized === 'approved') return normalized;
	return 'none';
}

function normalizeIsoDateString(value) {
	const raw = String(value || '').trim();
	if (!raw) return '';
	if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return '';
	const ms = Date.parse(`${raw}T00:00:00Z`);
	if (!Number.isFinite(ms)) return '';
	return raw;
}

function ageFromDob(dob) {
	const normalizedDob = normalizeIsoDateString(dob);
	if (!normalizedDob) return null;
	const date = new Date(`${normalizedDob}T00:00:00Z`);
	if (!(date instanceof Date) || Number.isNaN(date.getTime())) return null;
	const now = new Date();
	let age = now.getUTCFullYear() - date.getUTCFullYear();
	const monthDelta = now.getUTCMonth() - date.getUTCMonth();
	if (monthDelta < 0 || (monthDelta === 0 && now.getUTCDate() < date.getUTCDate())) {
		age -= 1;
	}
	return Number.isFinite(age) ? age : null;
}

function normalizeEmailField(value) {
	const email = String(value || '').trim().toLowerCase();
	if (!email) return '';
	return AUTH_EMAIL_PATTERN.test(email) ? email : '';
}

function sanitizeSwimmerSyncPayload(sourcePayload = {}) {
	const source = sourcePayload && typeof sourcePayload === 'object' ? sourcePayload : {};
	const pathway = normalizeSwimmerPathway(source?.pathway);
	const linkStatus = normalizeCoachLinkStatus(source?.coachLinkStatus);
	const coachConnected = linkStatus === 'approved' ? true : Boolean(source?.coachConnected && linkStatus !== 'none');
	const dob = normalizeIsoDateString(source?.dob);
	const parent1 = normalizeEmailField(source?.parent1);
	const parent2 = normalizeEmailField(source?.parent2);
	const parent1Consent = source?.parent1Consent === true;
	const parent2Consent = source?.parent2Consent === true;
	const issues = [];

	if (linkStatus === 'approved' && pathway !== 'club') {
		issues.push('Approved coach links require club pathway.');
	}

	if (coachConnected && linkStatus !== 'approved') {
		issues.push('Coach connected flag requires approved coach link status.');
	}

	if (linkStatus === 'pending') {
		if (!String(source?.coachEmail || '').trim() && !String(source?.coachCode || '').trim()) {
			issues.push('Pending coach links require coach email or club code.');
		}
	}

	if (linkStatus === 'approved') {
		if (!String(source?.coachReplyAt || '').trim()) {
			issues.push('Approved coach links require a coach reply date.');
		}
		if (!String(source?.coachApprovalAt || '').trim()) {
			issues.push('Approved coach links require an approval date.');
		}
	}

	const age = ageFromDob(dob);
	if (linkStatus === 'approved' && Number.isFinite(age) && age < 18) {
		if (!parent1) issues.push('Under-18 approvals require parent email 1.');
		if (!parent1Consent) issues.push('Under-18 approvals require parent 1 consent.');
		if (parent2 && !parent2Consent) issues.push('Parent 2 consent is required when parent email 2 is provided.');
	}

	return {
		issues,
		payload: {
			dob,
			sex: String(source?.sex || '').trim(),
			gender: String(source?.gender || source?.sex || '').trim(),
			mainEvent: String(source?.mainEvent || '').trim(),
			club: String(source?.club || '').trim(),
			squad: String(source?.squad || '').trim(),
			pathway,
			coachConnected,
			coachLinkStatus: linkStatus,
			coachEmail: normalizeEmailField(source?.coachEmail),
			coachCode: String(source?.coachCode || '').trim(),
			coachPhase: String(source?.coachPhase || '').trim(),
			coachRequestAt: normalizeIsoDateString(source?.coachRequestAt),
			coachReplyAt: normalizeIsoDateString(source?.coachReplyAt),
			coachApprovalAt: normalizeIsoDateString(source?.coachApprovalAt),
			shareMode: String(source?.shareMode || '').trim(),
			parent1,
			parent2,
			parent1Consent,
			parent2Consent,
		},
	};
}

function resolveSwimmerRowIndex(swimmersRows, options = {}) {
	const rows = Array.isArray(swimmersRows) ? swimmersRows : [];
	if (rows.length < 1) return -1;
	const strictAccountBinding = options?.strictAccountBinding === true;
	const authUsername = String(options?.authUsername || '').trim().toLowerCase();
	if (authUsername) {
		const accountIndex = rows.findIndex((row) => String(row?.swimmerAccountUsername || '').trim().toLowerCase() === authUsername);
		if (accountIndex >= 0) return accountIndex;
	}

	const authEmail = String(options?.authEmail || '').trim().toLowerCase();
	if (authEmail) {
		const accountEmailIndex = rows.findIndex((row) => String(row?.swimmerAccountEmail || '').trim().toLowerCase() === authEmail);
		if (accountEmailIndex >= 0) return accountEmailIndex;
	}

	if (strictAccountBinding) return -1;

	const swimmerId = String(options?.swimmerId || '').trim();
	if (swimmerId) {
		const idIndex = rows.findIndex((row) => String(row?.id || '').trim() === swimmerId);
		if (idIndex >= 0) return idIndex;
	}

	const email = String(options?.email || '').trim().toLowerCase();
	if (email) {
		const emailIndex = rows.findIndex((row) => String(row?.email || '').trim().toLowerCase() === email);
		if (emailIndex >= 0) return emailIndex;
	}

	const fullName = String(options?.fullName || '').trim();
	const fullNameKey = normalizeNameKey(fullName);
	if (fullNameKey) {
		const byNameIndex = rows.findIndex((row) => {
			const rowFullName = `${String(row?.firstName || '').trim()} ${String(row?.lastName || '').trim()}`.trim();
			return normalizeNameKey(rowFullName) === fullNameKey;
		});
		if (byNameIndex >= 0) return byNameIndex;
	}

	const firstName = String(options?.firstName || '').trim();
	const lastName = String(options?.lastName || '').trim();
	if (firstName && lastName) {
		const firstKey = normalizeNameKey(firstName);
		const lastKey = normalizeNameKey(lastName);
		const splitIndex = rows.findIndex((row) => normalizeNameKey(row?.firstName) === firstKey && normalizeNameKey(row?.lastName) === lastKey);
		if (splitIndex >= 0) return splitIndex;
	}

	return -1;
}

function makeSwimmerBindingRowId() {
	return `swimmer-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function ensureSwimmerAccountBindingInStorage(authLike) {
	const username = String(authLike?.username || '').trim();
	if (!username) return { updated: false, reason: 'missing_username' };
	const authUser = findAuthUser(username) || authLike || {};
	const role = String(authUser?.role || '').trim().toLowerCase();
	if (role !== 'swimmer') return { updated: false, reason: 'not_swimmer' };

	const authUsername = String(authUser?.username || username).trim();
	const authEmail = String(authUser?.email || '').trim();
	const fullName = String(authUser?.fullName || authUsername).trim();
	const splitName = splitFullName(fullName);
	const storagePaths = resolveStoragePathsForAuth(authUser);
	ensureStorageLayout(storagePaths);

	const dbShape = readJsonFile(storagePaths.dbPath);
	const nextDb = dbShape && typeof dbShape === 'object' ? { ...dbShape } : {};
	const swimmersRows = Array.isArray(nextDb.swimmers)
		? nextDb.swimmers.filter((row) => row && typeof row === 'object').slice()
		: [];

	let swimmerIndex = resolveSwimmerRowIndex(swimmersRows, {
		authUsername,
		authEmail,
		strictAccountBinding: true,
	});

	let updated = false;
	if (swimmerIndex < 0) {
		swimmersRows.push({
			id: makeSwimmerBindingRowId(),
			firstName: splitName.firstName,
			lastName: splitName.lastName,
			name: fullName,
			email: authEmail,
			notes: 'Auto-healed swimmer binding row.',
			active: true,
			swimmerAccountUsername: authUsername,
			swimmerAccountEmail: authEmail,
		});
		swimmerIndex = swimmersRows.length - 1;
		updated = true;
	}

	if (swimmerIndex >= 0) {
		const current = swimmersRows[swimmerIndex] && typeof swimmersRows[swimmerIndex] === 'object'
			? swimmersRows[swimmerIndex]
			: {};
		const next = {
			...current,
			swimmerAccountUsername: authUsername,
			swimmerAccountEmail: authEmail || String(current?.swimmerAccountEmail || '').trim() || String(current?.email || '').trim(),
		};
		if (JSON.stringify(next) !== JSON.stringify(current)) {
			swimmersRows[swimmerIndex] = next;
			updated = true;
		}
	}

	if (!updated) {
		return { updated: false, tenantKey: storagePaths.tenantKey };
	}

	nextDb.swimmers = swimmersRows;
	writeAtomicJsonFile(storagePaths.dbPath, nextDb);
	return {
		updated: true,
		tenantKey: storagePaths.tenantKey,
		swimmerId: String(swimmersRows[swimmerIndex]?.id || ''),
	};
}

function autoHealSwimmerBindingsAtStartup() {
	if (!AUTH_AUTO_HEAL_SWIMMER_BINDINGS) return;
	const swimmerUsers = authUsers.filter((row) => String(row?.role || '').trim().toLowerCase() === 'swimmer');
	if (swimmerUsers.length < 1) return;
	let repaired = 0;
	for (const swimmerUser of swimmerUsers) {
		try {
			const result = ensureSwimmerAccountBindingInStorage(swimmerUser);
			if (result?.updated) repaired += 1;
		} catch {
			// Ignore healing failures at startup; runtime reads/logins still attempt healing.
		}
	}
	if (repaired > 0) {
		console.log(`[auth] Auto-healed swimmer bindings: ${repaired}`);
	}
}

function requireSwimmerRole(req, res, next) {
	const role = String(req.auth?.role || '').trim().toLowerCase();
	if (role === 'swimmer') {
		next();
		return;
	}
	res.status(403).json({ error: 'Swimmer access required.' });
}

function toFiniteNumber(value, fallback = 0) {
	const n = Number(value);
	return Number.isFinite(n) ? n : fallback;
}

function clampScore(value) {
	return Math.max(0, Math.min(100, toFiniteNumber(value, 0)));
}

function sanitizeAxisIds(axisIds) {
	const fallback = [
		'technical_control',
		'efficiency_cost',
		'robustness_of_efficiency',
		'aerobic_capacity',
		'anaerobic_capacity',
		'speed_expression',
		'performance_progression',
		'coach_observation',
	];
	if (!Array.isArray(axisIds)) return fallback;
	const next = Array.from(
		new Set(
			axisIds
				.map((item) => String(item || '').trim())
				.filter(Boolean)
		)
	);
	return next.length ? next : fallback;
}

function axisValueFromSnapshot(axisId, values = {}) {
	const source = values && typeof values === 'object' ? values : {};
	const normalizedAxisId = String(axisId || '').trim();
	if (normalizedAxisId === 'technical_control') {
		return clampScore(source?.technical_control ?? source?.technicalControl ?? source?.first_break_percent ?? source?.firstBreakPercent ?? 0);
	}
	if (normalizedAxisId === 'efficiency_cost' || normalizedAxisId === 'efficiency') {
		return clampScore(source?.efficiency_cost ?? source?.efficiencyCost ?? source?.efficiency ?? 0);
	}
	if (normalizedAxisId === 'robustness_of_efficiency') {
		return clampScore(source?.robustness_of_efficiency ?? source?.technical_stability ?? source?.durability ?? 0);
	}
	if (normalizedAxisId === 'aerobic_capacity') {
		return clampScore(source?.aerobic_capacity ?? source?.aerobicCapacity ?? source?.aerobic ?? 0);
	}
	if (normalizedAxisId === 'anaerobic_capacity') {
		return clampScore(source?.anaerobic_capacity ?? source?.repeatability ?? 0);
	}
	if (normalizedAxisId === 'speed_expression') {
		return clampScore(source?.speed_expression ?? source?.power_speed_expression ?? 0);
	}
	if (normalizedAxisId === 'performance_progression') {
		return clampScore(source?.performance_progression ?? source?.progression ?? source?.performance_control ?? source?.control ?? 0);
	}
	if (normalizedAxisId === 'coach_observation') {
		return clampScore(
			source?.coach_observation ??
			source?.coachObservation ??
			source?.coach_assessment ??
			source?.coachAssessment ??
			source?.coach ??
			0
		);
	}
	return clampScore(source?.[normalizedAxisId] ?? 0);
}

function capabilityScoreFromValues(valuesByAxis, axisIds) {
	const ids = sanitizeAxisIds(axisIds);
	const vals = ids.map((id) => clampScore(valuesByAxis?.[id] ?? 0));
	if (!vals.length) return 0;
	return Math.round(vals.reduce((sum, value) => sum + value, 0) / vals.length);
}

function normalizeValuesForAxes(values, axisIds) {
	const ids = sanitizeAxisIds(axisIds);
	const next = {};
	for (const id of ids) {
		next[id] = axisValueFromSnapshot(id, values);
	}
	return next;
}

app.post('/swimmer/capability/compute', requireStrictAuth, requireSwimmerRole, (req, res) => {
	const body = req.body && typeof req.body === 'object' ? req.body : {};
	const axisIds = sanitizeAxisIds(body?.axisIds);
	const snapshots = Array.isArray(body?.snapshots) ? body.snapshots.filter((row) => row && typeof row === 'object') : [];

	const valuesBySnapshotId = {};
	const scoreBySnapshotId = {};
	const normalizedByIndex = snapshots.map((snapshot, index) => {
		const values = normalizeValuesForAxes(snapshot?.values, axisIds);
		const score = capabilityScoreFromValues(values, axisIds);
		const key = String(snapshot?.id || `snapshot-${index + 1}`).trim();
		valuesBySnapshotId[key] = values;
		scoreBySnapshotId[key] = score;
		return { key, values, score };
	});

	const latest = normalizedByIndex[normalizedByIndex.length - 1] || { values: normalizeValuesForAxes({}, axisIds), score: 0 };
	const previous = normalizedByIndex[normalizedByIndex.length - 2] || latest;

	res.status(200).json({
		ok: true,
		axisIds,
		latestValues: latest.values,
		previousValues: previous.values,
		latestScore: latest.score,
		previousScore: previous.score,
		valuesBySnapshotId,
		scoreBySnapshotId,
	});
});

app.post('/swimmer/capability/apply-event', requireStrictAuth, requireSwimmerRole, (req, res) => {
	const body = req.body && typeof req.body === 'object' ? req.body : {};
	const axisIds = sanitizeAxisIds(body?.axisIds);
	const currentValues = normalizeValuesForAxes(body?.currentValues, axisIds);
	const eventKind = String(body?.eventKind || '').trim();
	const structured = body?.structured === true;
	const competition = body?.competition === true;

	let delta = 0;
	if (eventKind === 'training-day') {
		delta = structured ? 2 : 1;
	} else if (eventKind === 'test-entry') {
		delta = competition ? 3 : 2;
	} else {
		res.status(400).json({ error: 'Unsupported event kind.' });
		return;
	}

	const nextValues = {};
	for (const id of axisIds) {
		nextValues[id] = clampScore(currentValues[id] + delta);
	}

	res.status(200).json({
		ok: true,
		axisIds,
		values: nextValues,
		score: capabilityScoreFromValues(nextValues, axisIds),
	});
});

app.post('/swimmer/profile/targets', requireStrictAuth, requireSwimmerRole, (req, res) => {
	const profilePayload = req.body && typeof req.body === 'object' ? req.body : {};
	const targetPreference = normalizeTargetPreference(profilePayload?.targetPreference);
	const targetHistory = normalizeTargetHistoryRows(profilePayload?.targetHistory);
	const swimmerPayload = profilePayload?.swimmer && typeof profilePayload.swimmer === 'object' ? profilePayload.swimmer : {};

	const fullName = String(swimmerPayload?.name || swimmerPayload?.fullName || '').trim() || String(findAuthUser(String(req.auth?.username || '').trim())?.fullName || '').trim();
	const splitName = splitFullName(fullName);
	const email = String(swimmerPayload?.email || '').trim() || String(findAuthUser(String(req.auth?.username || '').trim())?.email || '').trim();
	const authUsername = String(req.auth?.username || '').trim();
	const authEmail = String(findAuthUser(authUsername)?.email || '').trim();
	const swimmerId = String(swimmerPayload?.id || '').trim();

	const storagePaths = resolveStoragePathsForAuth(req.auth);
	ensureStorageLayout(storagePaths);
	const dbShape = readJsonFile(storagePaths.dbPath);
	const nextDb = dbShape && typeof dbShape === 'object' ? { ...dbShape } : {};
	const swimmersRows = Array.isArray(nextDb.swimmers) ? nextDb.swimmers.slice() : [];

	const swimmerIndex = resolveSwimmerRowIndex(swimmersRows, {
		authUsername,
		authEmail,
		swimmerId,
		email,
		fullName,
		firstName: splitName.firstName,
		lastName: splitName.lastName,
		strictAccountBinding: true,
	});

	let resolvedSwimmerIndex = swimmerIndex;
	if (resolvedSwimmerIndex < 0) {
		swimmersRows.push({
			id: swimmerId || `swimmer-${Date.now().toString(36)}`,
			firstName: splitName.firstName,
			lastName: splitName.lastName,
			name: fullName,
			email,
			swimmerAccountUsername: authUsername,
			swimmerAccountEmail: authEmail || email,
		});
		resolvedSwimmerIndex = swimmersRows.length - 1;
	}

	const existingRow = swimmersRows[resolvedSwimmerIndex] && typeof swimmersRows[resolvedSwimmerIndex] === 'object'
		? swimmersRows[resolvedSwimmerIndex]
		: {};

	swimmersRows[resolvedSwimmerIndex] = {
		...existingRow,
		targetPreference,
		targetHistory,
		targetHistoryUpdatedAt: new Date().toISOString(),
		swimmerAccountUsername: String(req.auth?.username || '').trim(),
		swimmerAccountEmail: String(email || '').trim(),
	};

	nextDb.swimmers = swimmersRows;

	try {
		writeAtomicJsonFile(storagePaths.dbPath, nextDb);
		writeDbSnapshotIfPossible(storagePaths.dbPath, storagePaths.snapshotDir);
		res.status(200).json({
			ok: true,
			swimmerId: String(swimmersRows[resolvedSwimmerIndex]?.id || ''),
			targetHistoryCount: targetHistory.length,
		});
	} catch (error) {
		res.status(500).json({
			error: 'Could not save swimmer target profile.',
			details: error instanceof Error ? error.message : 'Unknown error',
		});
	}
});

app.post('/swimmer/profile/sync', requireStrictAuth, requireSwimmerRole, (req, res) => {
	const body = req.body && typeof req.body === 'object' ? req.body : {};
	const swimmerPayload = body?.swimmer && typeof body.swimmer === 'object' ? body.swimmer : {};
	const snapshots = Array.isArray(body?.snapshots) ? body.snapshots.slice(0, SWIMMER_SYNC_MAX_SNAPSHOTS) : [];
	const history = Array.isArray(body?.history) ? body.history.slice(0, SWIMMER_SYNC_MAX_HISTORY_DAYS) : [];
	const pbRows = Array.isArray(body?.pbRows) ? body.pbRows.slice(0, SWIMMER_SYNC_MAX_PB_ROWS) : [];
	const pbSelectedSnapshotIds = Array.isArray(body?.pbSelectedSnapshotIds)
		? body.pbSelectedSnapshotIds.map((id) => String(id || '').trim()).filter(Boolean)
		: [];
	const targetPreference = normalizeTargetPreference(body?.targetPreference);
	const targetHistory = normalizeTargetHistoryRows(body?.targetHistory);
	const customTestSets = Array.isArray(body?.customTestSets) ? body.customTestSets.slice(0, SWIMMER_SYNC_MAX_TEST_SETS) : [];
	const ispProfile = body?.ispProfile && typeof body.ispProfile === 'object' ? body.ispProfile : null;
	const sanitizedSync = sanitizeSwimmerSyncPayload(swimmerPayload);

	if (sanitizedSync.issues.length) {
		appendAuthAuditEvent({
			action: 'swimmer_profile_sync_rejected',
			req,
			status: 'blocked',
			reason: 'validation_failed',
			details: {
				issues: sanitizedSync.issues,
				pathway: sanitizedSync.payload.pathway,
				coachLinkStatus: sanitizedSync.payload.coachLinkStatus,
			},
		});
		res.status(400).json({
			error: 'Swimmer profile sync validation failed.',
			issues: sanitizedSync.issues,
		});
		return;
	}

	const authUsername = String(req.auth?.username || '').trim();
	const authUser = findAuthUser(authUsername) || {};
	const authEmail = String(authUser?.email || '').trim();
	const fullName = String(swimmerPayload?.name || swimmerPayload?.fullName || authUser?.fullName || authUsername).trim();
	const splitName = splitFullName(fullName);
	const email = normalizeEmailField(swimmerPayload?.email || authEmail);
	const swimmerId = String(swimmerPayload?.id || '').trim();

	const storagePaths = resolveStoragePathsForAuth(req.auth);
	ensureStorageLayout(storagePaths);
	const dbShape = readJsonFile(storagePaths.dbPath);
	const nextDb = dbShape && typeof dbShape === 'object' ? { ...dbShape } : {};
	const swimmersRows = Array.isArray(nextDb.swimmers) ? nextDb.swimmers.slice() : [];

	let swimmerIndex = resolveSwimmerRowIndex(swimmersRows, {
		authUsername,
		authEmail,
		swimmerId,
		email,
		fullName,
		firstName: splitName.firstName,
		lastName: splitName.lastName,
		strictAccountBinding: true,
	});

	if (swimmerIndex < 0) {
		swimmersRows.push({
			id: swimmerId || `swimmer-${Date.now().toString(36)}`,
			firstName: splitName.firstName,
			lastName: splitName.lastName,
			name: fullName,
			email,
			swimmerAccountUsername: authUsername,
			swimmerAccountEmail: authEmail || email,
		});
		swimmerIndex = swimmersRows.length - 1;
	}

	const existingRow = swimmersRows[swimmerIndex] && typeof swimmersRows[swimmerIndex] === 'object'
		? swimmersRows[swimmerIndex]
		: {};
	const previousCoachLinkStatus = String(existingRow?.coachLinkStatus || 'none').trim() || 'none';
	const previousCoachConnected = Boolean(existingRow?.coachConnected);

	swimmersRows[swimmerIndex] = {
		...existingRow,
		id: String(existingRow?.id || swimmerId || `swimmer-${Date.now().toString(36)}`),
		firstName: splitName.firstName || String(existingRow?.firstName || ''),
		lastName: splitName.lastName || String(existingRow?.lastName || ''),
		name: fullName || String(existingRow?.name || ''),
		email: email || String(existingRow?.email || ''),
		dob: sanitizedSync.payload.dob || String(existingRow?.dob || ''),
		sex: sanitizedSync.payload.sex || String(existingRow?.sex || ''),
		gender: sanitizedSync.payload.gender || String(existingRow?.gender || ''),
		mainEvent: sanitizedSync.payload.mainEvent || String(existingRow?.mainEvent || ''),
		club: sanitizedSync.payload.club || String(existingRow?.club || ''),
		squad: sanitizedSync.payload.squad || String(existingRow?.squad || ''),
		pathway: sanitizedSync.payload.pathway,
		coachConnected: sanitizedSync.payload.coachConnected,
		coachLinkStatus: sanitizedSync.payload.coachLinkStatus,
		coachEmail: sanitizedSync.payload.coachEmail || String(existingRow?.coachEmail || ''),
		coachCode: sanitizedSync.payload.coachCode || String(existingRow?.coachCode || ''),
		coachPhase: sanitizedSync.payload.coachPhase || String(existingRow?.coachPhase || ''),
		coachRequestAt: sanitizedSync.payload.coachRequestAt || String(existingRow?.coachRequestAt || ''),
		coachReplyAt: sanitizedSync.payload.coachReplyAt || String(existingRow?.coachReplyAt || ''),
		coachApprovalAt: sanitizedSync.payload.coachApprovalAt || String(existingRow?.coachApprovalAt || ''),
		shareMode: sanitizedSync.payload.shareMode || String(existingRow?.shareMode || ''),
		parent1: sanitizedSync.payload.parent1 || String(existingRow?.parent1 || ''),
		parent2: sanitizedSync.payload.parent2 || String(existingRow?.parent2 || ''),
		parent1Consent: sanitizedSync.payload.parent1Consent === true,
		parent2Consent: sanitizedSync.payload.parent2Consent === true,
		snapshots,
		history,
		pbRows,
		pbSelectedSnapshotIds,
		targetPreference,
		targetHistory,
		customTestSets,
		ispProfile: ispProfile || existingRow?.ispProfile || null,
		swimmerAccountUsername: authUsername,
		swimmerAccountEmail: authEmail || email,
	};

	nextDb.swimmers = swimmersRows;

	try {
		writeAtomicJsonFile(storagePaths.dbPath, nextDb);
		writeDbSnapshotIfPossible(storagePaths.dbPath, storagePaths.snapshotDir);
		appendAuthAuditEvent({
			action: 'swimmer_profile_sync_saved',
			req,
			status: 'success',
			target: String(swimmersRows[swimmerIndex]?.id || ''),
			details: {
				pathway: sanitizedSync.payload.pathway,
				coachLinkStatusBefore: previousCoachLinkStatus,
				coachLinkStatusAfter: sanitizedSync.payload.coachLinkStatus,
				coachConnectedBefore: previousCoachConnected,
				coachConnectedAfter: sanitizedSync.payload.coachConnected,
				snapshotsCount: snapshots.length,
				historyDaysCount: history.length,
				pbRowsCount: pbRows.length,
			},
		});
		res.status(200).json({
			ok: true,
			swimmerId: String(swimmersRows[swimmerIndex]?.id || ''),
		});
	} catch (error) {
		appendAuthAuditEvent({
			action: 'swimmer_profile_sync_failed',
			req,
			status: 'error',
			target: String(swimmersRows[swimmerIndex]?.id || ''),
			reason: 'write_failed',
			details: {
				message: error instanceof Error ? error.message : 'Unknown error',
			},
		});
		res.status(500).json({
			error: 'Could not sync swimmer profile data.',
			details: error instanceof Error ? error.message : 'Unknown error',
		});
	}
});

app.post('/swimmer/coach/disconnect', requireStrictAuth, requireSwimmerRole, (req, res) => {
	const swimmerPayload = req.body && req.body.swimmer && typeof req.body.swimmer === 'object' ? req.body.swimmer : {};
	const fullName = String(swimmerPayload?.name || swimmerPayload?.fullName || '').trim() || String(findAuthUser(String(req.auth?.username || '').trim())?.fullName || '').trim();
	const splitName = splitFullName(fullName);
	const email = String(swimmerPayload?.email || '').trim() || String(findAuthUser(String(req.auth?.username || '').trim())?.email || '').trim();
	const authUsername = String(req.auth?.username || '').trim();
	const authEmail = String(findAuthUser(authUsername)?.email || '').trim();
	const swimmerId = String(swimmerPayload?.id || '').trim();

	const storagePaths = resolveStoragePathsForAuth(req.auth);
	ensureStorageLayout(storagePaths);
	const dbShape = readJsonFile(storagePaths.dbPath);
	const nextDb = dbShape && typeof dbShape === 'object' ? { ...dbShape } : {};
	const swimmersRows = Array.isArray(nextDb.swimmers) ? nextDb.swimmers.slice() : [];

	const swimmerIndex = resolveSwimmerRowIndex(swimmersRows, {
		authUsername,
		authEmail,
		swimmerId,
		email,
		fullName,
		firstName: splitName.firstName,
		lastName: splitName.lastName,
		strictAccountBinding: true,
	});

	if (swimmerIndex < 0) {
		appendAuthAuditEvent({
			action: 'swimmer_coach_disconnect_failed',
			req,
			status: 'error',
			reason: 'swimmer_not_found',
			details: {
				authUsername,
				swimmerId,
			},
		});
		res.status(404).json({
			error: 'Could not match swimmer record for disconnect action.',
		});
		return;
	}

	const existingRow = swimmersRows[swimmerIndex] && typeof swimmersRows[swimmerIndex] === 'object'
		? swimmersRows[swimmerIndex]
		: {};
	const existingHistory = normalizeTargetHistoryRows(existingRow?.targetHistory);
	const disconnectedAt = new Date().toISOString();
	const disconnectedHistory = [
		{
			id: `target-history-disconnect-${Date.now().toString(36)}`,
			at: disconnectedAt,
			action: 'Coach connection disconnected by swimmer',
			mode: 'independent',
			status: 'none',
			event: '',
			date: '',
			notes: 'Swimmer ended coach data-sharing connection.',
		},
		...existingHistory,
	].slice(0, 240);

	const existingPreference = normalizeTargetPreference(existingRow?.targetPreference);

	swimmersRows[swimmerIndex] = {
		...existingRow,
		coachConnected: false,
		coachLinkStatus: 'none',
		coachConnectionStatus: {
			state: 'disconnected-by-swimmer',
			disconnectedAt,
			disconnectedBy: String(req.auth?.username || '').trim(),
		},
		targetPreference: {
			...existingPreference,
			mode: 'independent',
			status: existingPreference.ignored ? 'ignored-by-swimmer' : 'none',
			updatedAt: disconnectedAt,
		},
		targetHistory: disconnectedHistory,
		targetHistoryUpdatedAt: disconnectedAt,
	};

	nextDb.swimmers = swimmersRows;

	try {
		writeAtomicJsonFile(storagePaths.dbPath, nextDb);
		writeDbSnapshotIfPossible(storagePaths.dbPath, storagePaths.snapshotDir);
		appendAuthAuditEvent({
			action: 'swimmer_coach_disconnected',
			req,
			status: 'success',
			target: String(swimmersRows[swimmerIndex]?.id || ''),
			details: {
				disconnectedAt,
				previousCoachLinkStatus: String(existingRow?.coachLinkStatus || 'none').trim() || 'none',
				previousCoachConnected: Boolean(existingRow?.coachConnected),
			},
		});
		res.status(200).json({
			ok: true,
			swimmerId: String(swimmersRows[swimmerIndex]?.id || ''),
			disconnectedAt,
		});
	} catch (error) {
		appendAuthAuditEvent({
			action: 'swimmer_coach_disconnect_failed',
			req,
			status: 'error',
			target: String(swimmersRows[swimmerIndex]?.id || ''),
			reason: 'write_failed',
			details: {
				message: error instanceof Error ? error.message : 'Unknown error',
			},
		});
		res.status(500).json({
			error: 'Could not disconnect coach connection.',
			details: error instanceof Error ? error.message : 'Unknown error',
		});
	}
});

// Serve db.json at /db
app.get('/db', requireAuth, (req, res) => {
	const storagePaths = resolveStoragePathsForAuth(req.auth);
	ensureStorageLayout(storagePaths);
	if (!fs.existsSync(storagePaths.dbPath) && storagePaths.dbPath !== DB_PATH) {
		writeAtomicJsonFile(storagePaths.dbPath, {});
	}
	fs.readFile(storagePaths.dbPath, 'utf8', (err, data) => {
		if (err) {
			res.status(500).json({ error: 'Could not read db.json', tenant: storagePaths.tenantKey });
		} else {
			let responsePayload = data;
			const role = String(req.auth?.role || '').trim().toLowerCase();
			if (role === 'swimmer') {
				const authUsername = String(req.auth?.username || '').trim().toLowerCase();
				const authUser = findAuthUser(String(req.auth?.username || '').trim()) || req.auth || {};
				const authEmail = String(authUser?.email || '').trim().toLowerCase();
				try {
					const parsed = JSON.parse(String(data || '{}'));
					const swimmers = Array.isArray(parsed?.swimmers) ? parsed.swimmers : [];
					let scopedSwimmers = swimmers.filter((row) => {
						const rowUsername = String(row?.swimmerAccountUsername || '').trim().toLowerCase();
						const rowAccountEmail = String(row?.swimmerAccountEmail || '').trim().toLowerCase();
						const rowEmail = String(row?.email || '').trim().toLowerCase();
						if (authUsername && rowUsername === authUsername) return true;
						if (authEmail && (rowAccountEmail === authEmail || rowEmail === authEmail)) return true;
						return false;
					});
					if (scopedSwimmers.length < 1 && AUTH_AUTO_HEAL_SWIMMER_BINDINGS) {
						try {
							const healResult = ensureSwimmerAccountBindingInStorage(authUser);
							if (healResult?.updated) {
								const refreshed = readJsonFile(storagePaths.dbPath);
								const refreshedSwimmers = Array.isArray(refreshed?.swimmers) ? refreshed.swimmers : [];
								scopedSwimmers = refreshedSwimmers.filter((row) => {
									const rowUsername = String(row?.swimmerAccountUsername || '').trim().toLowerCase();
									const rowAccountEmail = String(row?.swimmerAccountEmail || '').trim().toLowerCase();
									const rowEmail = String(row?.email || '').trim().toLowerCase();
									if (authUsername && rowUsername === authUsername) return true;
									if (authEmail && (rowAccountEmail === authEmail || rowEmail === authEmail)) return true;
									return false;
								});
							}
						} catch {
							// Ignore auto-heal read-path failures and return empty scoped payload.
						}
					}
					responsePayload = JSON.stringify({ swimmers: scopedSwimmers });
				} catch {
					responsePayload = JSON.stringify({ swimmers: [] });
				}
			}
			res.setHeader('Content-Type', 'application/json');
			res.send(responsePayload);
		}
	});
});

app.get('/db/ownership-summary', requireAuth, (req, res) => {
	try {
		const storagePaths = resolveStoragePathsForAuth(req.auth);
		ensureStorageLayout(storagePaths);
		const dbShape = readJsonFile(storagePaths.dbPath);
		const summary = buildOwnershipSummary(dbShape);
		res.status(200).json({
			ok: true,
			tenant: storagePaths.tenantKey,
			summary,
		});
	} catch (error) {
		res.status(500).json({
			error: 'Could not build ownership summary.',
			details: error instanceof Error ? error.message : 'Unknown error',
		});
	}
});

app.post('/db/ownership-backfill', requireAuth, requireWriteRole, requireBillingWriteAccess, (req, res) => {
	const storagePaths = resolveStoragePathsForAuth(req.auth);
	ensureStorageLayout(storagePaths);

	enqueueWrite(async () => {
		const actorUsername = String(req.auth?.username || '').trim().toLowerCase() || 'unknown-actor';
		const actorTenantId = String(resolveAuthTenantId(req.auth) || '').trim().toLowerCase();
		const nowIsoValue = new Date().toISOString();
		const currentDb = readJsonFile(storagePaths.dbPath);
		const nextDb = currentDb && typeof currentDb === 'object' ? { ...currentDb } : {};

		let rowsBackfilled = 0;
		const collections = [];

		for (const key of OWNERSHIP_TRACKED_COLLECTION_KEYS) {
			const rows = Array.isArray(nextDb?.[key]) ? nextDb[key] : null;
			if (!rows) continue;
			let collectionRowsBackfilled = 0;
			nextDb[key] = rows.map((row) => {
				if (!row || typeof row !== 'object' || Array.isArray(row)) return row;
				const createdByUserId = String(row?.createdByUserId || '').trim().toLowerCase();
				if (createdByUserId && createdByUserId !== 'legacy-unattributed') return row;
				collectionRowsBackfilled += 1;
				rowsBackfilled += 1;
				return {
					...row,
					createdByUserId: actorUsername,
					createdAt: String(row?.createdAt || nowIsoValue).trim() || nowIsoValue,
					updatedByUserId: actorUsername,
					updatedAt: nowIsoValue,
					tenantId: actorTenantId,
					attributionStatus: 'attributed-backfilled',
				};
			});
			if (collectionRowsBackfilled > 0) {
				collections.push({ key, rowsBackfilled: collectionRowsBackfilled });
			}
		}

		nextDb.__meta = {
			...(nextDb?.__meta && typeof nextDb.__meta === 'object' ? nextDb.__meta : {}),
			ownershipVersion: 'v1',
			ownershipUpdatedAt: nowIsoValue,
			ownershipUpdatedBy: actorUsername,
			ownershipBackfilledAt: nowIsoValue,
			ownershipBackfilledBy: actorUsername,
		};

		writeDbSnapshotIfPossible(storagePaths.dbPath, storagePaths.snapshotDir);
		writeAtomicJsonFile(storagePaths.dbPath, nextDb);

		return {
			rowsBackfilled,
			collections,
		};
	})
		.then((result) => {
			res.status(200).json({
				ok: true,
				tenant: storagePaths.tenantKey,
				rowsBackfilled: result.rowsBackfilled,
				collections: result.collections,
			});
		})
		.catch((error) => {
			res.status(500).json({
				error: 'Could not backfill ownership metadata.',
				details: error instanceof Error ? error.message : 'Unknown error',
			});
		});
});

app.put('/db', requireAuth, requireWriteRole, requireBillingWriteAccess, (req, res) => {
	const body = req.body;
	if (!body || typeof body !== 'object' || Array.isArray(body)) {
		res.status(400).json({ error: 'Invalid payload. Expected JSON object.' });
		return;
	}
	const actorTenantId = String(resolveAuthTenantId(req.auth) || '').trim().toLowerCase();
	const foreignTenantViolations = collectForeignTenantRowViolations(body, actorTenantId);
	if (foreignTenantViolations.length > 0) {
		appendAuthAuditEvent({
			action: 'unauthorized_access_blocked',
			req,
			status: 'blocked',
			reason: 'cross_tenant_payload_rows',
			details: {
				tenantId: actorTenantId,
				violations: foreignTenantViolations,
			},
		});
		res.status(403).json({
			error: 'Payload contains rows assigned to a different tenant.',
			tenantId: actorTenantId,
			violations: foreignTenantViolations,
		});
		return;
	}
	const storagePaths = resolveStoragePathsForAuth(req.auth);
	ensureStorageLayout(storagePaths);

	const existingDb = readJsonFile(storagePaths.dbPath);
	const writeValidation = validateDbWritePayload({
		existingDb,
		incomingDb: body,
	});
	if (!writeValidation.ok) {
		appendAuthAuditEvent({
			action: 'db_write_validation_rejected',
			req,
			status: 'blocked',
			reason: 'invalid_training_session_payload',
			details: {
				invalidUndatedSessionIds: writeValidation.invalidUndatedSessionIds,
				invalidTrainingSessionSetIds: writeValidation.invalidTrainingSessionSetIds,
			},
		});
		res.status(400).json({
			error: 'Payload contains invalid training sessions or session-set links.',
			invalidUndatedSessionIds: writeValidation.invalidUndatedSessionIds,
			invalidTrainingSessionSetIds: writeValidation.invalidTrainingSessionSetIds,
		});
		return;
	}
	if (hasUnauthorizedDocumentsChange(existingDb, body, req.auth)) {
		appendAuthAuditEvent({
			action: 'unauthorized_access_blocked',
			req,
			status: 'blocked',
			reason: 'documents_owner_only',
			details: { path: '/db', method: 'PUT' },
		});
		res.status(403).json({ error: 'Documents can only be modified by the primary software-owner account.' });
		return;
	}

	enqueueWrite(async () => {
		ensureStorageLayout(storagePaths);
		writeDbSnapshotIfPossible(storagePaths.dbPath, storagePaths.snapshotDir);

		const currentDb = readJsonFile(storagePaths.dbPath);
		const currentUpdatedAtMs = getDbShapeUpdatedAtMs(currentDb);
		const incomingUpdatedAtMs = getDbShapeUpdatedAtMs(body);
		const isStaleWrite = Number.isFinite(currentUpdatedAtMs)
			&& Number.isFinite(incomingUpdatedAtMs)
			&& incomingUpdatedAtMs + 1000 < currentUpdatedAtMs;
		if (isStaleWrite) {
			return {
				recoveredTargets: 0,
				recoveredFixtureIds: 0,
				staleWriteIgnored: true,
			};
		}

		const backupPayload = readJsonFile(storagePaths.backupPath);
		const backupRows = Array.isArray(backupPayload?.rows) ? backupPayload.rows : [];
		const merged = mergePlannerTargets(body, backupRows);
		const safeBody = {
			...body,
			trainingPlannerWeeks: merged.nextWeeks,
		};
			const ownershipStampedBody = applyOwnershipMetadataToDbShape(safeBody, currentDb, req.auth);

			writeAtomicJsonFile(storagePaths.dbPath, ownershipStampedBody);

		const nextBackup = {
			savedAt: new Date().toISOString(),
				rows: extractPlannerTargetRows(ownershipStampedBody),
		};
		writeAtomicJsonFile(storagePaths.backupPath, nextBackup);

		return {
			recoveredTargets: merged.recoveredTargets,
			recoveredFixtureIds: merged.recoveredFixtureIds,
			staleWriteIgnored: false,
		};
	})
		.then((result) => {
			res.status(200).json({
				ok: true,
				recoveredTargets: result.recoveredTargets,
				recoveredFixtureIds: result.recoveredFixtureIds,
				staleWriteIgnored: result.staleWriteIgnored === true,
			});
		})
		.catch((error) => {
			res.status(500).json({
				error: 'Could not write db.json',
				details: error instanceof Error ? error.message : 'Unknown error',
			});
		});
});

const server = app.listen(PORT, () => {
	console.log(`Server running at http://localhost:${PORT}/db`);
	console.log(`Website placeholders feed at http://localhost:${PORT}/content/placeholders`);
	autoHealSwimmerBindingsAtStartup();
});

server.on('error', (error) => {
	console.error('Backend server failed to start:', error instanceof Error ? error.message : error);
	process.exit(1);
});

function shutdown(signal) {
	server.close(() => {
		console.log(`Backend server stopped (${signal})`);
		process.exit(0);
	});
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
