import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { registerCpdModule02 } from '../cpd-module02.mjs';

test('paid Module 2 stays closed until enabled, and exposes videos/certificates only to verified buyers',async()=>{
  const saved={CPD_SESSION_SECRET:process.env.CPD_SESSION_SECRET,CPD_MODULE02_PRICE_ID:process.env.CPD_MODULE02_PRICE_ID,CPD_MODULE02_SALES_ENABLED:process.env.CPD_MODULE02_SALES_ENABLED};
  process.env.CPD_SESSION_SECRET='test-secret-longer-than-thirty-two-characters';
  process.env.CPD_MODULE02_PRICE_ID='price_test_module02';
  process.env.CPD_MODULE02_SALES_ENABLED='false';
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'cpd02-'));
  const app=express();
  app.use(express.json({limit:'25mb'}));
  const checkout={id:'cs_test_abcdefgh123456',mode:'payment',payment_status:'paid',metadata:{course:'cpd01-module02',learner_name:'Course Learner'},amount_total:499,currency:'gbp',customer_details:{email:'test@example.com'}};
  const stripe={
    checkout:{sessions:{retrieve:async()=>checkout,create:async()=>({url:'https://checkout.stripe.com/c/pay/test'})}},
    prices:{retrieve:async()=>({active:true,type:'one_time',currency:'gbp',unit_amount:499})}
  };
  const auth=(req,res,next)=>{if(req.headers['x-test-owner']==='true')next();else res.status(401).json({error:'owner only'});};
  registerCpdModule02(app,{stripeClient:stripe,storageRoot:root,requireStrictAuth:auth,requireSoftwareOwnerRole:auth});
  const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
  const api='http://127.0.0.1:'+server.address().port+'/cpd/module-02';
  try{
    const get=async p=>fetch(api+p);
    const post=async(p,obj,headers={})=>fetch(api+p,{method:'POST',headers:{'content-type':'application/json',...headers},body:JSON.stringify(obj)});
    let r=await get('/status');assert.equal((await r.json()).salesEnabled,false);
    r=await post('/checkout',{email:'test@example.com',fullName:'Course Learner'});assert.equal(r.status,503);
    r=await get('/video/1');assert.equal(r.status,401);
    r=await post('/assessment',{section:'final',answers:Array(10).fill(0)});assert.equal(r.status,401);
    r=await get('/questions?section=final');const publicBank=await r.json();
    assert.equal(publicBank.questions.length,10);
    assert.equal(Object.hasOwn(publicBank.questions[0],'correct_option_index'),false);
    const bytes=Buffer.alloc(2048);bytes.write('ftyp',4,'ascii');
    r=await post('/admin/video/1',{base64:bytes.toString('base64')},{'x-test-owner':'true'});
    assert.equal(r.status,200,'owner can upload private MP4');
    r=await post('/claim',{session_id:checkout.id});assert.equal(r.status,200);
    const cookie=r.headers.get('set-cookie').split(';')[0];assert.match(cookie,/athlyrax_cpd02=/);
    const ownerGet=async(p,options={})=>fetch(api+p,{...options,headers:{cookie,...(options.headers||{})}});
    const ownerPost=async(p,obj)=>ownerGet(p,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(obj)});
    r=await ownerGet('/video/1',{headers:{Range:'bytes=0-23'}});
    assert.equal(r.status,206);assert.equal((await r.arrayBuffer()).byteLength,24);
    r=await ownerPost('/assessment',{section:'final',answers:Array(10).fill(0)});assert.equal(r.status,403,'final assessment gated on course and checks');
    for(const n of [1,2,3]){r=await ownerPost('/lesson-complete',{lesson:n});assert.equal(r.status,200);}
    const bank=JSON.parse(fs.readFileSync(new URL('../cpd-module02-private-questions.json',import.meta.url)));
    for(const section of ['check-1','check-2']){
      const answers=bank.questions.filter(x=>x.section===section).map(x=>x.correct_option_index);
      r=await ownerPost('/assessment',{section,answers});assert.equal(r.status,200);
    }
    r=await ownerPost('/assessment',{section:'final',answers:bank.questions.filter(x=>x.section==='final').map(x=>x.correct_option_index)});
    const result=await r.json();assert.equal(result.pass,true);assert.equal(result.score,10);
    r=await ownerGet('/certificate');assert.equal(r.status,200);
    const pdf=Buffer.from(await r.arrayBuffer());assert.ok(pdf.toString('ascii',0,8).startsWith('%PDF-1.4'));
  } finally {
    await new Promise(resolve=>server.close(resolve));
    fs.rmSync(root,{recursive:true,force:true});
    for(const [k,v] of Object.entries(saved)){if(v===undefined)delete process.env[k];else process.env[k]=v;}
  }
});
