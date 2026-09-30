import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { installFeedbackRoutes } from '../feedback-routes.mjs';

test('feedback persists before Outlook email, coach sees no inbox, owner can triage; failed SMTP never loses saved message', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'athlyrax-feedback-contract-'));
  try {
    const dbPath = path.join(root, 'tenants', 'demo-company', 'db.json');
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    fs.writeFileSync(dbPath, '{"__meta":{"tenantId":"demo-company"}}');
    const routes = new Map();
    const app = {};
    for (const verb of ['post','get','patch']) app[verb] = (route, ...handlers) => routes.set(verb.toUpperCase() + ' ' + route, handlers.at(-1));
    let sendFailure = false;
    const delivered = [];
    const middleware = (_req, _res, next) => next?.();
    installFeedbackRoutes(app, {
      requireStrictAuth: middleware, requireSoftwareOwnerRole: middleware, requireAdminRateLimit: middleware,
      resolveStoragePathsForAuth: (auth) => auth.role === 'software-owner'
        ? { dbPath: path.join(root, 'db.json'), tenantKey: 'global-owner' } : { dbPath, tenantKey: 'demo-company' },
      isPrimarySoftwareOwnerAccount: (auth) => auth.role === 'software-owner' && auth.username === 'softwareowner',
      enqueueWrite: (task) => Promise.resolve().then(task),
      writeAtomicJsonFile: (filePath, payload) => {
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath + '.tmp', JSON.stringify(payload));
        fs.renameSync(filePath + '.tmp', filePath);
      },
      getAuthResetMailTransport: () => ({ sendMail: async (message) => {
        if (sendFailure) { const error = new Error('Simulated failure'); error.code = 'SMTP_TEST_FAILURE'; throw error; }
        delivered.push(message);
      } }),
      storageRoot: root, smtpHost: 'smtp.example.invalid', smtpFrom: 'AthlyraX <notifier@example.invalid>',
      validEmail: /^[^\s@]+@[^\s@]+\.[^\s@]+$/, feedbackRecipient: 'AthlyraX@outlook.com',
    });
    const coach = { username: 'demo.coach', role: 'head-coach' };
    const owner = { username: 'softwareowner', role: 'software-owner' };
    const invoke = (verb, route, req) => new Promise((resolve, reject) => {
      const handler = routes.get(verb + ' ' + route);
      assert.ok(handler, 'Route registered: ' + verb + ' ' + route);
      const res = {
        statusCode: 200, status(value) { this.statusCode = value; return this; },
        json(body) { resolve({ status: this.statusCode, body }); return this; },
      };
      try { handler(req, res); } catch (error) { reject(error); }
    });
    const saved = await invoke('POST', '/feedback', { auth: coach,
      body: { topic: 'Planning issue', description: 'The session filter should stay selected.' } });
    assert.equal(saved.status, 201);
    assert.equal(saved.body.notification, 'sent');
    assert.equal(delivered.length, 1);
    assert.equal(delivered[0].to, 'AthlyraX@outlook.com');
    assert.match(delivered[0].text, /demo.coach/);
    assert.match(delivered[0].text, /session filter should stay selected/);
    const tenantFeedbackPath = path.join(path.dirname(dbPath), 'feedback-messages.json');
    const stored = JSON.parse(fs.readFileSync(tenantFeedbackPath, 'utf8'));
    assert.equal(stored.length, 1);
    assert.equal(stored[0].id, saved.body.row.id);
    const coachInbox = await invoke('GET', '/feedback', { auth: coach });
    assert.equal(coachInbox.status, 200);
    assert.deepEqual(coachInbox.body.rows, []);
    assert.equal(coachInbox.body.inboxAccess, 'owner-only');
    const ownerInbox = await invoke('GET', '/feedback', { auth: owner });
    assert.equal(ownerInbox.status, 200);
    assert.equal(ownerInbox.body.rows.length, 1);
    const triaged = await invoke('PATCH', '/feedback/:id/decision', { auth: owner,
      params: { id: saved.body.row.id }, body: { decision: 'fix' } });
    assert.equal(triaged.body.row.status, 'fix-queued');
    assert.equal(JSON.parse(fs.readFileSync(tenantFeedbackPath, 'utf8'))[0].status, 'fix-queued');
    sendFailure = true;
    const savedWithoutEmail = await invoke('POST', '/feedback', { auth: coach,
      body: { topic: 'Second suggestion', description: 'Keep saved even when SMTP fails.' } });
    assert.equal(savedWithoutEmail.status, 201);
    assert.equal(savedWithoutEmail.body.notification, 'failed');
    assert.equal(JSON.parse(fs.readFileSync(tenantFeedbackPath, 'utf8')).length, 2);
    assert.equal((await invoke('GET','/feedback',{auth:owner})).body.rows.length,2);
    const missingDb = path.join(root, 'tenants','deleted-account','db.json');
    const badScopeRoutes = new Map();
    const badApp = {post:(route,...parts)=>badScopeRoutes.set(route,parts.at(-1)),get:()=>{},patch:()=>{}};
    installFeedbackRoutes(badApp,{requireStrictAuth:middleware,requireSoftwareOwnerRole:middleware,requireAdminRateLimit:middleware,
      resolveStoragePathsForAuth:()=>({dbPath:missingDb,tenantKey:'deleted-account'}),
      isPrimarySoftwareOwnerAccount:()=>false, enqueueWrite:(fn)=>Promise.resolve().then(fn),
      writeAtomicJsonFile:()=>{},getAuthResetMailTransport:()=>({}),
      storageRoot:root,smtpHost:'',smtpFrom:'',validEmail:/@/,feedbackRecipient:'AthlyraX@outlook.com'});
    const missing = await new Promise((resolve) => badScopeRoutes.get('/feedback')({
      auth:coach, body:{topic:'test',description:'test'}},
      {status(code){this.code=code;return this;},json(payload){resolve({code:this.code,payload});return this;}}));
    assert.equal(missing.code,503);
    assert.equal(fs.existsSync(path.dirname(missingDb)),false,'No shadow tenant created');
  } finally { fs.rmSync(root,{recursive:true,force:true}); }
});
