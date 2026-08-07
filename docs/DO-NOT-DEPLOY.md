# Production deployment gate

The old pre-persistent-disk migration warning is obsolete. Use this file as the current deployment gate.

Do not deploy a backend commit unless all of the following are true:

- production uses one canonical persistent root via `ATHLYRAX_STORAGE_ROOT`;
- `ATHLYRAX_SAFETY_BACKUP_ROOT` is separate and non-nested;
- tenant databases resolve only to `tenants/<tenant-id>/db.json`;
- authentication resolves only to `auth/auth-users.json` and its canonical backup;
- no `tenants/clubs` runtime path remains after install-time entrypoint preparation;
- no root-level `auth-users.json` runtime path remains;
- missing existing tenant databases fail closed on both read and write;
- `start:unsafe` does not exist;
- `npm run test:storage-all` passes;
- `npm run audit:storage-paths` returns `ATHLYRAX_STORAGE_PATH_AUDIT_OK`;
- `npm run check:storage-safety` returns `ATHLYRAX_STORAGE_SAFETY_OK`;
- the production start command is `npm start`;
- `demo.coach` resolves to `demo-company` and its canonical database is non-empty.

A deployment that fails any of these checks must not be promoted as production-ready.
