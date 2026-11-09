import express from 'express';
import fs from 'fs';
import path from 'path';

// Public partner presentation media, managed only by the primary software owner.
// Media is intentionally public; upload and replacement are private.
export function registerPartnerVideo(app,{storageRoot,requireStrictAuth,requireSoftwareOwnerRole}){
  const dir=path.join(storageRoot,'public-media','partner-video');
  const video=path.join(dir,'athlyrax-partner-presentation.mp4');
  const tmp=video+'.upload';
  const MAX_VIDEO=300*1024*1024, MAX_CHUNK=8*1024*1024;
  const noStore=(res)=>res.set('Cache-Control','no-store');
  const size=()=>{try{const st=fs.statSync(video);return st.isFile()&&st.size>1024?st.size:0}catch{return 0}};
  app.get('/media/partner-video/status',(_req,res)=>noStore(res).json({ready:size()>0}));
  app.get('/media/partner-video',(req,res)=>{
    const total=size();
    if(!total)return res.status(404).set('Cache-Control','no-store').send('Partner video not published');
    const range=req.headers.range;
    res.set({'Content-Type':'video/mp4','Accept-Ranges':'bytes','Cache-Control':'public, max-age=300'});
    if(!range){res.set('Content-Length',String(total));return fs.createReadStream(video).pipe(res)}
    const m=/^bytes=(\d*)-(\d*)$/.exec(String(range));
    if(!m||(m[1]===''&&m[2]===''))return res.status(416).set('Content-Range','bytes */'+total).end();
    let start,end;
    if(m[1]===''){const suffix=Number(m[2]);if(!Number.isSafeInteger(suffix)||suffix<=0)return res.status(416).set('Content-Range','bytes */'+total).end();start=Math.max(0,total-suffix);end=total-1}
    else{start=Number(m[1]);end=m[2]?Number(m[2]):total-1}
    if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start>=total||end<start)return res.status(416).set('Content-Range','bytes */'+total).end();
    end=Math.min(end,total-1);
    res.status(206).set({'Content-Range':`bytes ${start}-${end}/${total}`,'Content-Length':String(end-start+1)});
    return fs.createReadStream(video,{start,end}).pipe(res);
  });
  app.get('/media/partner-video/admin/status',requireStrictAuth,requireSoftwareOwnerRole,(_req,res)=>noStore(res).json({ready:size()>0,bytes:size()}));
  app.put('/media/partner-video/admin/upload',requireStrictAuth,requireSoftwareOwnerRole,express.raw({type:'application/octet-stream',limit:MAX_CHUNK}),(req,res)=>{
    const offset=Number(req.query.offset),total=Number(req.query.total),body=Buffer.isBuffer(req.body)?req.body:null;
    if(!body||!body.length||body.length>MAX_CHUNK||!Number.isSafeInteger(offset)||offset<0||!Number.isSafeInteger(total)||total<1024||total>MAX_VIDEO||offset+body.length>total)
      return res.status(400).json({error:'Invalid upload chunk'});
    try{
      fs.mkdirSync(dir,{recursive:true,mode:0o700});
      if(offset===0){
        if(body.length<12||body.toString('ascii',4,8)!=='ftyp')return res.status(400).json({error:'Not a valid MP4'});
        const space=fs.statfsSync(storageRoot);if(space.bavail*space.bsize<total+100*1024*1024)return res.status(507).json({error:'Insufficient storage'});
        fs.writeFileSync(tmp,body,{mode:0o600});
      }else{
        let exists=-1;try{exists=fs.statSync(tmp).size}catch{}
        if(exists!==offset)return res.status(409).json({error:'Upload offset mismatch',expectedOffset:Math.max(0,exists)});
        fs.appendFileSync(tmp,body);
      }
      const received=fs.statSync(tmp).size;
      if(received===total){fs.renameSync(tmp,video);return noStore(res).json({received,total,done:true})}
      return noStore(res).json({received,total,done:false});
    }catch{return res.status(500).json({error:'Could not store video'})}
  });
}
