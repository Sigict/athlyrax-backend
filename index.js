/* global process, Buffer */
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import crypto from 'crypto';
import nodemailer from 'nodemailer';
import Stripe from 'stripe';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = Number.parseInt(process.env.PORT || '3001', 10) || 3001;
const DB_PATH = path.join(__dirname, 'storage', 'db.json');
const TARGET_BACKUP_PATH = path.join(__dirname, 'storage', 'trainingPlannerTargets.backup.json');
const DB_SNAPSHOT_DIR = path.join(__dirname, 'storage', 'db-snapshots');
const DB_TENANTS_DIR = path.join(__dirname, 'storage', 'tenants');
const BILLING_CATALOG_PATH = path.join(__dirname, 'storage', 'billing-catalog.json');
const AUTH_USERS_PATH = path.join(__dirname, 'storage', 'auth-users.json');
const AUTH_INVITES_PATH = path.join(__dirname, 'storage', 'auth-invites.json');
const AUTH_AUDIT_DIR = path.join(__dirname, 'storage', 'auth-audit');
const AUTH_AUDIT_ACTIVE_PATH = path.join(AUTH_AUDIT_DIR, 'events.jsonl');
const AUTH_AUDIT_BACKUP_DIR = path.join(AUTH_AUDIT_DIR, 'backups');
const MAX_DB_SNAPSHOTS = 15;
const AUTH_AUDIT_MAX_BYTES = Math.max(64 * 1024, Number.parseInt(process.env.AUTH_AUDIT_MAX_BYTES || `${2 * 1024 * 1024}`, 10) || (2 * 1024 * 1024));
const AUTH_AUDIT_MAX_ARCHIVE_FILES = Math.max(1, Number.parseInt(process.env.AUTH_AUDIT_MAX_ARCHIVE_FILES || '30', 10) || 30);
const AUTH_AUDIT_FETCH_MAX_ROWS = Math.max(50, Number.parseInt(process.env.AUTH_AUDIT_FETCH_MAX_ROWS || '1000', 10) || 1000);
const AUTH_AUDIT_MAX_BACKUP_FILES = Math.max(1, Number.parseInt(process.env.AUTH_AUDIT_MAX_BACKUP_FILES || '30', 10) || 30);
const AUTH_AUDIT_BACKUP_INTERVAL_MS = Math.max(60 * 1000, Number.parseInt(process.env.AUTH_AUDIT_BACKUP_INTERVAL_MS || `${12 * 60 * 60 * 1000}`, 10) || (12 * 60 * 60 * 1000));
const NODE_ENV = String(process.env.NODE_ENV || 'development').toLowerCase();
const IS_PRODUCTION = NODE_ENV === 'production';
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
const AUTH_PRIMARY_SOFTWARE_OWNER_USERNAME = String(process.env.AUTH_PRIMARY_SOFTWARE_OWNER_USERNAME || 'softwareowner').trim().toLowerCase();
const AUTH_INVITE_TTL_HOURS = Math.max(1, Number.parseInt(process.env.AUTH_INVITE_TTL_HOURS || '168', 10) || 168);
const AUTH_PASSWORD_RESET_TTL_MINUTES = Math.max(5, Number.parseInt(process.env.AUTH_PASSWORD_RESET_TTL_MINUTES || '20', 10) || 20);
const AUTH_PASSWORD_RESET_DELIVERY = String(process.env.AUTH_PASSWORD_RESET_DELIVERY || 'console').trim().toLowerCase();
const AUTH_PASSWORD_RESET_DEV_CODE_IN_RESPONSE = String(process.env.AUTH_PASSWORD_RESET_DEV_CODE_IN_RESPONSE || 'false').toLowerCase() === 'true';
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
const BILLING_TRIAL_DAYS = Math.max(0, Number.parseInt(process.env.BILLING_TRIAL_DAYS || '42', 10) || 0);
const BILLING_BASE_TRIAL_DAYS = Math.max(0, Number.parseInt(process.env.BILLING_BASE_TRIAL_DAYS || '28', 10) || 0);
const BILLING_REFERRAL_BONUS_DAYS = Math.max(0, Number.parseInt(process.env.BILLING_REFERRAL_BONUS_DAYS || '14', 10) || 0);
const BILLING_PARTNER_COMMISSION_PERCENT = Math.max(0, Number.parseInt(process.env.BILLING_PARTNER_COMMISSION_PERCENT || '10', 10) || 0);
const BILLING_PARTNER_COMMISSION_MONTHS = Math.max(0, Number.parseInt(process.env.BILLING_PARTNER_COMMISSION_MONTHS || '36', 10) || 0);
const PHASE1_TENANT_ISOLATION = String(process.env.PHASE1_TENANT_ISOLATION || 'true').toLowerCase() === 'true';
const DEFAULT_BILLING_CATALOG = {
	version: 1,
	currency: 'GBP',
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

const authBootstrap = loadOrCreateAuthUsers();
const authUsers = authBootstrap.users;
const authInvites = loadOrCreateAuthInvites();
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
		plans: plans.length > 0 ? plans : fallbackPlans,
		addons: addons.length > 0 ? addons : fallbackAddons,
	};
}

