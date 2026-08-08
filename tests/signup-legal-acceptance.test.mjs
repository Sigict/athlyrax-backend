import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import {
  REQUIRED_SIGNUP_LEGAL_VERSIONS,
  appendSignupLegalAcceptanceRecord,
  buildSignupLegalAcceptanceRecord,
  installSignupLegalAcceptanceGuard,
  validateSignupLegalAcceptance,
} from '../scripts/signup-legal-acceptance-preload.mjs';

function validBody() {
  return {
    username: 'coach.one',
    email: 'coach@example.test',
    swimClub: 'Example Club',
    teamName: 'Performance Squad',
    dpaAccepted: true,
    clubDataProtectionConfirmed: true,
    legalDocumentVersions: { ...REQUIRED_SIGNUP_LEGAL_VERSIONS },
  };
}

function withLegalEnv(values, run) {
  const keys = ['NODE_ENV', 'ATHLYRAX_STORAGE_ROOT', 'ATHLYRAX_SAFETY_BACKUP_ROOT', 'AUTH_LEGAL_ACCEPTANCE_PATH'];
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  try {
    for (const key of keys) delete process.env[key];
    for (const [key, value] of Object.entries(values || {})) {
      if (value !== undefined && value !== null) process.env[key] = String(value);
    }
    return run();
  } finally {
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
}

test('signup legal confirmation, club identity and current versions are mandatory', () => {
  assert.equal(validateSignupLegalAcceptance({}).ok, false);
  assert.equal(validateSignupLegalAcceptance({ ...validBody(), swimClub: '' }).ok, false);
  assert.equal(validateSignupLegalAcceptance({ ...validBody(), teamName: '' }).ok, false);
  assert.equal(validateSignupLegalAcceptance({ ...validBody(), dpaAccepted: false }).ok, false);
  assert.equal(validateSignupLegalAcceptance({
    ...validBody(),
    legalDocumentVersions: { ...REQUIRED_SIGNUP_LEGAL_VERSIONS, dataProcessingAgreement: 'old' },
  }).ok, false);
  assert.equal(validateSignupLegalAcceptance(validBody()).ok, true);
});

test('acceptance record contains account, tenant, versions and request evidence', () => {
  const record = buildSignupLegalAcceptanceRecord({
    req: {
      body: validBody(),
      headers: {
        'x-forwarded-for': '203.0.113.9, 10.0.0.1',
        'user-agent': 'AthlyraX Test Browser',
      },
    },
    responsePayload: {
      user: {
        username: 'coach.one',
        tenantId: 'example-club__performance-squad',
        role: 'head-coach',
      },
    },
    acceptedAt: '2026-08-06T12:00:00.000Z',
    stage: 'completed',
  });

  assert.equal(record.username, 'coach.one');
  assert.equal(record.tenantId, 'example-club__performance-squad');
  assert.equal(record.stage, 'completed');
  assert.equal(record.ipAddress, '203.0.113.9');
  assert.equal(record.userAgent, 'AthlyraX Test Browser');
  assert.deepEqual(record.documentVersions, REQUIRED_SIGNUP_LEGAL_VERSIONS);
});

test('noncanonical legal acceptance path is rejected', () => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'athlyrax-legal-path-'));
  try {
    withLegalEnv({
      NODE_ENV: 'development',
      ATHLYRAX_STORAGE_ROOT: temporaryRoot,
      AUTH_LEGAL_ACCEPTANCE_PATH: path.join(temporaryRoot, 'other', 'legal.jsonl'),
    }, () => {
      assert.throws(
        () => appendSignupLegalAcceptanceRecord({ eventId: 'test' }),
        /AUTH_LEGAL_ACCEPTANCE_PATH must equal the canonical path/,
      );
      assert.equal(fs.existsSync(path.join(temporaryRoot, 'other', 'legal.jsonl')), false);
    });
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test('production legal acceptance is durably mirrored to the independent safety journal', () => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'athlyrax-legal-dual-'));
  const storageRoot = path.join(temporaryRoot, 'storage');
  const safetyRoot = path.join(temporaryRoot, 'safety');
  try {
    withLegalEnv({ NODE_ENV: 'production', ATHLYRAX_STORAGE_ROOT: storageRoot, ATHLYRAX_SAFETY_BACKUP_ROOT: safetyRoot }, () => {
      const record = { eventId: 'legal_test_dual', stage: 'pre-registration', acceptedAt: '2026-08-08T00:00:00.000Z' };
      appendSignupLegalAcceptanceRecord(record);
      const primary = fs.readFileSync(path.join(storageRoot, 'legal-acceptances.jsonl'), 'utf8');
      const safety = fs.readFileSync(path.join(safetyRoot, 'legal-acceptances', 'legal-acceptances.jsonl'), 'utf8');
      assert.equal(primary, safety);
      assert.match(primary, /legal_test_dual/);
    });
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test('production legal acceptance fails closed without a safety backup root', () => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'athlyrax-legal-no-safety-'));
  try {
    withLegalEnv({ NODE_ENV: 'production', ATHLYRAX_STORAGE_ROOT: temporaryRoot }, () => {
      assert.throws(
        () => appendSignupLegalAcceptanceRecord({ eventId: 'must-not-write' }),
        /ATHLYRAX_SAFETY_BACKUP_ROOT is required/,
      );
      assert.equal(fs.existsSync(path.join(temporaryRoot, 'legal-acceptances.jsonl')), false);
    });
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test('register route persists acceptance before handler and records completion after success', async () => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'athlyrax-legal-'));
  try {
    await withLegalEnv({ NODE_ENV: 'development', ATHLYRAX_STORAGE_ROOT: temporaryRoot }, async () => {
      const application = {
        registration: null,
        post(routePath, ...handlers) {
          this.registration = { routePath, handlers };
          return this;
        },
      };
      installSignupLegalAcceptanceGuard({ application });
      application.post('/auth/register', (req, res) => {
        const acceptancePath = path.join(temporaryRoot, 'legal-acceptances.jsonl');
        assert.equal(fs.existsSync(acceptancePath), true, 'legal acceptance must exist before account handler executes');
        const preRows = fs.readFileSync(acceptancePath, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
        assert.equal(preRows.length, 1);
        assert.equal(preRows[0].stage, 'pre-registration');
        res.status(201).json({
          user: {
            username: req.body.username,
            email: req.body.email,
            tenantId: 'example-club__performance-squad',
            swimClub: req.body.swimClub,
            teamName: req.body.teamName,
            role: 'head-coach',
          },
        });
      });

      assert.equal(application.registration.routePath, '/auth/register');
      assert.equal(application.registration.handlers.length, 2);
      const [guard, handler] = application.registration.handlers;

      class Response extends EventEmitter {
        constructor() {
          super();
          this.statusCode = 200;
          this.payload = null;
        }
        status(value) {
          this.statusCode = value;
          return this;
        }
        json(payload) {
          this.payload = payload;
          queueMicrotask(() => this.emit('finish'));
          return this;
        }
      }

      const rejected = new Response();
      guard({ body: {}, headers: {} }, rejected, () => assert.fail('Rejected signup must not continue.'));
      assert.equal(rejected.statusCode, 400);

      const accepted = new Response();
      const request = {
        body: validBody(),
        headers: { 'user-agent': 'Test Browser' },
        ip: '127.0.0.1',
      };
      await new Promise((resolve, reject) => {
        accepted.once('finish', resolve);
        try {
          guard(request, accepted, () => handler(request, accepted));
        } catch (error) {
          reject(error);
        }
      });
      await new Promise((resolve) => setImmediate(resolve));

      assert.equal(accepted.statusCode, 201);
      const acceptancePath = path.join(temporaryRoot, 'legal-acceptances.jsonl');
      const rows = fs.readFileSync(acceptancePath, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
      assert.equal(rows.length, 2);
      assert.equal(rows[0].stage, 'pre-registration');
      assert.equal(rows[1].stage, 'completed');
      assert.equal(rows[1].username, 'coach.one');
      assert.equal(rows[1].tenantId, 'example-club__performance-squad');
      assert.equal(rows[1].confirmations.authorisedClubRepresentativeAndDpa, true);
    });
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test('register route fails before handler if legal acceptance cannot be persisted', () => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'athlyrax-legal-fail-'));
  try {
    withLegalEnv({
      NODE_ENV: 'development',
      ATHLYRAX_STORAGE_ROOT: temporaryRoot,
      AUTH_LEGAL_ACCEPTANCE_PATH: path.join(temporaryRoot, 'wrong', 'legal.jsonl'),
    }, () => {
      const application = {
        registration: null,
        post(routePath, ...handlers) { this.registration = { routePath, handlers }; return this; },
      };
      installSignupLegalAcceptanceGuard({ application });
      application.post('/auth/register', () => assert.fail('Registration handler must not run when legal persistence fails.'));
      const [guard] = application.registration.handlers;
      const response = {
        statusCode: 200,
        payload: null,
        status(value) { this.statusCode = value; return this; },
        json(payload) { this.payload = payload; return this; },
        once() {},
      };
      guard({ body: validBody(), headers: {} }, response, () => assert.fail('Guard must not continue.'));
      assert.equal(response.statusCode, 503);
    });
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
});
