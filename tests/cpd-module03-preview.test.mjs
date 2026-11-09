import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { registerCpdModule03Preview } from '../cpd-module03-preview.mjs';

const rootDir=path.dirname(fileURLToPath(import.meta.url));
const bank=JSON.parse(fs.readFileSync(path.join(rootDir,'../cpd-module03-private-questions.json'),'utf8')).questions;
const temp=async()=>{
  const storageRoot=fs.mkdtempSync(path.join(os.tmpdir(),'athlyrax-m03-'));
  const media=path.join(storageRoot,'cpd','module-03');
  fs.mkdirSync(media,{recursive:true});
  for(let i=1;i<=3;i++){let b=Buffer.alloc(8192);b.write('ftypisom',4);fs.writeFileSync(path.join(media,'lesson-'+i+'.mp4'),b);}
  const app=express();app.use(express.json());
  const requireStrictAuth=(req,res,next)=>{
    if(!req.headers['x-test-role']) return res.status(401).json({error:'Authentication required'});
    next();
  };
  const requireSoftwareOwnerRole=(req,res,next)=>{
    if(req.headers['x-test-role']!=='owner')return res.status(403).json({error:'Owner required'});
    next();
  };
  registerCpdModule03Preview(app,{storageRoot,requireStrictAuth,requireSoftwareOwnerRole});
  const server=app.listen(0,'127.0.0.1');
  await new Promise(r=>server.once('listening',r));
  const url='http://127.0.0.1:'+server.address().port+'/cpd/module-03/owner';
  const req=(p,options={})=>fetch(url+p,{...options,headers:{'x-test-role':'owner',...options.headers}});
  const post=(p,payload)=>req(p,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
  const close=async()=>{await new Promise(r=>server.close(r));fs.rmSync(storageRoot,{force:true,recursive:true});};
  return {url,req,post,close,storageRoot};
};

test('owner-only preview: all routes block anonymous and coaches',async()=>{
  const t=await temp();
  try{
    for(const role of [null,'coach']){
      for(const route of ['/status','/questions?section=check-1','/video/1','/certificate']){
        const headers=role?{'x-test-role':role}:{};
        const res=await fetch(t.url+route,{headers});
        assert.equal(res.status,role?403:401,route);
      }
    }
  }finally{await t.close();}
});

test('three lessons, three formative checks, final 8/10 and preview PDF',async()=>{
  const t=await temp();
  try{
    let res=await t.req('/status');
    let state=await res.json();
    assert.equal(res.status,200);assert.equal(state.paidAccess,true);assert.equal(state.salesEnabled,false);
    assert.equal(state.ownerPreview,true);assert.equal(state.certificate,null);
    assert.equal((await t.req('/questions?section=final')).status,409);
    for(let n=1;n<=3;n++){
      if(n>1)assert.equal((await t.post('/lesson-complete',{lesson:n})).status,409);
      let v=await t.req('/video/'+n,{headers:{Range:'bytes=0-8191'}});
      assert.equal(v.status,206);assert.equal((await v.arrayBuffer()).byteLength,8192);
      res=await t.post('/lesson-complete',{lesson:n});
      assert.equal(res.status,200);
      const section='check-'+n;
      const questions=await (await t.req('/questions?section='+section)).json();
      assert.equal(questions.questions.length,3);
      assert.equal(questions.questions[0].correct_option_index,undefined);
      const answers=bank.filter(q=>q.section===section).map(q=>q.correct_option_index);
      res=await t.post('/assessment',{section,answers});
      assert.equal(res.status,200);
      assert.equal((await res.json()).score,3);
    }
    const final=bank.filter(q=>q.section==='final').map(q=>q.correct_option_index);
    res=await t.post('/assessment',{section:'final',answers:final.map((v,i)=>i<7?v:(v+1)%4)});
    assert.equal((await res.json()).pass,false);
    res=await t.post('/assessment',{section:'final',answers:final});
    assert.equal((await res.json()).pass,true);
    const cert=await t.req('/certificate');
    assert.equal(cert.status,200);
    assert.match(cert.headers.get('content-type'),/application\/pdf/);
    const bytes=Buffer.from(await cert.arrayBuffer()).toString('latin1');
    assert.ok(bytes.startsWith('%PDF-1.4'));
    assert.match(bytes,/OWNER PREVIEW - NOT A VALID CERTIFICATE/);
    assert.equal((await (await t.req('/verify/AXE-M03-PREVIEW')).json()).valid,false);
    state=await (await t.req('/status')).json();
    assert.equal(state.progress.checks.length,3);
    assert.equal(state.progress.finalAttempts,2);
    assert.equal(state.certificate.id,'AXE-M03-PREVIEW');
  }finally{await t.close();}
});
