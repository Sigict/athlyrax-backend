import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { buildCertificatePdf } from './cpd-module02.mjs';

// Owner-only preview. No course sales, buyer entitlements, or publicly valid
// certificates are created by these routes.
const DIR=path.dirname(fileURLToPath(import.meta.url));
const ROOT_NAME='module-03';
const LESSONS=[
  {n:1,title:'Design the Stimulus',duration:'Video 1'},
  {n:2,title:'Match the Stimulus',duration:'Video 2'},
  {n:3,title:'Coach the Response',duration:'Video 3'}
];
const SECTIONS={'check-1':1,'check-2':2,'check-3':3,final:3};
const SEND_LIMIT=4*1024*1024;
const WATCh=0.8;
const fail=(res,code,error)=>res.status(code).set('Cache-Control','no-store').json({error});
const nocache=(res)=>res.set('Cache-Control','no-store');
function ranges(list) {
  const out=[];
  for(const [a,b] of list.filter(x=>Array.isArray(x)&&x.length===2).sort((a,b)=>a[0]-b[0])) {
    const last=out[out.length-1];
    if(last&&a<=last[1]+1)last[1]=Math.max(b,last[1]);else out.push([a,b]);
  }
  return out;
}
function covered(list){return list.reduce((s,[a,b])=>s+b-a+1,0);}
export function registerCpdModule03Preview(app,{storageRoot,requireStrictAuth,requireSoftwareOwnerRole}) {
  const root=path.join(storageRoot,'cpd',ROOT_NAME);
  const base='/cpd/module-03/owner';
  const guards=[requireStrictAuth,requireSoftwareOwnerRole];
  const bank=JSON.parse(fs.readFileSync(path.join(DIR,'cpd-module03-private-questions.json'),'utf8')).questions;
  if(bank.length!==19||Object.entries(SECTIONS).some(([s])=>bank.filter(q=>q.section===s).length!==(s==='final'?10:3)))
    throw new Error('Module 03 questions missing or invalid');
  const progressPath=path.join(root,'owner-preview-progress.json');
  const videoPath=(n)=>path.join(root,`lesson-${n}.mp4`);
  const videoSize=(n)=>{try{return fs.statSync(videoPath(n)).size;}catch{return 0;}};
  const blank=()=>({lessons:[],checks:[],watched:{1:[],2:[],3:[]},bestFinal:0,finalAttempts:0,certificate:null});
  function load(){
    try {
      const x=JSON.parse(fs.readFileSync(progressPath,'utf8'));
      return x&&Array.isArray(x.lessons)&&Array.isArray(x.checks)&&x.watched?{...blank(),...x}:blank();
    }catch{return blank();}
  }
  function save(p){
    fs.mkdirSync(root,{recursive:true,mode:0o700});
    const tmp=progressPath+'.'+crypto.randomBytes(6).toString('hex')+'.tmp';
    fs.writeFileSync(tmp,JSON.stringify(p),{mode:0o600,flag:'wx'});
    fs.renameSync(tmp,progressPath);
  }
  function percent(p,n){const size=videoSize(n);return size?Math.round(100*Math.min(1,covered(p.watched[n]||[])/size)):0;}
  function view(p){return {lessons:p.lessons,checks:p.checks,watched:Object.fromEntries(LESSONS.map(x=>[x.n,percent(p,x.n)])),bestFinal:p.bestFinal,finalAttempts:p.finalAttempts};}
  function unlocked(p,section){
    const n=SECTIONS[section];
    if(!n||!p.lessons.includes(n))return false;
    if(section==='final')return p.lessons.length===3&&['check-1','check-2','check-3'].every(s=>p.checks.includes(s));
    return true;
  }
  app.get(base+'/status',...guards,(_req,res)=>{
    const p=load();
    nocache(res).json({course:'cpd01-module03',title:'Swimming Set Design — From Purpose to Practice',
      price:{amount:499,currency:'gbp'},salesEnabled:false,testMode:true,ownerPreview:true,
      paidAccess:true,learner:{name:'AthlyraX Owner Preview',email:'owner preview'},accessRevoked:'',
      lessons:LESSONS,progress:view(p),certificate:p.certificate?{id:p.certificate.id,score:p.certificate.score}:null});
  });
  app.get(base+'/video/:lesson',...guards,(req,res)=>{
    const n=Number(req.params.lesson), size=videoSize(n);
    if(!Number.isInteger(n)||n<1||n>3||!size)return fail(res,404,'Lesson video not uploaded.');
    let from=0,to=Math.min(size-1,SEND_LIMIT-1);
    const header=String(req.headers.range||'');
    if(header){
      const m=/^bytes=(\d*)-(\d*)$/.exec(header);
      if(!m||(!m[1]&&!m[2]))return res.status(416).end();
      if(!m[1]){from=Math.max(0,size-Number(m[2]));to=size-1;}
      else{from=Number(m[1]);to=m[2]?Math.min(size-1,Number(m[2])):size-1;}
      if(!Number.isSafeInteger(from)||!Number.isSafeInteger(to)||from<0||from>=size||to<from)return res.status(416).end();
      to=Math.min(to,from+SEND_LIMIT-1);
    }
    const p=load();
    p.watched[n]=ranges([...(p.watched[n]||[]),[from,to]]);
    save(p);
    res.status(206).set({'Content-Type':'video/mp4','Accept-Ranges':'bytes','Content-Range':`bytes ${from}-${to}/${size}`,
      'Content-Length':String(to-from+1),'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'});
    fs.createReadStream(videoPath(n),{start:from,end:to}).on('error',()=>res.destroy()).pipe(res);
  });
  app.get(base+'/questions',...guards,(req,res)=>{
    const section=String(req.query.section||''),p=load();
    if(!SECTIONS[section])return fail(res,400,'Unknown assessment.');
    if(!unlocked(p,section))return fail(res,409,'Complete the preceding lessons and checks first.');
    nocache(res).json({section,questions:bank.filter(q=>q.section===section).map(q=>({id:q.id,question:q.question,options:q.options}))});
  });
  app.post(base+'/lesson-complete',...guards,(req,res)=>{
    const n=Number(req.body?.lesson),p=load();
    if(!Number.isInteger(n)||n<1||n>3)return fail(res,400,'Invalid lesson.');
    if(n>1&&!p.checks.includes('check-'+(n-1)))return fail(res,409,'Complete the prior knowledge check first.');
    if(percent(p,n)<80)return fail(res,409,'Watch the whole lesson before continuing.');
    if(!p.lessons.includes(n))p.lessons.push(n);
    p.lessons.sort();save(p);nocache(res).json(view(p));
  });
  app.post(base+'/assessment',...guards,(req,res)=>{
    const section=String(req.body?.section||''),p=load();
    if(!SECTIONS[section])return fail(res,400,'Unknown assessment.');
    if(!unlocked(p,section))return fail(res,409,'Complete the preceding lessons and checks first.');
    const qs=bank.filter(q=>q.section===section), answers=req.body?.answers;
    if(!Array.isArray(answers)||answers.length!==qs.length||answers.some(a=>!Number.isInteger(a)||a<0||a>3))return fail(res,400,'Answer every question.');
    const score=qs.reduce((sum,q,i)=>sum+(q.correct_option_index===answers[i]?1:0),0);
    if(section!=='final'){
      if(!p.checks.includes(section))p.checks.push(section);
      save(p);
      return nocache(res).json({section,score,total:qs.length,feedback:qs.map((q,i)=>({
        questionId:q.id,correct:q.correct_option_index===answers[i],correctAnswerIndex:q.correct_option_index,explanation:q.explanation
      }))});
    }
    p.finalAttempts++;
    p.bestFinal=Math.max(p.bestFinal,score);
    const pass=score>=8;
    if(pass&&!p.certificate)p.certificate={id:'AXE-M03-PREVIEW',score,completedAt:new Date().toISOString()};
    save(p);
    nocache(res).json({section,score,total:10,pass,passMark:8,attempts:p.finalAttempts,
      certificate:p.certificate?{id:p.certificate.id}:null});
  });
  app.get(base+'/certificate',...guards,(_req,res)=>{
    const p=load();
    if(!p.certificate)return fail(res,403,'Pass the final assessment first.');
    let logoJpeg=null;
    try{logoJpeg=fs.readFileSync(path.join(DIR,'cpd-assets','athlyrax-logo.jpg'));}catch{}
    const pdf=buildCertificatePdf({name:'Owner Preview — Not an issued certificate',
      completedAt:p.certificate.completedAt,certificateId:'AXE-M03-PREVIEW',score:p.certificate.score,
      verifyUrl:'NOT VALID FOR PUBLIC VERIFICATION',logoJpeg,
      courseHeading:'CPD 01 - Module 03: Swimming Set Design',
      courseSubtitle:'From Purpose to Practice',
      courseSummary:'Three video lessons, three knowledge checks and a final assessment',
      preview:true});
    res.set({'Content-Type':'application/pdf','Cache-Control':'private, no-store',
      'Content-Disposition':'attachment; filename="AthlyraX-Module03-OWNER-PREVIEW.pdf"'}).send(pdf);
  });
  app.get(base+'/verify/:id',...guards,(_req,res)=>nocache(res).json({valid:false,preview:true}));
  app.post(base+'/logout',...guards,(_req,res)=>nocache(res).json({ok:true}));
}
