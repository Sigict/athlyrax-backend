import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { registerFeedbackRoutes } from '../feedback-routes.mjs';

const runRoute = async (app, method, route, req) => {
  const handlers = app.routes.get(method + ' ' + route);
  assert.ok(handlers, 'missing ' + method + ' ' + route);
  let status = 200;
  let response;
  const res = {
    status(code) { status = code; return this; },
    json(value) { response = value; return this; },
  };
  const wait = () => new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      if (response !== undefined) return resolve({ status, body: response });
      if (Date.now() - started > 1200) return reject(new Error('Route response timed out'));
      setTimeout(tick, 2);
    };
    tick();
  });
  const middleware = handlers.slice(0, -1);
  for (const entry of middleware) entry(req, res, () => {});
  handlers.at(-1)(req, res);
  return wait();
};
const fixture = ({ mailFails = false, smtpHost = 'smtp.test' } = {}) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'athlyrax-feedback-contract-'));
  const app = { routes: new Map() };
  for (const method of ['post','get','patch']) app[method] = (route, ...handlers) => app.routes.set(method+' '+route, handlers);
  const sent = [];
  const write = (p,v) => {
    fs.mkdirSync(path.dirname(p), { recursive:true });
    const tmp = p + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(v));
    fs.renameSync(tmp,p);
  };
  const read = (p) => fs.existsSync(p) ? JSON.parse(fs.readFileSync(p,'utf8')) : null;
  registerFeedbackRoutes({
    app,
    requireStrictAuth: (_req,_res,next) => next(),
    requireAdminRateLimit: (_req,_res,next) => next(),
    isPrimarySoftwareOwnerAccount: (auth) => auth?.role === 'software-owner' && auth?.username === 'softwareowner',
    resolveStoragePathsForAuth: (auth) => auth?.username === 'softwareowner'
      ? { tenantKey:'global-owner', dbPath:path.join(root,'db.json') }
      : { tenantKey:auth?.tenantId || 'demo-company', dbPath:path.join(root,'tenants',auth?.tenantId || 'demo-company','db.json') },
    readJsonFile:read, writeAtomicJsonFile:write, enqueueWrite:async (fn) => fn(), appendAuthAuditEvent:() => {},
    storageRoot:root, smtpHost, smtpFrom:'no-reply@athlyrax.com', notifyTo:'AthlyraX@outlook.com',
    getMailTransport: () => ({ async sendMail(mail) { sent.push(mail); if(mailFails) throw Error('SMTP unreachable'); } }),
  });
  return { app, root, sent, read };
};
const coach = { auth:{username:'demo.coach',role:'head-coach',tenantId:'demo-company'} };
const other = { auth:{username:'other.coach',role:'head-coach',tenantId:'other-club'} };
const owner = { auth:{username:'softwareowner',role:'software-owner'} };

test('coach submission is durably saved before email; non-owner inbox never leaks rows', async (t) => {
  const f = fixture();t.after(()=>fs.rmSync(f.root,{recursive:true,force:true}));
  const saved = await runRoute(f.app,'post','/feedback',{...coach,body:{topic:'Poolside suggestion',description:'Track stroke length per swimmer'}});
  assert.equal(saved.status,201);assert.equal(saved.body.ok,true);assert.equal(saved.body.emailNotification,'sent');
  assert.equal(f.sent.length,1);assert.equal(f.sent[0].to,'AthlyraX@outlook.com');
  assert.ok(f.sent[0].text.includes('demo.coach'));
  const file = path.join(f.root,'tenants','demo-company','feedback-messages.json');
  assert.equal(f.read(file)[0].topic,'Poolside suggestion');
  for (const actor of [coach,other]) {
    const hidden=await runRoute(f.app,'get','/feedback',actor);
    assert.deepEqual(hidden.body,{ok:true,rows:[],ownerOnly:true});
  }
  const shown=await runRoute(f.app,'get','/feedback',owner);
  assert.equal(shown.body.rows.length,1);assert.equal(shown.body.rows[0].createdBy,'demo.coach');
});

test('SMTP failure cannot roll back a committed message; owner can triage cross-tenant', async (t) => {
  const f=fixture({mailFails:true});t.after(()=>fs.rmSync(f.root,{recursive:true,force:true}));
  const submitted=await runRoute(f.app,'post','/feedback',{...coach,body:{topic:'Broken popup',description:'Cannot scroll'}});
  assert.equal(submitted.status,201);assert.equal(submitted.body.emailNotification,'failed');
  const notAllowed=await runRoute(f.app,'patch','/feedback/:id/decision',{...coach,params:{id:submitted.body.row.id},body:{decision:'archive'}});
  assert.equal(notAllowed.status,403);
  const archived=await runRoute(f.app,'patch','/feedback/:id/decision',{...owner,params:{id:submitted.body.row.id},body:{decision:'archive'}});
  assert.equal(archived.status,200);assert.equal(archived.body.row.status,'archived');
  const inbox=await runRoute(f.app,'get','/feedback',owner);
  assert.equal(inbox.body.rows[0].status,'archived');
});

test('input validation and missing SMTP do not fabricate delivery', async (t) => {
  const f=fixture({smtpHost:''});t.after(()=>fs.rmSync(f.root,{recursive:true,force:true}));
  const bad=await runRoute(f.app,'post','/feedback',{...coach,body:{topic:'',description:'No subject'}});
  assert.equal(bad.status,400);
  const saved=await runRoute(f.app,'post','/feedback',{...coach,body:{topic:'Review',description:'Pilot testing'}});
  assert.equal(saved.status,201);assert.equal(saved.body.emailNotification,'not-configured');
  assert.equal(f.sent.length,0);
});
