import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { applyUndatedCleanup, planUndatedCleanup } from './db-write-validation.mjs';

function parseArgs(argv) {
  const out = {
    input: '',
    report: '',
    outputDb: '',
    apply: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--input') out.input = String(argv[i + 1] || '');
    if (arg === '--report') out.report = String(argv[i + 1] || '');
    if (arg === '--output-db') out.outputDb = String(argv[i + 1] || '');
    if (arg === '--apply') out.apply = true;
  }
  return out;
}

function sha256Text(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.input) {
    throw new Error('Missing --input <db.json path>.');
  }
  const inputPath = path.resolve(args.input);
  const raw = fs.readFileSync(inputPath, 'utf8');
  const normalizedRaw = raw.replace(/^\uFEFF/, '');
  const db = JSON.parse(normalizedRaw || '{}');

  const plan = planUndatedCleanup(db);
  const report = {
    generatedAt: new Date().toISOString(),
    mode: args.apply ? 'apply' : 'dry-run',
    inputPath,
    inputHashSha256: sha256Text(normalizedRaw),
    counts: plan.counts,
    trulyUndatedSessionCount: plan.trulyUndatedSessions.length,
    trulyUndatedSessionIds: plan.deleteSessionIds,
    trulyUndatedChildSetCount: plan.deleteSetCount,
    proposedDeleteSessionCount: plan.deleteSessionCount,
    proposedDeleteSetCount: plan.deleteSetCount,
    remainingOrphanSetCountAfterDelete: plan.remainingOrphanSetCountAfterDelete,
    trulyUndatedSessions: plan.trulyUndatedSessions,
  };

  if (args.apply) {
    const { cleanedDb, report: applyReport } = applyUndatedCleanup(db);
    report.applied = {
      deletedSessionCount: applyReport.deletedSessionCount,
      deletedChildSetCount: applyReport.deletedChildSetCount,
      remainingOrphanSetCount: applyReport.remainingOrphanSetCount,
      postHashSha256: applyReport.postHashSha256,
    };
    if (args.outputDb) {
      const outputDbPath = path.resolve(args.outputDb);
      fs.mkdirSync(path.dirname(outputDbPath), { recursive: true });
      fs.writeFileSync(outputDbPath, `${JSON.stringify(cleanedDb, null, 2)}\n`, 'utf8');
      report.outputDbPath = outputDbPath;
    }
  }

  const reportPath = path.resolve(args.report || `undated-session-cleanup-report-${Date.now()}.json`);
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

  process.stdout.write(`${JSON.stringify({ ok: true, reportPath, mode: report.mode }, null, 2)}\n`);
}

main();
