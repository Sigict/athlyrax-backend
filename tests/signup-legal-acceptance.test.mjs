import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import {
  REQUIRED_SIGNUP_LEGAL_VERSIONS,
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

test('signup legal confirmation is mandatory and version locked', () => {
  assert.equal(validateSignupLegalAcceptance({}).ok, false);
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
  });

  assert.equal(record.username, 'coach.one');
  assert.equal(record.tenantId, 'example-club__performance-squad');
  assert.equal(record.ipAddress, '203.0.113.9');
  assert.equal(record.userAgent, 'AthlyraX Test Browser');
  assert.deepEqual(record.documentVersions, REQUIRED_SIGNUP_LEGAL_VERSIONS);
});

test('register route rejects missing confirmations and records successful acceptance', async () => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'athlyrax-legal-'));
  const previousRoot = process.env.ATHLYRAX_STORAGE_ROOT;
  process.env.ATHLYRAX_STORAGE_ROOT = temporaryRoot;

  try {
    const application = {
      registration: null,
      post(routePath, ...handlers) {
        this.registration = { routePath, handlers };
        return this;
      },
    };
    installSignupLegalAcceptanceGuard({ application });
    application.post('/auth/register', (req, res) => {
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

    assert.equal(accepted.statusCode, 201);
    const acceptancePath = path.join(temporaryRoot, 'legal-acceptances.jsonl');
    assert.equal(fs.existsSync(acceptancePath), true);
    const rows = fs.readFileSync(acceptancePath, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    assert.equal(rows.length, 1);
    assert.equal(rows[0].username, 'coach.one');
    assert.equal(rows[0].tenantId, 'example-club__performance-squad');
    assert.equal(rows[0].confirmations.authorisedClubRepresentativeAndDpa, true);
  } finally {
    if (previousRoot === undefined) delete process.env.ATHLYRAX_STORAGE_ROOT;
    else process.env.ATHLYRAX_STORAGE_ROOT = previousRoot;
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
});
