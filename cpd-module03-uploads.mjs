import express from 'express';
import fs from 'fs';
import path from 'path';

// Module 03 staging uploader. Completely independent of Module 02 learner,
// video and payment storage. No course checkout or learner endpoints here.
const MAX_CHUNK = 8 * 1024 * 1024;
const MAX_VIDEO = 2 * 1024 * 1024 * 1024;
const noStore = (res) => res.set('Cache-Control', 'no-store');
const error = (res, code, message, extra = {}) => noStore(res).status(code).json({ error: message, ...extra });

export function registerCpdModule03Uploads(app, { storageRoot, requireStrictAuth, requireSoftwareOwnerRole }) {
  const root = path.join(storageRoot, 'cpd', 'module-03');
  const base = '/cpd/module-03/admin';
  const file = (n) => path.join(root, `lesson-${n}.mp4`);
  const validLesson = (n) => Number.isInteger(n) && n >= 1 && n <= 3;
  // Each route explicitly declares its authentication and owner role guards.

  app.get(base + '/videos', requireStrictAuth, requireSoftwareOwnerRole, (_req, res) => {
    const lessons = [1, 2, 3].map((n) => {
      let bytes = 0;
      try { const stat = fs.statSync(file(n)); if (stat.isFile()) bytes = stat.size; } catch {}
      return { lesson: n, bytes };
    });
    noStore(res).json({ module: 3, lessons, ready: lessons.every((l) => l.bytes > 1024), salesEnabled: false });
  });

  app.put(base + '/video/:lesson', requireStrictAuth, requireSoftwareOwnerRole,
    express.raw({ type: 'application/octet-stream', limit: MAX_CHUNK }),
    (req, res) => {
      const n = Number(req.params.lesson);
      const offset = Number(req.query.offset);
      const total = Number(req.query.total);
      const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      if (!validLesson(n) || !Number.isSafeInteger(offset) || !Number.isSafeInteger(total) ||
          offset < 0 || total < 1024 || total > MAX_VIDEO || !body.length ||
          body.length > MAX_CHUNK || offset + body.length > total) {
        return error(res, 400, 'Invalid video upload chunk.');
      }
      const dest = file(n);
      const staging = dest + '.upload';
      try {
        fs.mkdirSync(root, { recursive: true, mode: 0o700 });
        if (offset === 0) {
          if (body.length < 12 || body.toString('ascii', 4, 8) !== 'ftyp') {
            return error(res, 400, 'Choose a valid MP4 video.');
          }
          try {
            const disk = fs.statfsSync(storageRoot);
            if (disk.bavail * disk.bsize < total + 200 * 1024 * 1024) {
              return error(res, 507, 'Insufficient storage space for this video.');
            }
          } catch {}
          fs.writeFileSync(staging, body, { flag: 'w', mode: 0o600 });
        } else {
          let actual = -1;
          try { actual = fs.statSync(staging).size; } catch {}
          if (actual !== offset) return error(res, 409, 'Upload out of order.', { expectedOffset: Math.max(0, actual) });
          fs.appendFileSync(staging, body);
        }
        const received = fs.statSync(staging).size;
        if (received === total) {
          fs.renameSync(staging, dest);
          return noStore(res).json({ lesson: n, received, total, done: true });
        }
        return noStore(res).json({ lesson: n, received, total, done: false });
      } catch {
        return error(res, 500, 'Video could not be saved.');
      }
    });
}
