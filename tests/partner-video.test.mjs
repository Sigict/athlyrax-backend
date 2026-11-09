import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { registerPartnerVideo } from '../partner-video.mjs';

async function setup(){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'athlyrax-partner-'));
  const app=express();
  const guard=(req,res,next)=>{if(req.headers['x-test-role']==='owner')return next();res.status(req.headers['x-test-role']==='coach'?403:401).end()};
  registerPartnerVideo(app,{storageRoot:root,requireStrictAuth:guard,requireSoftwareOwnerRole:guard});
  const server=app.listen(0,'127.0.0.1');
  await new Promise(r=>server.once('listening',r));
  return {root,url:'http://127.0.0.1:'+server.address().port,close:async()=>{await new Promise(r=>server.close(r));fs.rmSync(root,{force:true,recursive:true})}};
}
test('video is unavailable until uploaded, no unauthorised writes',async()=>{
  const x=await setup();
  try{
    assert.deepEqual(await (await fetch(x.url+'/media/partner-video/status')).json(),{ready:false});
    assert.equal((await fetch(x.url+'/media/partner-video')).status,404);
    const bytes=Buffer.alloc(2048);bytes.write('ftypisom',4,'ascii');
    for(const [role,status] of [[null,401],['coach',403]]){
      const response=await fetch(x.url+'/media/partner-video/admin/upload?offset=0&total=2048',{method:'PUT',headers:{'Content-Type':'application/octet-stream',...(role?{'x-test-role':role}:{})},body:bytes});
      assert.equal(response.status,status);
    }
  }finally{await x.close()}
});
test('owner uploads MP4 and public client can request byte ranges',async()=>{
  const x=await setup();
  try{
    const bytes=Buffer.alloc(3000);bytes.write('ftypisom',4,'ascii');
    const url=x.url+'/media/partner-video/admin/upload?total=3000&offset=';
    const headers={'Content-Type':'application/octet-stream','x-test-role':'owner'};
    let r=await fetch(url+'0',{method:'PUT',headers,body:bytes.subarray(0,1500)});
    assert.equal(r.status,200);assert.equal((await r.json()).done,false);
    r=await fetch(url+'1500',{method:'PUT',headers,body:bytes.subarray(1500)});
    assert.equal(r.status,200);assert.equal((await r.json()).done,true);
    assert.deepEqual(await (await fetch(x.url+'/media/partner-video/status')).json(),{ready:true});
    const video=await fetch(x.url+'/media/partner-video',{headers:{Range:'bytes=100-299'}});
    assert.equal(video.status,206);assert.equal(video.headers.get('content-range'),'bytes 100-299/3000');assert.equal((await video.arrayBuffer()).byteLength,200);
    const suffix=await fetch(x.url+'/media/partner-video',{headers:{Range:'bytes=-100'}});
    assert.equal(suffix.status,206);assert.equal((await suffix.arrayBuffer()).byteLength,100);
    const invalid=await fetch(x.url+'/media/partner-video',{headers:{Range:'bytes=3000-4000'}});
    assert.equal(invalid.status,416);
  }finally{await x.close()}
});
