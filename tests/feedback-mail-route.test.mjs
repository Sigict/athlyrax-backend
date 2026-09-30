import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { registerFeedbackRoutes } from '../feedback-routes.mjs';

function harness({ mailFails = false, smtp = { host: 'smtp.test', from: 'noreply@test.invalid' } } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'athlyrax-feedback-test-'));
  const routes = new Map();
  const mails = [];
  const app = {};
  for (const method of ['post','get','patch']) app[method] = (route,...handlers) => routes.set(method.toUpperCase() + ' ' + route, handlers.at(-1));
  registerFeedbackRoutes({
    app,fs,path,crypto,storageRoot:root,tenantsDir:path.join(root,'tenants'),
    resolveStoragePathsForAuth:auth=>({dbPath:path.join(root,'tenants',auth.tenantKey,'db.json'),tenantKey:auth.tenantKey}),
    isPrimarySoftwareOwnerAccount:auth=>auth.username === 'softwareowner' && auth.role === 'software-owner',
    requireStrictAuth:()=>{},requireAdminRateLimit:()=>{},enqueueWrite:fn=>Promise.resolve().then(fn),
    getAuthResetMailTransport:()=>({sendMail:async(mail)=>{mails.push(mail);if(mailFails)throw Error('Simulated mail failure');}}),
    smtp,appendAuthAuditEvent:()=>{},
  });
  const request = (method, route, auth, {body={},params={}}={}) => new Promise((resolve,reject)=>{
    const handler=routes.get(method.toUpperCase()+' '+route);
    if(!handler) return reject(Error('Route missing '+method+' '+route));
    const res={statusCode:200,status(code){this.statusCode=code;return this;},json(payload){resolve({status:this.statusCode,body:payload});return this;}};
    try {handler({body,params,auth},res);}catch(e){reject(e);}
  });
  return {root,mails,request,files:tenant=>path.join(root,'tenants',tenant,'feedback-messages.json'),cleanup:()=>fs.rmSync(root,{recursive:true,force:true})};
}
test('feedback persists per tenant, notifies AthlyraX Outlook, and is owner-inbox-only',async()=>{
  const h=harness();
  try {
    const coach={username:'demo.coach',role:'head-coach',tenantKey:'demo-company'};
    const owner={username:'softwareowner',role:'software-owner',tenantKey:'global-owner'};
    const submission=await h.request('POST','/feedback',coach,{body:{topic:'Poolside results',description:'Please check the set averages.'}});
    assert.equal(submission.status,201);
    assert.equal(submission.body.notification.status,'sent');
    assert.equal(h.mails.length,1);
    assert.equal(h.mails[0].to,'AthlyraX@outlook.com');
    assert.match(h.mails[0].text,/demo\.coach/);
    assert.equal(JSON.parse(fs.readFileSync(h.files('demo-company'),'utf8')).length,1);
    assert.equal((await h.request('GET','/feedback',coach)).status,403);
    const inbox=await h.request('GET','/feedback',owner);
    assert.equal(inbox.status,200);
    assert.equal(inbox.body.rows.length,1);
    assert.equal(inbox.body.rows[0].description,'Please check the set averages.');
    assert.equal((await h.request('PATCH','/feedback/:id/decision',coach,{params:{id:submission.body.row.id},body:{decision:'fix'}})).status,403);
    const triage=await h.request('PATCH','/feedback/:id/decision',owner,{params:{id:submission.body.row.id},body:{decision:'fix'}});
    assert.equal(triage.status,200);
    assert.equal(triage.body.row.decision,'fix');
    assert.equal(JSON.parse(fs.readFileSync(h.files('demo-company'),'utf8'))[0].decision,'fix');
  } finally {h.cleanup();}
});
test('SMTP failure cannot erase successfully saved feedback',async()=>{
  const h=harness({mailFails:true});
  try {
    const actor={username:'pilot-coach',role:'head-coach',tenantKey:'pilot-club'};
    const saved=await h.request('POST','/feedback',actor,{body:{topic:'Bug',description:'The checkbox did not save.'}});
    assert.equal(saved.status,201);
    assert.equal(saved.body.notification.status,'failed');
    assert.equal(JSON.parse(fs.readFileSync(h.files('pilot-club'),'utf8')).length,1);
  } finally {h.cleanup();}
});
test('invalid feedback store is never overwritten with empty fallback',async()=>{
  const h=harness();
  try {
    const actor={username:'pilot-coach',role:'head-coach',tenantKey:'pilot-club'};
    fs.mkdirSync(path.dirname(h.files('pilot-club')),{recursive:true});
    fs.writeFileSync(h.files('pilot-club'),'CORRUPTED','utf8');
    const result=await h.request('POST','/feedback',actor,{body:{topic:'Bug',description:'Real message'}});
    assert.equal(result.status,500);
    assert.equal(fs.readFileSync(h.files('pilot-club'),'utf8'),'CORRUPTED');
    assert.equal(h.mails.length,0);
  } finally {h.cleanup();}
});
test('rejects blank and oversized feedback before any write',async()=>{
  const h=harness();
  try {
    const actor={username:'pilot-coach',role:'head-coach',tenantKey:'pilot-club'};
    assert.equal((await h.request('POST','/feedback',actor,{body:{topic:' ',description:'Hello'}})).status,400);
    assert.equal((await h.request('POST','/feedback',actor,{body:{topic:'a'.repeat(201),description:'Hello'}})).status,400);
    assert.equal(fs.existsSync(h.files('pilot-club')),false);
  } finally {h.cleanup();}
});
