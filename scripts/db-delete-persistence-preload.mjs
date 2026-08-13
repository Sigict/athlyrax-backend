const PATCH_MARKER = Symbol.for('athlyrax.dbDeletePersistenceInstalled');

function stampDbWrite(req, res, next) {
  const body = req?.body;
  if (body && typeof body === 'object' && !Array.isArray(body)) {
    const now = new Date().toISOString();
    req.body = {
      ...body,
      __meta: {
        ...(body.__meta && typeof body.__meta === 'object' && !Array.isArray(body.__meta) ? body.__meta : {}),
        updatedAt: now,
      },
    };
  }
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  next();
}

function markDbRead(_req, res, next) {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  const commit = String(process.env.RENDER_GIT_COMMIT || process.env.GIT_COMMIT || '').trim();
  if (commit) res.setHeader('X-AthlyraX-Backend-Commit', commit);
  next();
}

export function installDbDeletePersistenceGuard(expressModule) {
  const application = expressModule?.application;
  if (!application || typeof application.get !== 'function' || typeof application.put !== 'function') {
    throw new Error('Express application routing is unavailable for DB persistence guard.');
  }
  if (application[PATCH_MARKER]) return;

  const originalGet = application.get;
  const originalPut = application.put;

  application.get = function patchedGet(routePath, ...handlers) {
    if (String(routePath || '') === '/db') {
      return originalGet.call(this, routePath, markDbRead, ...handlers);
    }
    return originalGet.call(this, routePath, ...handlers);
  };

  application.put = function patchedPut(routePath, ...handlers) {
    if (String(routePath || '') === '/db') {
      return originalPut.call(this, routePath, stampDbWrite, ...handlers);
    }
    return originalPut.call(this, routePath, ...handlers);
  };

  Object.defineProperty(application, PATCH_MARKER, { value: true, configurable: false });
}
