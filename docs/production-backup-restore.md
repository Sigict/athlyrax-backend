# AthlyraX production backup and restore

This runbook is the Version 1.0 production backup/recovery policy for AthlyraX.

## Production storage

Mutable production data lives only under the canonical Render persistent-disk root configured by `ATHLYRAX_STORAGE_ROOT`. The separate `ATHLYRAX_SAFETY_BACKUP_ROOT` is required for application safety copies and must not be nested inside the primary root.

The canonical storage layout and startup fail-closed rules are defined in `docs/render-persistent-storage-migration.md`.

## Provider snapshot baseline

AthlyraX relies on Render's persistent-disk snapshot service as the provider-level disaster-recovery baseline.

Current Render documentation states that:

- persistent disks and their snapshots are encrypted at rest;
- Render automatically creates one persistent-disk snapshot every 24 hours;
- available snapshots can be used to restore the disk after critical loss or corruption;
- a persistent disk is attached to one running service instance and is not accessible from Render Cron Jobs or one-off jobs.

Official references:

- https://render.com/docs/disks
- https://render.com/docs/cronjobs

Because Cron Jobs cannot access the web service's disk, do not create a separate Render Cron Job that pretends to back up `ATHLYRAX_STORAGE_ROOT`. It would run in a different instance without the production disk.

## Recovery objectives

Provider snapshot frequency gives an infrastructure recovery-point objective of no better than approximately 24 hours in the worst case. Application safety copies may reduce loss for individual mutations, but they are not a substitute for the provider snapshot.

AthlyraX does not publish a guaranteed production recovery-time SLA in Version 1.0. The isolated restore test records its measured staging time on every security/storage CI run as:

```text
ATHLYRAX_STAGE_RESTORE_RTO_MS=<milliseconds>
```

That measurement is evidence for the application restore mechanism only. Render provisioning or snapshot-restoration time is controlled by the hosting provider and must not be represented as an AthlyraX guarantee.

## Automated restore proof

Every backend CI run executes:

```text
npm run test:closed-pilot-backup-restore
```

The test uses only temporary non-production storage. It proves that:

- global and tenant exports can be staged into a clean recovery root;
- tenant identity is preserved and cross-tenant mapping is rejected;
- the staged files receive SHA-256 integrity hashes;
- a restore never activates production or creates the production-ready marker automatically;
- a non-empty destination is refused;
- explicit `STAGE_ONLY` approval is required;
- the measured staging duration is logged.

The complete storage/security suite also runs this proof through:

```text
npm run test:storage-all
```

## Live verification policy

Production verification must be non-mutating. The GitHub workflow `.github/workflows/verify-live-db-delete-persistence.yml` is retained under its historical filename for compatibility, but it now performs only a read-only storage-boundary probe.

It verifies that the exact deployed backend commit:

- returns `401` for unauthenticated `/db` access;
- exposes the expected `X-AthlyraX-DB-Persistence-Guard` header;
- exposes the exact `X-AthlyraX-Backend-Commit` SHA;
- sets `Cache-Control: no-store`;
- performs no login, PUT, DELETE, or other production mutation.

The result is written to backend operations ledger issue #23.

## Real incident restore procedure

A real Render disk snapshot restore is destructive to the current disk state and must not be used merely as a test. Use it only for an actual recovery event or an explicitly approved maintenance exercise.

Before a production restore:

1. Confirm the incident and identify the latest known-good Render disk snapshot in the service's **Disks** page.
2. Record the incident time, chosen snapshot time, expected data-loss window, current deployed backend commit, and reason for restore.
3. Preserve any still-readable current data using the existing application safety mechanisms before replacing disk state, when doing so is safe.
4. Restore the selected Render disk snapshot from the Render Dashboard.
5. After the service returns, run the canonical storage safety checks from the deployed source:

```text
npm run check:storage-safety
npm run audit:storage-paths
```

6. Verify the public production boundaries: `/auth/config`, unauthenticated `/db` rejection, exact backend commit header, and frontend sign-in page.
7. Verify at least one authorised non-demo tenant can read its own data and cannot read another tenant. Do not use a cross-tenant production mutation as a test.
8. Record the recovery result and observed timings in the production operations ledger. Do not record credentials or customer payloads.

## Commercial launch evidence

Before unrestricted commercial use, the operator must visually confirm in the Render Dashboard that the production backend actually has a persistent disk attached and that snapshots are available. Repository tests cannot prove dashboard-level snapshot availability.

That one dashboard confirmation is operational evidence, not a code change, and should be recorded without copying any customer data or credentials into GitHub.
