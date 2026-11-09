import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { registerCpdModule03Uploads } from '../cpd-module03-uploads.mjs';

async function serverForTest() {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'cpd03-'));
  const app=express();
  const guard=(req,res,next)=>{
    if(req.headers['x-test-role']==='owner') return next();
    res.status(req.headers['x-test-role']==='coach'?403:401).json({error:'owner only'});
  };
  registerCpdModule03Uploads(app,{storageRoot:dir,requireStrictAuth:guard,requireSoftwareOwnerRole:guard});
  const server=app.listen(0,'127.0.0.1');
  await new Promise(r=>server.once('listening',r));
  return {url:'http://127.0.0.1:'+server.address().port,dir,close:async()=>{
    await new Promise((r,j)=>server.close(e=>e?j(e):r()));fs.rmSync(dir,{recursive:true,force:true});
  }};
}
function sampleMp4(size=2048){const b=Buffer.alloc(size);b.writeUInt32BE(24,0);b.write('ftypisom',4,'ascii');return b;}
test('unauthenticated and coach users cannot read readiness or upload',async()=>{
  const x=await serverForTest();
  try{
    for(const [role,expected] of [[undefined,401],['coach',403]]){
      const headers=role?{'x-test-role':role}:{};
      assert.equal((await fetch(x.url+'/cpd/module-03/admin/videos',{headers})).status,expected);
      const upload=await fetch(x.url+'/cpd/module-03/admin/video/1?offset=0&total=2048',{method:'PUT',headers:{...headers,'Content-Type':'application/octet-stream'},body:sampleMp4()});
      assert.equal(upload.status,expected);
    }
    assert.equal(fs.existsSync(path.join(x.dir,'cpd','module-03','lesson-1.mp4')),false);
  }finally{await x.close();}
});
test('owner can upload in chunks and Module 02 remains untouched',async()=>{
  const x=await serverForTest();
  try{
    const opts={method:'PUT',headers:{'x-test-role':'owner','Content-Type':'application/octet-stream'}};
    const url=x.url+'/cpd/module-03/admin/video/2?total=2048&offset=';
    const mp4=sampleMp4();
    const a=await fetch(url+'0',{...opts,body:mp4.subarray(0,1024)});
    assert.equal(a.status,200);assert.equal((await a.json()).done,false);
    const b=await fetch(url+'1024',{...opts,body:mp4.subarray(1024)});
    assert.equal(b.status,200);assert.equal((await b.json()).done,true);
    const ready=await fetch(x.url+'/cpd/module-03/admin/videos',{headers:{'x-test-role':'owner'}});
    const d=await ready.json();
    assert.equal(d.salesEnabled,false);
    assert.equal(d.lessons.find(l=>l.lesson===2).bytes,2048);
    assert.equal(fs.existsSync(path.join(x.dir,'cpd','module-02')),false);
  }finally{await x.close();}
});
test('owner rejects non-MP4 first chunk, invalid lengths and unstarted offsets',async()=>{
  const x=await serverForTest();
  try{
    const headers={'x-test-role':'owner','Content-Type':'application/octet-stream'};
    for(const [url,body,code] of [
      ['/cpd/module-03/admin/video/1?offset=0&total=2048',Buffer.alloc(2048),400],
      ['/cpd/module-03/admin/video/4?offset=0&total=2048',sampleMp4(),400],
      ['/cpd/module-03/admin/video/1?offset=1024&total=2048',Buffer.alloc(1024),409]
    ]){
      const r=await fetch(x.url+url,{method:'PUT',headers,body});assert.equal(r.status,code);
    }
  }finally{await x.close();}
});
