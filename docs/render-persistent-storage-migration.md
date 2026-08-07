# AthlyraX production storage contract

This document describes the current production storage layout. The previous repository-storage symlink design is obsolete and must not be reintroduced.

## One canonical live root

Production mutable data lives only under the configured persistent root:

```text
ATHLYRAX_STORAGE_ROOT=/var/data/athlyrax
```

Canonical live paths:

```text
/var/data/athlyrax/db.json
/var/data/athlyrax/tenants/<tenant-id>/db.json
/var/data/athlyrax/auth/auth-users.json
/var/data/athlyrax/auth/auth-users.backup.json
/var/data/athlyrax/auth-invites.json
/var/data/athlyrax/legal-acceptances.jsonl
/var/data/athlyrax/trainingPlannerTargets.backup.json
/var/data/athlyrax/db-snapshots/
/var/data/athlyrax/billing-catalog.json
/var/data/athlyrax/billing-catalog-backups/
/var/data/athlyrax/snapshot-submissions.json
/var/data/athlyrax/auth-audit/
```

The demo tenant path is therefore:

```text
/var/data/athlyrax/tenants/demo-company/db.json
```

`tenants/clubs/<tenant-id>` is a legacy path and must never be used by runtime code.

## Repository storage is not live storage

`<source-root>/storage/` contains bundled recovery/seed material. It is not a production write target and is not symlinked to the persistent disk.

The bundled demo database may be used only by the guarded demo recovery routine when the canonical live demo database is missing or effectively empty. If a meaningful legacy demo database exists at the old `tenants/clubs/demo-company/db.json` location, it is preserved to the safety-backup root and preferred over the bundled seed so newer demo data is not discarded.

## Safety backup root

A separate configured directory is required:

```text
ATHLYRAX_SAFETY_BACKUP_ROOT=/var/data/athlyrax-safety
```

It must not equal or be nested inside the primary root. This protects against accidental replacement but is not independent disaster recovery. Keep an external encrypted backup as well.

## Fail-closed rules

Production refuses to start when:

- the primary or safety root is missing;
- either root points into `/opt/render/project`;
- the roots are equal or nested;
- `db.json` is missing;
- canonical `auth/auth-users.json` is missing;
- a required tenant database is missing;
- the storage-ready marker is absent or invalid;
- an auth or legal-record path environment override points somewhere other than the canonical location.

`GET /db` and `PUT /db` must not create an empty replacement for a missing existing tenant database. They return an error and record an audit event instead.

## Required production start

Use:

```text
npm start
```

`npm start` executes the storage-path tests and audit before `safe-start.mjs`. The install step also patches and verifies the production entrypoint so a direct `node index.js` production start still enforces the canonical persistent-storage guard.

There is no supported `start:unsafe` command.

## Pre-deploy verification

Run:

```text
npm run test:storage-all
npm run test:closed-pilot-security
npm run verify:closed-pilot-security
```

The storage audit must return:

```text
ATHLYRAX_STORAGE_PATH_AUDIT_OK
```

The storage safety check must return:

```text
ATHLYRAX_STORAGE_SAFETY_OK
```

Do not deploy if either check fails.
