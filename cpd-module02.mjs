import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// Module 02 is intentionally independent of the coaching-subscription billing system.
// A checkout session is independently verified with Stripe before any video is served.
const COURSE = 'cpd01-module02';
const COOKIE = 'athlyrax_cpd02';
const TTL = 365 * 24 * 3600;
const FILES = Object.freeze(['lesson-1.mp4', 'lesson-2.mp4', 'lesson-3.mp4']);

const emailValid = x => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(x);
function cookieValue(req, name) {
  const part = String(req.headers.cookie || '').split(';').map(s => s.trim()).find(s => s.startsWith(name + '='));
  return part ? part.slice(name.length + 1) : '';
}
function fixedTimeEqual(a,b) {
  const x=Buffer.from(String(a)); const y=Buffer.from(String(b));
  return x.length===y.length && crypto.timingSafeEqual(x,y);
}
function signSession(data, secret) {
  const payload=Buffer.from(JSON.stringify(data)).toString('base64url');
  const mac=crypto.createHmac('sha256',secret).update(payload).digest('base64url');
  return payload+'.'+mac;
}
function readSession(req, secret) {
  if(!secret)return null;
  const value=cookieValue(req,COOKIE),dot=value.lastIndexOf('.');
  if(dot<1)return null;
  const payload=value.slice(0,dot),mac=value.slice(dot+1);
  const expected=crypto.createHmac('sha256',secret).update(payload).digest('base64url');
  if(!fixedTimeEqual(mac,expected))return null;
  try {
    const d=JSON.parse(Buffer.from(payload,'base64url').toString('utf8'));
    return d?.course===COURSE && typeof d.id==='string' && /^cs_(test_)?[A-Za-z0-9]+$/.test(d.id) && d.exp>Date.now()/1000 ? d : null;
  }catch {return null;}
}
function fail(res,status,message){res.status(status).json({error:message});}
function loadQuestions(){
  const file=path.join(path.dirname(new URL(import.meta.url).pathname),'cpd-module02-private-questions.json');
  const raw=JSON.parse(fs.readFileSync(file,'utf8'));
  const q=raw.questions;
  if(!Array.isArray(q)||q.length!==18||q.filter(x=>x.section==='final').length!==10)throw Error('CPD Module 2 question bank invalid');
  return q;
}
function simplePdf(lines){
  function safe(x){return String(x).normalize('NFKD').replace(/[^\x20-\x7e]/g,'').replace(/[\\()]/g,m=>'\\'+m);}
  const commands=['0.04 0.14 0.23 rg','0 0 842 595 re f','0.25 0.81 0.94 rg','35 35 772 525 re S','BT','/F1 24 Tf','0.29 0.86 0.98 rg','60 485 Td','('+safe(lines[0])+') Tj','/F1 42 Tf','0 -100 Td','1 1 1 rg','('+safe(lines[1])+') Tj','/F1 26 Tf','0 -76 Td','('+safe(lines[2])+') Tj','/F1 16 Tf','0 -55 Td','('+safe(lines[3])+') Tj','0 -34 Td','('+safe(lines[4])+') Tj','0 -34 Td','('+safe(lines[5])+') Tj','ET'];
  const stream=commands.join('\n')+'\n';
  const objects=[
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 842 595] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    '<< /Length '+Buffer.byteLength(stream)+' >>\nstream\n'+stream+'endstream'
  ];
  let out='%PDF-1.4\n', offsets=[0];
  for(const [i,obj] of objects.entries()){offsets.push(Buffer.byteLength(out));out+=(i+1)+' 0 obj\n'+obj+'\nendobj\n';}
  const xref=Buffer.byteLength(out);
  out+='xref\n0 '+(objects.length+1)+'\n0000000000 65535 f \n';
  for(let i=1;i<offsets.length;i++)out+=String(offsets[i]).padStart(10,'0')+' 00000 n \n';
  out+='trailer\n<< /Size '+(objects.length+1)+' /Root 1 0 R >>\nstartxref\n'+xref+'\n%%EOF';
  return Buffer.from(out,'ascii');
}
export function registerCpdModule02(app,{stripeClient,storageRoot,requireStrictAuth,requireSoftwareOwnerRole}) {
  const root=path.join(storageRoot,'cpd','module-02');
  const secret=String(process.env.CPD_SESSION_SECRET||'').trim();
  const priceId=String(process.env.CPD_MODULE02_PRICE_ID||'').trim();
  const enabled=process.env.CPD_MODULE02_SALES_ENABLED==='true';
  const baseUrl=String(process.env.CPD_SITE_ORIGIN||'https://athlyrax.com').replace(/\/+$/,'');
  const readyVideos=()=>FILES.every(f=>{try{const st=fs.statSync(path.join(root,f));return st.isFile()&&st.size>1024;}catch{return false;}});
  const ready=()=>Boolean(stripeClient&&secret.length>=32&&priceId&&enabled&&readyVideos());
  const questionBank=loadQuestions();

  async function ownedSession(req){
    const cookie=readSession(req,secret);
    if(!cookie||!stripeClient)return null;
    const checkout=await stripeClient.checkout.sessions.retrieve(cookie.id);
    if(checkout?.mode!=='payment'||checkout.payment_status!=='paid'||checkout.metadata?.course!==COURSE
      ||checkout.amount_total!==499||String(checkout.currency).toLowerCase()!=='gbp')return null;
    return {id:checkout.id,name:String(checkout.metadata?.learner_name||'Learner'),email:String(checkout.customer_details?.email||checkout.customer_email||'')};
  }
  const base='/cpd/module-02';
  app.get(base+'/status',async(req,res)=>{
    res.set('Cache-Control','no-store');
    let access=false,completion=false;
    try{
      const user=await ownedSession(req);
      access=Boolean(user);
      if(user){
        const record=path.join(root,'completions',crypto.createHash('sha256').update(user.id).digest('hex')+'.json');
        completion=fs.existsSync(record);
      }
    }catch{}
    res.json({course:COURSE,salesEnabled:ready(),videoLessons:3,paidAccess:access,certificateAvailable:completion});
  });
  app.post(base+'/checkout',async(req,res)=>{
    if(!ready()){fail(res,503,'Course purchase is not yet enabled.');return;}
    const email=String(req.body?.email||'').trim().toLowerCase(),name=String(req.body?.fullName||'').trim();
    if(!emailValid(email)||email.length>254||name.length<2||name.length>110){fail(res,400,'Enter a valid learner name and email address.');return;}
    try{
      const price=await stripeClient.prices.retrieve(priceId);
      if(!price.active||price.type!=='one_time'||price.currency!=='gbp'||price.unit_amount!==499){fail(res,503,'Course price is not configured for sale.');return;}
      const checkout=await stripeClient.checkout.sessions.create({
        mode:'payment',customer_email:email,client_reference_id:COURSE,
        line_items:[{price:priceId,quantity:1}],
        success_url:baseUrl+'/education/module-02.html?session_id={CHECKOUT_SESSION_ID}',
        cancel_url:baseUrl+'/education/module-02.html',
        metadata:{course:COURSE,learner_name:name},
        payment_intent_data:{metadata:{course:COURSE}},
        allow_promotion_codes:false
      });
      res.set('Cache-Control','no-store').json({url:checkout.url});
    }catch{fail(res,502,'Could not create course checkout.');}
  });
  app.post(base+'/claim',async(req,res)=>{
    if(!secret||!stripeClient){fail(res,503,'Course access is not configured.');return;}
    const id=String(req.body?.session_id||'').trim();
    if(!/^cs_(test_)?[A-Za-z0-9]+$/.test(id)||id.length>180){fail(res,400,'Invalid checkout reference.');return;}
    try{
      const checkout=await stripeClient.checkout.sessions.retrieve(id);
      if(checkout?.mode!=='payment'||checkout.payment_status!=='paid'||checkout.metadata?.course!==COURSE
        ||checkout.amount_total!==499||String(checkout.currency).toLowerCase()!=='gbp'){fail(res,403,'No verified course purchase found.');return;}
      const cookie=signSession({course:COURSE,id,exp:Math.floor(Date.now()/1000)+TTL},secret);
      res.cookie(COOKIE,cookie,{httpOnly:true,secure:true,sameSite:'lax',path:'/api/cpd/module-02',maxAge:TTL*1000});
      res.set('Cache-Control','no-store').json({paidAccess:true});
    }catch{fail(res,400,'Purchase verification failed.');}
  });
  app.get(base+'/video/:lesson',async(req,res)=>{
    let user=null;try{user=await ownedSession(req);}catch{}
    if(!user){fail(res,401,'A verified purchase is required to watch this video.');return;}
    const n=Number(req.params.lesson);
    if(!Number.isInteger(n)||n<1||n>3){fail(res,404,'Lesson not found.');return;}
    const file=path.join(root,FILES[n-1]);
    let size;
    try{size=fs.statSync(file).size;}catch{fail(res,404,'Video not yet hosted.');return;}
    if(size<=0){fail(res,404,'Video unavailable.');return;}
    res.set({'Content-Type':'video/mp4','Accept-Ranges':'bytes','Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'});
    const range=String(req.headers.range||'');
    if(range){
      const m=/^bytes=(\d*)-(\d*)$/.exec(range);
      if(!m||(m[1]===''&&m[2]==='')){res.set('Content-Range','bytes */'+size).status(416).end();return;}
      let start,end;
      if(m[1]===''){const suffix=Number(m[2]);start=Math.max(0,size-suffix);end=size-1;}
      else{start=Number(m[1]);end=m[2]?Number(m[2]):size-1;}
      if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start<0||start>=size||start>end){res.set('Content-Range','bytes */'+size).status(416).end();return;}
      end=Math.min(end,size-1);
      res.status(206).set({'Content-Range':'bytes '+start+'-'+end+'/'+size,'Content-Length':String(end-start+1)});
      fs.createReadStream(file,{start,end}).on('error',()=>res.destroy()).pipe(res);
    }else{
      res.set('Content-Length',String(size));
      fs.createReadStream(file).on('error',()=>res.destroy()).pipe(res);
    }
  });
  app.get(base+'/questions',async(req,res)=>{
    const section=String(req.query.section||'');
    if(!['check-1','check-2','final'].includes(section)){fail(res,400,'Unknown assessment.');return;}
    res.set('Cache-Control','no-store').json({section,questions:questionBank.filter(x=>x.section===section)
      .map(x=>({id:x.id,question:x.question,options:x.options}))});
  });
  app.post(base+'/assessment',async(req,res)=>{
    let user=null;try{user=await ownedSession(req);}catch{}
    if(!user){fail(res,401,'Purchase required for graded assessments.');return;}
    const section=String(req.body?.section||'');
    if(!['check-1','check-2','final'].includes(section)){fail(res,400,'Invalid assessment section.');return;}
    const questions=questionBank.filter(x=>x.section===section),answers=req.body?.answers;
    if(!Array.isArray(answers)||answers.length!==questions.length||answers.some(x=>!Number.isInteger(x)||x<0||x>3)){
      fail(res,400,'Answer all questions before submitting.');return;
    }
    const score=questions.reduce((sum,q,i)=>sum+Number(q.correct_option_index===answers[i]),0);
    const pass=section==='final'&&score>=8;
    const feedback=questions.map((q,i)=>({
      questionId:q.id,correct:q.correct_option_index===answers[i],
      correctAnswerIndex:q.correct_option_index,explanation:q.explanation
    }));
    if(pass){
      const folder=path.join(root,'completions');
      fs.mkdirSync(folder,{recursive:true,mode:0o700});
      const file=path.join(folder,crypto.createHash('sha256').update(user.id).digest('hex')+'.json');
      if(!fs.existsSync(file)){
        const record={course:COURSE,sessionId:user.id,learnerName:user.name,learnerEmail:user.email,
          completedAt:new Date().toISOString(),score:score,total:10};
        const tmp=file+'.'+crypto.randomBytes(8).toString('hex')+'.tmp';
        fs.writeFileSync(tmp,JSON.stringify(record,null,2),{mode:0o600,flag:'wx'});
        fs.renameSync(tmp,file);
      }
    }
    res.set('Cache-Control','no-store').json({score,total:questions.length,pass,feedback,certificateAvailable:pass});
  });
  app.get(base+'/certificate',async(req,res)=>{
    let user=null;try{user=await ownedSession(req);}catch{}
    if(!user){fail(res,401,'Course access required.');return;}
    const file=path.join(root,'completions',crypto.createHash('sha256').update(user.id).digest('hex')+'.json');
    let record;try{record=JSON.parse(fs.readFileSync(file,'utf8'));}catch{fail(res,403,'Pass the final assessment to earn a certificate.');return;}
    if(record.sessionId!==user.id||record.course!==COURSE||record.score<8){fail(res,403,'No verified completion.');return;}
    const id=crypto.createHash('sha256').update(user.id).digest('hex').slice(0,14).toUpperCase();
    const pdf=simplePdf(['ATHLYRAX EDUCATION','Certificate of Completion',String(record.learnerName).slice(0,75),
      'CPD 01 - Module 02: Our Body, Our Engine',
      'Completed: '+new Date(record.completedAt).toISOString().slice(0,10)+'  |  Result: '+record.score+'/10',
      'Certificate ID: AX-'+id]);
    res.set({'Content-Type':'application/pdf','Content-Disposition':'attachment; filename="athlyrax-module-02-certificate.pdf"','Cache-Control':'private,no-store','Content-Length':String(pdf.length)}).send(pdf);
  });
  // Coach owner uploads each original MP4 without exposing it through Netlify public assets.
  app.get(base+'/admin/videos',requireStrictAuth,requireSoftwareOwnerRole,(req,res)=>{
    res.set('Cache-Control','no-store').json({lessons:FILES.map((f,i)=>{
      try {return {lesson:i+1,uploaded:fs.statSync(path.join(root,f)).size>1024};}
      catch{return {lesson:i+1,uploaded:false};}
    })});
  });
  app.post(base+'/admin/video/:lesson',requireStrictAuth,requireSoftwareOwnerRole,(req,res)=>{
    const n=Number(req.params.lesson),encoded=req.body?.base64;
    if(!Number.isInteger(n)||n<1||n>3||typeof encoded!=='string'||encoded.length>22*1024*1024
      ||!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)){fail(res,400,'Invalid MP4 upload.');return;}
    const buffer=Buffer.from(encoded,'base64');
    if(buffer.length<1024||buffer.length>16*1024*1024||buffer.toString('ascii',4,8)!=='ftyp'){
      fail(res,400,'Upload a valid MP4 file under 16 MB.');return;
    }
    try{
      fs.mkdirSync(root,{recursive:true,mode:0o700});
      const file=path.join(root,FILES[n-1]),tmp=file+'.'+crypto.randomBytes(8).toString('hex')+'.tmp';
      fs.writeFileSync(tmp,buffer,{mode:0o600,flag:'wx'});fs.renameSync(tmp,file);
      res.set('Cache-Control','no-store').json({saved:true,lesson:n,bytes:buffer.length});
    }catch{fail(res,500,'Video could not be saved.');}
  });
}
