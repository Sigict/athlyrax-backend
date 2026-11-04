/* AthlyraX Education — independent one-time billing; software subscriptions remain untouched. */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const EDUCATION_COURSE = Object.freeze({ id:'cpd01-module02', title:'Our Body, Our Engine', currency:'gbp', amount:499 });
const iso=()=>new Date().toISOString();
function secureEqual(a,b){const x=Buffer.from(String(a||'')), y=Buffer.from(String(b||''));return x.length===y.length && crypto.timingSafeEqual(x,y)}
function jsonSafeRead(filename){
  try{const value=JSON.parse(fs.readFileSync(filename,'utf8'));return value&&typeof value==='object'&&!Array.isArray(value)?value:{}}
  catch(e){if(e.code==='ENOENT')return {};throw e}
}
function atomicWrite(filename,payload){
  const dir=path.dirname(filename);fs.mkdirSync(dir,{recursive:true});
  const temp=path.join(dir,'.education-'+crypto.randomUUID()+'.tmp');
  try{fs.writeFileSync(temp,JSON.stringify(payload,null,2)+'\n',{encoding:'utf8',mode:0o600,flag:'wx'});
    fs.renameSync(temp,filename);}
  finally{try{fs.unlinkSync(temp)}catch{}}
}
function present(row){return {courseId:row.courseId,status:row.status,paidAt:row.paidAt||null,completedAt:row.completedAt||null,certificateId:row.certificateId||null,sections:row.sections||[],finalScore:row.finalScore??null};}
export function createEducationService({storePath,stripe,webhookSecret,appBaseUrl,ownerUsername,enabled=false,questionBank=[],resolveLearner=()=>null}){
  const database=()=>({enrolments:{},events:{},sessions:{},revocations:{},...jsonSafeRead(storePath)});
  const save=atomicWrite;
  let writeChain=Promise.resolve();
  function transact(change){
    const job=writeChain.catch(()=>{}).then(()=>{const state=database();const result=change(state);save(storePath,state);return result});
    writeChain=job;return job;
  }
  const key=username=>String(username||'').trim().toLowerCase()+':'+EDUCATION_COURSE.id;
  const isOwner=req=>req.auth && String(req.auth.username||'').toLowerCase()===String(ownerUsername||'').toLowerCase() && String(req.auth.role||'')==='software-owner';
  const authenticated=req=>Boolean(req.auth?.username);
  async function checkout(req,res){
    if(!authenticated(req))return res.status(401).json({error:'Sign in to enrol.'});
    if(!enabled || !stripe || !appBaseUrl || !webhookSecret)return res.status(503).json({error:'Education checkout is not enabled.'});
    const username=String(req.auth.username).trim();
    const existing=database().enrolments[key(username)];
    if(existing?.status==='paid' || existing?.status==='completed')return res.status(409).json({error:'Already enrolled.'});
    try{
      const session=await stripe.checkout.sessions.create({
        mode:'payment',client_reference_id:username,
        payment_method_types:['card'],
        line_items:[{price_data:{currency:'gbp',unit_amount:499,product_data:{name:'AthlyraX Education — Module 2: Our Body, Our Engine'}},quantity:1}],
        success_url:appBaseUrl.replace(/\/$/,'')+'/education/my-courses?checkout=success',
        cancel_url:appBaseUrl.replace(/\/$/,'')+'/education/my-courses?checkout=cancelled',
        metadata:{product:'athlyrax-education',courseId:EDUCATION_COURSE.id,username},
      });
      if(!session?.id || !/^https:\/\/checkout\.stripe\.com\//.test(session?.url||''))return res.status(502).json({error:'Invalid checkout session.'});
      await transact(state=>{state.sessions[session.id]={username,courseId:EDUCATION_COURSE.id,createdAt:iso()};});
      return res.json({checkoutUrl:session.url});
    }catch{return res.status(502).json({error:'Could not create checkout session.'})}
  }
  async function webhook(req,res){
    if(!stripe||!webhookSecret)return res.status(503).json({error:'Education billing not configured.'});
    const signature=String(req.headers['stripe-signature']||'');
    if(!signature||!Buffer.isBuffer(req.body))return res.status(400).json({error:'Signature required.'});
    let event;
    try{event=stripe.webhooks.constructEvent(req.body,signature,webhookSecret)}
    catch{return res.status(400).json({error:'Invalid Stripe signature.'})}
    const type=String(event?.type||'');const obj=event?.data?.object||{};
    if(!['checkout.session.completed','checkout.session.async_payment_succeeded','checkout.session.async_payment_failed','charge.refunded','charge.dispute.created'].includes(type))return res.json({ok:true,ignored:true});
    try{
      await transact(state=>{
        if(state.events[event.id])return;
        if(type.startsWith('checkout.session.')){
          const record=state.sessions[String(obj.id||'')];
          // A completed session alone cannot grant access unless Stripe confirms payment_status=paid.
          if(record && obj.mode==='payment' && obj.metadata?.product==='athlyrax-education' &&
             obj.metadata?.courseId===record.courseId && secureEqual(record.username,obj.client_reference_id) &&
             obj.currency==='gbp' && Number(obj.amount_total)===499){
            const rowKey=key(record.username);
            if((type==='checkout.session.completed'||type==='checkout.session.async_payment_succeeded')&&obj.payment_status==='paid'){
              const previous=state.enrolments[rowKey]||{};
              const revoked=Boolean(state.revocations[String(obj.payment_intent||'')]);
              state.enrolments[rowKey]={...previous,username:record.username,courseId:record.courseId,status:revoked?'revoked':'paid',checkoutSessionId:obj.id,
                paymentIntentId:String(obj.payment_intent||''),paidAt:previous.paidAt||iso(),amount:499,currency:'gbp'};
            }
          }
        }else{
          const paymentIntentId=String(obj.payment_intent||'');
          if(paymentIntentId&&(type==='charge.dispute.created'||(type==='charge.refunded'&&obj.refunded===true)))state.revocations[paymentIntentId]={type,at:iso()};
          for(const row of Object.values(state.enrolments)){
            if(row.paymentIntentId===paymentIntentId&&paymentIntentId){
              if(type==='charge.dispute.created'||(type==='charge.refunded'&&obj.refunded===true))
                row.status='revoked';
            }
          }
        }
        state.events[event.id]={type,at:iso()};
      });
      return res.json({ok:true});
    }catch{return res.status(500).json({error:'Education payment storage failure.'})}
  }
  function me(req,res){
    if(!authenticated(req))return res.status(401).json({error:'Sign in required.'});
    const row=database().enrolments[key(req.auth.username)];
    return res.json({course:EDUCATION_COURSE,enrolment:row?present(row):null,checkoutEnabled:Boolean(enabled&&stripe&&webhookSecret&&appBaseUrl)});
  }
  function questions(req,res){
    if(!authenticated(req))return res.status(401).json({error:'Sign in required.'});
    const row=database().enrolments[key(req.auth.username)];
    if(!row||!['paid','completed'].includes(row.status))return res.status(403).json({error:'Paid enrolment required.'});
    const section=String(req.params.section||'');
    if(!['check-1','check-2','final'].includes(section))return res.status(404).json({error:'Unknown question group.'});
    return res.json({questions:questionBank.filter(q=>q.section===section).map(({id,question,options})=>({id,question,options}))});
  }
  async function progress(req,res){
    if(!authenticated(req))return res.status(401).json({error:'Sign in required.'});
    const section=String(req.body?.section||'');
    if(!['video-1','video-2','video-3'].includes(section))return res.status(400).json({error:'Invalid course section.'});
    const rowKey=key(req.auth.username);
    try{
      const result=await transact(state=>{
        const row=state.enrolments[rowKey];if(!row||!['paid','completed'].includes(row.status))return null;
        row.sections=[...new Set([...(row.sections||[]),section])];return present(row);
      });
      return result?res.json({enrolment:result}):res.status(403).json({error:'Paid enrolment required.'});
    }catch{return res.status(500).json({error:'Unable to save course progress.'})}
  }

  async function knowledgeCheck(req,res){
    if(!authenticated(req))return res.status(401).json({error:'Sign in required.'});
    const section=String(req.body?.section||'');
    if(!['check-1','check-2'].includes(section))return res.status(400).json({error:'Invalid knowledge check.'});
    const answers=req.body?.answers;
    const questions=questionBank.filter(q=>q.section===section);
    if(questions.length!==4||!Array.isArray(answers)||answers.length!==4||
      !answers.every(n=>Number.isInteger(n)&&n>=0&&n<=3))
      return res.status(400).json({error:'Submit four answers.'});
    const keyName=key(req.auth.username);
    try{
      const result=await transact(state=>{
        const row=state.enrolments[keyName];
        if(!row||!['paid','completed'].includes(row.status))return {status:403,error:'Paid enrolment required.'};
        const prerequisite=section==='check-1'?'video-1':'video-2';
        if(!(row.sections||[]).includes(prerequisite))return {status:409,error:'Complete the preceding lesson first.'};
        const score=questions.reduce((sum,q,i)=>sum+(q.correct_option_index===answers[i]?1:0),0);
        row.sections=[...new Set([...(row.sections||[]),section])];
        return {score,passed:score===4,correct:questions.map(q=>q.correct_option_index),enrolment:present(row)};
      });
      return result.error?res.status(result.status).json({error:result.error}):res.json(result);
    }catch{return res.status(500).json({error:'Unable to save knowledge check.'})}
  }
  async function assess(req,res){
    if(!authenticated(req))return res.status(401).json({error:'Sign in required.'});
    const answerList=req.body?.answers;
    if(!Array.isArray(answerList)||answerList.length!==10||!answerList.every(v=>Number.isInteger(v)&&v>=0&&v<=3))
      return res.status(400).json({error:'Submit ten multiple-choice answers.'});
    const questions=questionBank.filter(q=>q.section==='final');
    if(questions.length!==10)return res.status(503).json({error:'Final assessment is not configured.'});
    const rowKey=key(req.auth.username);
    try{
      const result=await transact(state=>{
        const row=state.enrolments[rowKey];if(!row||!['paid','completed'].includes(row.status))return {error:'Paid enrolment required.',status:403};
        if(!['video-1','check-1','video-2','check-2','video-3'].every(section=>(row.sections||[]).includes(section)))
          return {error:'Complete the lessons and knowledge checks first.',status:409};
        const score=questions.reduce((sum,q,i)=>sum+(q.correct_option_index===answerList[i]?1:0),0);
        row.finalScore=Math.max(Number(row.finalScore||0),score);
        row.lastAttemptAt=iso();
        if(score>=8){row.status='completed';row.completedAt=row.completedAt||iso();row.certificateId=row.certificateId||'AX-EDU-'+crypto.randomBytes(10).toString('hex').toUpperCase();}
        return {score,passed:score>=8,enrolment:present(row)};
      });
      return result.error?res.status(result.status).json({error:result.error}):res.json(result);
    }catch{return res.status(500).json({error:'Could not save final assessment.'})}
  }
  function certificate(req,res){
    if(!authenticated(req))return res.status(401).json({error:'Sign in required.'});
    const row=database().enrolments[key(req.auth.username)];
    if(!row||row.status!=='completed'||!row.completedAt||!row.certificateId)
      return res.status(403).json({error:'A passed final assessment is required.'});
    const user=resolveLearner(req.auth.username);
    const learnerName=String(user?.fullName||'').trim();
    if(!learnerName)return res.status(409).json({error:'Learner name missing. Contact support.'});
    return res.json({certificateId:row.certificateId,learnerName,courseId:EDUCATION_COURSE.id,
      courseTitle:EDUCATION_COURSE.title,completedAt:row.completedAt,
      finalScore:row.finalScore,passThreshold:8,issuer:'AthlyraX Education'});
  }
  function admin(req,res){
    if(!isOwner(req))return res.status(403).json({error:'Owner access required.'});
    const rows=Object.values(database().enrolments).map(r=>({...present(r),username:r.username,amount:r.amount||0,currency:r.currency||'',paymentIntentId:r.paymentIntentId||''}));
    return res.json({course:EDUCATION_COURSE,enrolments:rows,total:rows.length,paid:rows.filter(r=>['paid','completed'].includes(r.status)).length,
      completed:rows.filter(r=>r.status==='completed').length,
      grossGbpPence:rows.filter(r=>['paid','completed'].includes(r.status)).reduce((sum,r)=>sum+r.amount,0)});
  }
  return {checkout,webhook,me,questions,progress,knowledgeCheck,assess,certificate,admin};
}