function loadOrCreateBillingCatalog() {
	const existing = readJsonFile(BILLING_CATALOG_PATH);
	const normalized = normalizeBillingCatalog(existing);
	ensureStorageLayout();
	writeAtomicJsonFile(BILLING_CATALOG_PATH, normalized);
	return normalized;
}

function persistBillingCatalog() {
	ensureStorageLayout();
	writeAtomicJsonFile(BILLING_CATALOG_PATH, billingCatalog);
}

function getBillingPlansCatalog() {
	return Array.isArray(billingCatalog?.plans) ? billingCatalog.plans : [];
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
	return {
		username: String(normalizedUser?.username || '').trim(),
		role: String(normalizedUser?.role || 'viewer').trim() || 'viewer',
		tenantId: String(normalizedUser?.tenantId || resolveTenantKeyFromUser(normalizedUser) || '').trim(),
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
	if (cleanedFromFile.length > 0) {
		if (cleanedFromFile.length !== fromFile.length) {
			writeJsonFile(AUTH_USERS_PATH, cleanedFromFile);
		}
		return { users: cleanedFromFile, source: 'file' };
	}

	const fromEnv = normalizeAuthUserRows(parseAuthUsersFromEnv());
	const cleanedFromEnv = sanitizeDemoUsers(fromEnv);
	if (cleanedFromEnv.length > 0) {
		writeJsonFile(AUTH_USERS_PATH, cleanedFromEnv);
		return { users: cleanedFromEnv, source: 'env' };
	}

	const fromDefaults = sanitizeDemoUsers(normalizeAuthUserRows(DEFAULT_AUTH_USERS));
	writeJsonFile(AUTH_USERS_PATH, fromDefaults);
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
}

function writeJsonFile(filePath, data) {
	try {
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
		fs.mkdirSync(snapshotDir, { recursive: true });
		fs.mkdirSync(DB_TENANTS_DIR, { recursive: true });
		fs.mkdirSync(AUTH_AUDIT_DIR, { recursive: true });
		fs.mkdirSync(AUTH_AUDIT_BACKUP_DIR, { recursive: true });
	} catch {
		// Ignore directory creation failures and let write paths report errors.
	}
}

function writeAtomicJsonFile(filePath, data) {
	const dir = path.dirname(filePath);
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
		const shouldRecoverTarget = !existingTargetKey;
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

	const username = String(req.body?.username || '').trim();
	const password = String(req.body?.password || '');
	const fullName = String(req.body?.fullName || '').trim();
	const email = String(req.body?.email || '').trim();
	const phone = String(req.body?.phone || '').trim();
	const swimClub = String(req.body?.swimClub || '').trim();
	const teamName = String(req.body?.teamName || '').trim();
	const city = String(req.body?.city || '').trim();
	const country = String(req.body?.country || '').trim();
	const inviteCode = String(req.body?.inviteCode || '').trim();
	if (!username || !password) {
		appendAuthAuditEvent({
			action: 'register_failed',
			req,
			status: 'error',
			target: username || 'unknown',
			reason: 'missing_credentials',
		});
		res.status(400).json({ error: 'Username and password are required.' });
		return;
	}

	if (!fullName || !email || !swimClub || !teamName) {
		appendAuthAuditEvent({
			action: 'register_failed',
			req,
			status: 'error',
			target: username || 'unknown',
			reason: 'missing_profile_fields',
		});
		res.status(400).json({ error: 'Full name, email, swim club, and team name are required.' });
		return;
	}

	if (!AUTH_EMAIL_PATTERN.test(email)) {
		appendAuthAuditEvent({
			action: 'register_failed',
			req,
			status: 'error',
			target: username,
			reason: 'invalid_email',
		});
		res.status(400).json({ error: 'Enter a valid email address.' });
		return;
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

	if (authUsers.some((row) => row.username === username)) {
		appendAuthAuditEvent({
			action: 'register_failed',
			req,
			status: 'error',
			target: username,
			reason: 'username_taken',
		});
		res.status(409).json({ error: 'Username already exists.' });
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

	const role = String(usableInvite?.role || 'assistant-coach').trim() || 'assistant-coach';
	const isApproved = Boolean(usableInvite) || AUTH_ALLOW_COACH_SIGNUP;
	const effectiveSwimClub = String(usableInvite?.swimClub || swimClub).trim();
	const effectiveTeamName = String(usableInvite?.teamName || teamName).trim();
	const tenantId = normalizeTenantId(usableInvite?.tenantId)
		|| resolveTenantKeyFromUser({ username, role, swimClub: effectiveSwimClub, teamName: effectiveTeamName });
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

	const user = authUsers.find((row) => row.username === username);
	if (!user || !verifyPassword(password, user.passwordHash)) {
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

app.get('/billing/config', requireStrictAuth, (req, res) => {
	const user = findAuthUser(String(req.auth?.username || '').trim()) || req.auth || {};
	const plans = getBillingPlansCatalog().map(serializeBillingPlanForResponse);
	const addons = Array.isArray(billingCatalog?.addons) ? billingCatalog.addons.map(serializeBillingAddonForResponse) : [];
	res.status(200).json({
		enabled: Boolean(stripeClient),
		enforced: Boolean(stripeClient) && BILLING_ENFORCED,
		trialDays: resolveTrialDaysForUser(user),
		currency: String(billingCatalog?.currency || 'GBP').toUpperCase(),
		plans,
		addons,
	});
});

app.get('/billing/catalog', requireStrictAuth, requireSoftwareOwnerRole, (_req, res) => {
	res.status(200).json({
		catalog: {
			version: Number(billingCatalog?.version || 1),
			currency: String(billingCatalog?.currency || 'GBP').toUpperCase(),
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

	billingCatalog = {
		version: Number(billingCatalog?.version || 1) + 1,
		currency: String(normalized?.currency || 'GBP').toUpperCase(),
		plans: normalized.plans,
		addons: Array.isArray(normalized?.addons) ? normalized.addons : [],
	};
	persistBillingCatalog();

	res.status(200).json({
		ok: true,
		catalog: {
			version: Number(billingCatalog?.version || 1),
			currency: String(billingCatalog?.currency || 'GBP').toUpperCase(),
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

	if (!fullName || !email || !swimClub || !teamName) {
		res.status(400).json({ error: 'Full name, email, swim club, and team name are required.' });
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

// Serve db.json at /db
app.get('/db', requireAuth, (req, res) => {
	const storagePaths = resolveStoragePathsForAuth(req.auth);
	ensureStorageLayout(storagePaths);
	if (!fs.existsSync(storagePaths.dbPath) && fs.existsSync(DB_PATH) && storagePaths.dbPath !== DB_PATH) {
		const globalSeed = readJsonFile(DB_PATH);
		if (globalSeed && typeof globalSeed === 'object') {
			writeAtomicJsonFile(storagePaths.dbPath, globalSeed);
		}
	}
	fs.readFile(storagePaths.dbPath, 'utf8', (err, data) => {
		if (err) {
			res.status(500).json({ error: 'Could not read db.json', tenant: storagePaths.tenantKey });
		} else {
			res.setHeader('Content-Type', 'application/json');
			res.send(data);
		}
	});
});

app.put('/db', requireAuth, requireWriteRole, requireBillingWriteAccess, (req, res) => {
	const body = req.body;
	if (!body || typeof body !== 'object' || Array.isArray(body)) {
		res.status(400).json({ error: 'Invalid payload. Expected JSON object.' });
		return;
	}
	const storagePaths = resolveStoragePathsForAuth(req.auth);
	ensureStorageLayout(storagePaths);

	const existingDb = readJsonFile(storagePaths.dbPath);
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

		const backupPayload = readJsonFile(storagePaths.backupPath);
		const backupRows = Array.isArray(backupPayload?.rows) ? backupPayload.rows : [];
		const merged = mergePlannerTargets(body, backupRows);
		const safeBody = {
			...body,
			trainingPlannerWeeks: merged.nextWeeks,
		};

		writeAtomicJsonFile(storagePaths.dbPath, safeBody);

		const nextBackup = {
			savedAt: new Date().toISOString(),
			rows: extractPlannerTargetRows(safeBody),
		};
		writeAtomicJsonFile(storagePaths.backupPath, nextBackup);

		return {
			recoveredTargets: merged.recoveredTargets,
			recoveredFixtureIds: merged.recoveredFixtureIds,
		};
	})
		.then((result) => {
			res.status(200).json({
				ok: true,
				recoveredTargets: result.recoveredTargets,
				recoveredFixtureIds: result.recoveredFixtureIds,
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
