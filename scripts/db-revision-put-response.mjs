const INSTALL_MARK = Symbol.for('athlyrax.dbRevisionPutResponseInstalled');

function parseRevision(value) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

export function installDbRevisionPutResponse(expressModule, options = {}) {
  const responsePrototype = expressModule?.response;
  if (!responsePrototype || typeof responsePrototype.send !== 'function') {
    throw new Error('Express response prototype is required.');
  }
  if (responsePrototype[INSTALL_MARK]) return responsePrototype[INSTALL_MARK];

  const logger = options.logger || console;
  const originalSend = responsePrototype.send;
  responsePrototype.send = function guardedPutDbSend(body) {
    try {
      const requestPath = String(this?.req?.originalUrl || this?.req?.url || '').split('?')[0];
      const successfulDbWrite = String(this?.req?.method || '').toUpperCase() === 'PUT'
        && requestPath === '/db'
        && Number(this?.statusCode || 200) >= 200
        && Number(this?.statusCode || 200) < 300;

      if (successfulDbWrite) {
        const wasBuffer = Buffer.isBuffer(body);
        const wasString = typeof body === 'string' || wasBuffer;
        const raw = wasBuffer ? body.toString('utf8') : body;
        const parsed = wasString ? JSON.parse(String(raw || '{}')) : raw;
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          const incomingRevision = parseRevision(this?.req?.body?.__meta?.storageRevision) ?? 0;
          const explicitRevision = parseRevision(parsed?.storageRevision);
          const revision = explicitRevision
            ?? (parsed?.staleWriteIgnored === true ? incomingRevision : incomingRevision + 1);
          const payload = { ...parsed, storageRevision: revision };
          this.setHeader?.('X-AthlyraX-DB-Revision', String(revision));
          body = wasString ? `${JSON.stringify(payload)}\n` : payload;
        }
      }
    } catch (error) {
      logger.error(
        `[data-safety] Could not attach storage revision to PUT /db: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    return originalSend.call(this, body);
  };

  const installation = Object.freeze({
    installed: true,
    uninstall() {
      responsePrototype.send = originalSend;
      delete responsePrototype[INSTALL_MARK];
    },
  });
  Object.defineProperty(responsePrototype, INSTALL_MARK, {
    configurable: true,
    enumerable: false,
    value: installation,
  });
  return installation;
}
