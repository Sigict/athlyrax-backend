import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { installFeedbackRoutes } from '../feedback-routes.mjs';

function makeHarness({failMail=false, smtp=true}={}) {
  const storageRoot=fs.mkdtempSync(path.join(os.tmpdir(),'athlyrax-feedback-test-'));
  const handlers=new Map();
  const mail=[];
  const app={get:(url,...stack)=>handlers.set('GET '+url,stack.at(-1)),
    post:(url,...stack)=>handlers.set('POST '+url,stack.at(-1)),
    patch:(url,...stack)=>handlers.set('PATCH '+url,stack.at(-1))};
  let writeTail=Promise.resolve();
  const enqueueWrite=(cb)=>{const next=writeTail.then(cb);writeTail=next.catch(()=>{});return next;};
  const writeAtomicJsonFile=(file,data)=>{fs.mkdirSync(path.dirname(file),{recursive:true});const temp=file+'.tmp';fs.writeFileSync(temp,JSON.stringify(data));fs.renameSync(temp,file);};
  const transport={sendMail:async(msg)=>{if(failMail)throw Error('SMTP unavailable');mail.push(msg);return {accepted:[msg.to]};}};
  installFeedbackRoutes({app,requireStrictAuth:()=>{},resolveStoragePathsForAuth:(auth)=>({tenantKey:auth.tenant || 'demo-company'}),
    isPrimarySoftwareOwnerAccount:(auth)=>auth.username==='softwareowner' && auth.role==='software-owner',
    enqueueWrite,writeAtomicJsonFile,getAuthResetMailTransport:()=>transport,
    smtpHost:smtp?'smtp.example.invalid':'',smtpFrom:smtp?'notifications@example.invalid':'',
    storageRoot,authUserLookup:(username)=>({swimClub:'Demo Company',username}),
    notifyEmail:'AthlyraX@outlook.com',retryIntervalMs:60000});
  const request=async(method,url,{auth,body,params}={})=>{
    const fn=handlers.get(method+' '+url);
    assert.ok(fn,'expected '+method+' '+url);
    return new Promise((resolve,reject)=>{
      const res={status(code){this.code=code;return this},json(value){resolve({status:this.code||200,body:value});return this}};
      try {fn({auth:auth||{username:'demo.coach',role:'head-coach',tenant:'demo-company'},body:body||{},params:params||{}},res);}
      catch(e){reject(e);}
    });
  };
  return {storageRoot,request,mail};
}

test('coach can save feedback; owner-only inbox; recipient and id are included in mail',async(t)=>{
  const h=makeHarness();
  t.after(()=>fs.rmSync(h.storageRoot,{recursive:true,force:true}));
  const coach={username:'demo.coach',role:'head-coach',tenant:'demo-company'};
  const owner={username:'softwareowner',role:'software-owner',tenant:'global-owner'};
  assert.deepEqual((await h.request('GET','/feedback',{auth:coach})).body,{ok:true,rows:[],canViewInbox:false});
  const submitted=await h.request('POST','/feedback',{auth:coach,body:{topic:'Save results',description:'Session results load slowly'}});
  assert.equal(submitted.status,201);
  assert.equal(submitted.body.row.notificationStatus,'pending');
  const file=path.join(h.storageRoot,'tenants','demo-company','feedback-messages.json');
  assert.ok(fs.existsSync(file));
  assert.equal(JSON.parse(fs.readFileSync(file,'utf8')).length,1);
  for(let n=0;n<60 && h.mail.length===0;n++) await new Promise(resolve=>setTimeout(resolve,10));
  assert.equal(h.mail.length,1);
  assert.equal(h.mail[0].to,'AthlyraX@outlook.com');
  assert.ok(h.mail[0].text.includes('Session results load slowly'));
  const inbox=await h.request('GET','/feedback',{auth:owner});
  assert.equal(inbox.status,200);
  assert.equal(inbox.body.canViewInbox,true);
  assert.equal(inbox.body.rows.length,1);
  assert.equal(inbox.body.rows[0].tenantKey,'demo-company');
  const forbidden=await h.request('PATCH','/feedback/:id/decision',{auth:coach,params:{id:submitted.body.row.id},body:{decision:'fix'}});
  assert.equal(forbidden.status,403);
  const archived=await h.request('PATCH','/feedback/:id/decision',{auth:owner,params:{id:submitted.body.row.id},body:{decision:'archive'}});
  assert.equal(archived.status,200);assert.equal(archived.body.row.status,'archived');
});
test('failed SMTP never discards a stored coach message and leaves durable pending status',async(t)=>{
  const h=makeHarness({failMail:true});
  t.after(()=>fs.rmSync(h.storageRoot,{recursive:true,force:true}));
  const result=await h.request('POST','/feedback',{body:{topic:'Issue',description:'Helpful detailed report'}});
  assert.equal(result.status,201);
  await new Promise(resolve=>setTimeout(resolve,25));
  const rows=JSON.parse(fs.readFileSync(path.join(h.storageRoot,'tenants','demo-company','feedback-messages.json'),'utf8'));
  assert.equal(rows.length,1);
  assert.equal(rows[0].notificationStatus,'pending');
  assert.equal(rows[0].description,'Helpful detailed report');
});
test('missing SMTP still saves and indicates unavailable email delivery',async(t)=>{
  const h=makeHarness({smtp:false});
  t.after(()=>fs.rmSync(h.storageRoot,{recursive:true,force:true}));
  const result=await h.request('POST','/feedback',{body:{topic:'Suggestion',description:'Add another metric'}});
  assert.equal(result.status,201);
  assert.equal(result.body.emailNotification,'awaiting-smtp-configuration');
});
test('reject blank, oversized, and repeated submissions before storage',async(t)=>{
  const h=makeHarness({smtp:false});
  t.after(()=>fs.rmSync(h.storageRoot,{recursive:true,force:true}));
  assert.equal((await h.request('POST','/feedback',{body:{topic:'',description:'x'}})).status,400);
  assert.equal((await h.request('POST','/feedback',{body:{topic:'a',description:'x'.repeat(4001)}})).status,400);
  for(let n=0;n<5;n++) assert.equal((await h.request('POST','/feedback',{body:{topic:'a'+n,description:'x'}})).status,201);
  assert.equal((await h.request('POST','/feedback',{body:{topic:'a6',description:'x'}})).status,429);
});
const transform=fs.readFileSync('scripts/build-production-backend.mjs','utf8');
assert.ok(transform.includes("['scripts/patch-feedback-notification.mjs']"));
assert.ok(transform.includes("'feedback-routes.mjs'"));
