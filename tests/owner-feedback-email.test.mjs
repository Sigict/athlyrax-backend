import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
const patch=fs.readFileSync('scripts/patch-owner-feedback-email.mjs','utf8');
const built=fs.readFileSync('index.js','utf8');
const build=fs.readFileSync('scripts/build-production-backend.mjs','utf8');
test('canonical feedback patch and build contract',()=>{
 for(const token of ["ATHLYRAX_OWNER_FEEDBACK_EMAIL_V1","app.post('/feedback'","app.get('/feedback'","app.patch('/feedback/:id/decision'","feedbackPathFor","sendOwnerFeedbackNotification","FEEDBACK_OWNER_EMAIL","AthlyraX@outlook.com"]) {
  assert.ok(patch.includes(token),token);
  assert.ok(built.includes(token),'built backend missing '+token);
 }
 assert.ok(build.includes("run('canonical owner feedback email', ['scripts/patch-owner-feedback-email.mjs']);"));
});
test('feedback save precedes response and notification',()=>{
 const begin=built.indexOf("app.post('/feedback',");
 const end=built.indexOf("app.get('/feedback',",begin);
 const post=built.slice(begin,end);
 assert.ok(post.indexOf("writeAtomicJsonFile(filePath, rows);") < post.indexOf("res.status(201).json({ ok: true, row });"));
 assert.ok(post.indexOf("res.status(201).json({ ok: true, row });") < post.indexOf("void sendOwnerFeedbackNotification(row);"));
 assert.ok(post.includes("enqueueWrite("));
});
test('non owners cannot read inbox or change decisions',()=>{
 const get=built.slice(built.indexOf("app.get('/feedback',"),built.indexOf("app.patch('/feedback/:id/decision',"));
 assert.ok(get.includes("if (!isPrimarySoftwareOwnerAccount(req.auth))"));
 assert.ok(get.includes("rows: [], inboxVisibility: 'owner-only'"));
 const patchRoute=built.slice(built.indexOf("app.patch('/feedback/:id/decision',"),built.indexOf("app.post('/snapshot/instant',"));
 assert.ok(patchRoute.includes("requireSoftwareOwnerRole"));
 assert.ok(patchRoute.includes("if (!isPrimarySoftwareOwnerAccount(req.auth))"));
});
test('mail is optional and owner notification contains useful context',()=>{
 assert.ok(built.includes("if (!AUTH_SMTP_HOST || !AUTH_SMTP_FROM)"));
 for(const token of ['row.createdBy','row.createdRole','row.tenantKey','row.createdAt','row.topic','row.description']) assert.ok(built.includes(token),token);
 assert.ok(built.includes("console.warn('[feedback-email] Delivery failed; feedback remains saved:"));
});
