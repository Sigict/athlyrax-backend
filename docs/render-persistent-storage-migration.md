# Render persistent-storage migration

Status: **preparation only**. This branch must not be merged or deployed until the live files have been copied and independently verified.

## What this change prepares

The current backend writes mutable data beneath the repository checkout. The migration branch adds:

- a fail-closed production start wrapper;
- explicit `ATHLYRAX_STORAGE_ROOT` and `ATHLYRAX_SAFETY_BACKUP_ROOT` validation;
- a runtime link from the repository `storage/` path to the mounted persistent root;
- canonical authentication paths beneath the persistent root;
- required-file and required-tenant checks;
- a signed-off storage-ready marker;
- pre-write database backups and stale-write protection;
- a staging-only restore tool for the API exports;
- a separate approval step before the storage root can be accepted as ready.

The wrapper does not deploy itself and does not migrate live data automatically.

## Current preserved API exports

The existing local backup contains distinct API exports for:

- `global-owner`;
- `demo-company`.

Those exports preserve the database payloads, but they do **not** preserve all filesystem-only records. Before production activation, the raw Render files must also be copied.

## Files that must be copied from the current Render filesystem

Copy these without displaying their contents:

- `storage/db.json`
- `storage/trainingPlannerTargets.backup.json`
- `storage/snapshot-submissions.json`
- `storage/auth-invites.json`
- `storage/billing-catalog.json`
- `storage/db-snapshots/`
- `storage/billing-catalog-backups/`
- `storage/auth-audit/`
- `storage/tenants/`
- `../storage/auth/auth-users.json`
- `../storage/auth/auth-users.backup.json`

The raw authentication files are essential because the API export intentionally excludes password hashes.

## Required safe sequence

1. Keep the existing API backup unchanged and copy it to a second independent location.
2. Upgrade the service only to obtain shell access. Do not change the start command yet.
3. From the still-running old deployment, create and download a complete archive of the filesystem paths listed above.
4. Verify the archive checksum outside Render.
5. Attach the persistent disk.
6. Restore the archived files into the chosen primary storage root.
7. Use the API exports only to cross-check or replace the global and tenant `db.json` files when their checksums and record counts have been reviewed.
8. Create the storage-ready marker with `approve-storage-layout.mjs`.
9. Run `npm run check:storage-safety`.
10. Only after the check returns `ATHLYRAX_STORAGE_SAFETY_OK`, merge this PR, configure the environment variables, change the Render start command and deploy.
11. Verify both tenants, authentication, Planner targets, snapshots, billing and audit history.
12. Perform one controlled restart and confirm the same checksums and record counts remain.

## Suggested production configuration

Example paths only; confirm the actual disk mount in Render:

```text
ATHLYRAX_STORAGE_ROOT=/var/data/athlyrax
ATHLYRAX_SAFETY_BACKUP_ROOT=/var/data/athlyrax-safety
ATHLYRAX_REQUIRED_TENANTS=demo-company
ATHLYRAX_CHECK_REQUIRE_FILES=true
```

The primary and safety roots must be different and must not be nested. Two directories on the same disk protect against an accidental database replacement, but they are not independent disaster recovery. Retain an encrypted external backup.

The wrapper automatically defaults these paths unless explicitly overridden:

```text
AUTH_USERS_PATH=$ATHLYRAX_STORAGE_ROOT/auth/auth-users.json
AUTH_USERS_BACKUP_PATH=$ATHLYRAX_STORAGE_ROOT/auth/auth-users.backup.json
```

Future Render start command:

```text
node scripts/safe-start.mjs
```

Do not change the current Render start command until the persistent root has been populated and approved.

## Stage the API exports locally

This command writes only to a new, empty local staging directory and refuses Render paths:

```powershell
node scripts/stage-storage-restore.mjs `
  --destination "C:\safe\athlyrax-storage-stage" `
  --global-db "C:\backup\global-owner-db.json" `
  --tenant "demo-company=C:\backup\demo-company-db.json" `
  --approve STAGE_ONLY
```

It deliberately does not create the production approval marker because the API export is incomplete by itself.

## Approve a complete restored storage root

After the raw authentication files and all required databases have been restored:

```text
node scripts/approve-storage-layout.mjs \
  --storage-root /var/data/athlyrax \
  --required-tenants demo-company \
  --approve CREATE_READY_MARKER
```

Then run:

```text
npm run check:storage-safety
```

The production wrapper refuses to start when:

- either root is missing;
- a root points into `/opt/render/project`;
- the roots are equal or nested;
- `db.json` is missing;
- `auth/auth-users.json` is missing;
- a required tenant database is missing;
- the storage-ready marker is absent or invalid.

## Rollback

Before activation, preserve:

- the full old filesystem archive;
- the API export folder and checksum manifest;
- the pre-deploy Git commit;
- checksums of all restored global and tenant databases.

If verification fails, do not write through the new backend. Restore the previous start command and deployment only after confirming the old data source remains intact.
