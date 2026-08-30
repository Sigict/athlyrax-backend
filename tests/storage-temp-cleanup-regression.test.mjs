import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { installDataSafetyGuards } from '../scripts/data-safety-preload.mjs';
function tempDir(prefix){ return fs.mkdtempSync(path.join(os.tmpdir(),prefix)); }
function writeJson(filePath,value){ fs.mkdirSync(path.dirname(filePath),{recursive:true}); fs.writeFileSync(filePath,`${JSON.stringify(value)}\n`,'utf8'); }
test('any guarded DB rejection deletes only its atomic temp source',{concurrency:false},()=>{
  const root=tempDir('athlyrax-temp-cleanup-');
  const storageRoot=path.join(root,'storage');
  const tenantDir=path.join(storageRoot,'tenants','clubs','demo-company');
  const destination=path.join(tenantDir,'db.json');
  const source=path.join(tenantDir,'db.json.123.456.tmp');
  const unrelated=path.join(tenantDir,'keep.tmp');
  writeJson(destination,{swimmers:[{id:'keep'}],__meta:{tenantId:'demo-company',storageRevision:20}});
  writeJson(source,{swimmers:[{id:'new'}],__meta:{tenantId:'other-company',storageRevision:20}});
  fs.writeFileSync(unrelated,'keep');
  const installation=installDataSafetyGuards({fsModule:fs,env:{NODE_ENV:'production',ATHLYRAX_STORAGE_ROOT:storageRoot},logger:{info(){},error(){}}});
  try{
    assert.throws(()=>fs.renameSync(source,destination));
    assert.equal(fs.existsSync(source),false);
    assert.equal(fs.existsSync(unrelated),true);
    assert.equal(JSON.parse(fs.readFileSync(destination,'utf8')).swimmers[0].id,'keep');
  }finally{ installation.uninstall(); fs.rmSync(root,{recursive:true,force:true}); }
});
test('backup retention pre-prunes before repeated protected writes',{concurrency:false},()=>{
  const root=tempDir('athlyrax-backup-preprune-');
  const storageRoot=path.join(root,'storage');
  const tenantDir=path.join(storageRoot,'tenants','clubs','demo-company');
  const destination=path.join(tenantDir,'db.json');
  writeJson(destination,{swimmers:[{id:'old'}],__meta:{tenantId:'demo-company',storageRevision:1}});
  const backupRoot=path.join(root,'backups');
  const installation=installDataSafetyGuards({fsModule:fs,env:{NODE_ENV:'production',ATHLYRAX_STORAGE_ROOT:storageRoot,ATHLYRAX_SAFETY_BACKUP_ROOT:backupRoot,ATHLYRAX_SAFETY_MAX_BACKUPS:'2'},logger:{info(){},error(){}}});
  try{
    for(let i=1;i<=4;i+=1){ const current=JSON.parse(fs.readFileSync(destination,'utf8')); const source=path.join(tenantDir,`db.json.${i}.tmp`); writeJson(source,{...current,swimmers:[{id:`v${i}`}]}); fs.renameSync(source,destination); }
    const preWriteRoot=path.join(backupRoot,'pre-write'); const scope=fs.readdirSync(preWriteRoot)[0]; const files=fs.readdirSync(path.join(preWriteRoot,scope));
    assert.ok(files.length<=2,`expected <=2 backups, found ${files.length}`);
    assert.equal(JSON.parse(fs.readFileSync(destination,'utf8')).swimmers[0].id,'v4');
  }finally{ installation.uninstall(); fs.rmSync(root,{recursive:true,force:true}); }
});
