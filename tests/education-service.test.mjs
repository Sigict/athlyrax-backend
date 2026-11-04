import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createEducationService } from '../education-service.mjs';
import { module2FinalQuestions, module2KnowledgeChecks } from '../education-question-bank.mjs';

function response(){
  return {statusCode:200,body:null,status(c){this.statusCode=c;return this;},
    json(v){this.body=v;return this;},set(){return this},end(){return this}};
}
const person=(username='learner',role='viewer')=>({auth:{username,role},headers:{}});
const signed=(event)=>({headers:{'stripe-signature':'test-signature'},body:Buffer.from(JSON.stringify(event))});
const event=(type,id,obj)=>({id,type,data:{object:obj}});

test('education checkout, webhook, progression, certificate and refund are isolated and fail closed',async(t)=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'athlyrax-edu-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  let sessionArgs;
  const stripe={
    checkout:{sessions:{create:async args=>{sessionArgs=args;return {id:'cs_test_1',url:'https://checkout.stripe.com/pay/cs_test_1'}}}},
    webhooks:{constructEvent:(raw,sig,secret)=>{
      assert.equal(sig,'test-signature');assert.equal(secret,'whsec_test');
      return JSON.parse(raw.toString('utf8'));
    }}
  };
  const education=createEducationService({
    storePath:path.join(dir,'enrolments.json'),stripe,webhookSecret:'whsec_test',
    appBaseUrl:'https://athlyrax.com',ownerUsername:'softwareowner',enabled:true,
    questionBank:[...module2KnowledgeChecks,...module2FinalQuestions],
    resolveLearner:()=>({fullName:'Sample Learner'})
  });
  let res=response();
  await education.progress({...person(),body:{section:'video-1'}},res);
  assert.equal(res.statusCode,403);

  res=response();
  await education.checkout(person(),res);
  assert.equal(res.statusCode,200);
  assert.equal(sessionArgs.mode,'payment');
  assert.equal(sessionArgs.line_items[0].price_data.unit_amount,499);
  assert.equal(sessionArgs.line_items[0].price_data.currency,'gbp');

  const session={id:'cs_test_1',mode:'payment',payment_status:'unpaid',currency:'gbp',
    amount_total:499,client_reference_id:'learner',payment_intent:'pi_1',
    metadata:{product:'athlyrax-education',courseId:'cpd01-module02'}};
  res=response();
  await education.webhook(signed(event('checkout.session.completed','evt_unpaid',session)),res);
  assert.equal(res.statusCode,200);
  res=response();education.me(person(),res);
  assert.equal(res.body.enrolment,null);

  res=response();await education.webhook(signed(event('checkout.session.completed','evt_paid',{...session,payment_status:'paid'})),res);
  assert.equal(res.statusCode,200);
  res=response();education.me(person(),res);
  assert.equal(res.body.enrolment.status,'paid');

  // Sequence is enforced by backend; browser cannot skip to video 2 or 3.
  res=response();await education.progress({...person(),body:{section:'video-3'}},res);
  assert.equal(res.statusCode,409);
  res=response();await education.progress({...person(),body:{section:'video-2'}},res);
  assert.equal(res.statusCode,409);
  res=response();await education.progress({...person(),body:{section:'video-1'}},res);
  assert.equal(res.statusCode,200);

  res=response();education.questions({...person(),params:{section:'final'}},res);
  assert.equal(res.body.questions.length,10);
  assert.equal('correct_option_index' in res.body.questions[0],false);
  res=response();await education.assess({...person(),body:{answers:module2FinalQuestions.map(q=>q.correct_option_index)}},res);
  assert.equal(res.statusCode,409);

  for(const [part,nextSection] of [['check-1','video-2'],['check-2','video-3']]){
    const questions=module2KnowledgeChecks.filter(q=>q.section===part);
    res=response();await education.knowledgeCheck({...person(),body:{section:part,answers:questions.map(q=>q.correct_option_index)}},res);
    assert.equal(res.statusCode,200);
    res=response();await education.progress({...person(),body:{section:nextSection}},res);
    assert.equal(res.statusCode,200);
  }

  res=response();await education.assess({...person(),body:{answers:module2FinalQuestions.map(q=>q.correct_option_index)}},res);
  assert.equal(res.statusCode,200);
  assert.equal(res.body.passed,true);
  assert.match(res.body.enrolment.certificateId,/^AX-EDU-/);
  res=response();education.certificate(person(),res);
  assert.equal(res.statusCode,200);
  assert.equal(res.body.learnerName,'Sample Learner');

  res=response();education.admin(person(),res);
  assert.equal(res.statusCode,403);
  res=response();education.admin(person('softwareowner','software-owner'),res);
  assert.equal(res.statusCode,200);
  assert.equal(res.body.total,1);
  assert.equal(res.body.grossGbpPence,499);

  res=response();await education.webhook(signed(event('charge.refunded','evt_refunded',{payment_intent:'pi_1',refunded:true})),res);
  assert.equal(res.statusCode,200);
  res=response();education.media({...person(),params:{part:'1'}},res);
  assert.equal(res.statusCode,403);
  res=response();education.certificate(person(),res);
  assert.equal(res.statusCode,403);
  // Duplicate and out-of-order paid events must not reactivate a refunded enrolment.
  res=response();await education.webhook(signed(event('checkout.session.completed','evt_paid',{...session,payment_status:'paid'})),res);
  res=response();education.me(person(),res);
  assert.equal(res.body.enrolment.status,'revoked');
});

test('checkout unavailable without verified configuration',async(t)=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'athlyrax-edu-disabled-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const service=createEducationService({storePath:path.join(dir,'education.json'),enabled:false});
  const res=response();
  await service.checkout(person(),res);
  assert.equal(res.statusCode,503);
});

test('webhook refuses missing or forged signatures',async(t)=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'athlyrax-edu-signatures-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const service=createEducationService({
    storePath:path.join(dir,'enrolments.json'),
    stripe:{webhooks:{constructEvent:()=>{throw Error('Invalid signature')}}},
    webhookSecret:'whsec_test'
  });
  let res=response();
  await service.webhook({headers:{},body:Buffer.from('{}')},res);
  assert.equal(res.statusCode,400);
  res=response();
  await service.webhook({headers:{'stripe-signature':'forged'},body:Buffer.from('{}')},res);
  assert.equal(res.statusCode,400);
});