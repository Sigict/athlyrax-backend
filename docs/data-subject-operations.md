# AthlyraX data access, correction and deletion operations

This runbook defines the Version 1.0 operator workflow for customer data access and tenant retirement. It is deliberately not exposed as a public HTTP endpoint or one-click UI action.

## Principles

- Tenant boundaries are preserved at every step.
- A data export never includes password hashes, plaintext passwords, token-revocation values or session secrets.
- Live tenant retirement requires a verified safety copy first.
- Final purge of a retired archive is a separate explicit action so a legal hold or documented retention requirement can be respected.
- Production data operations must be performed only by an authorised operator with a recorded request/reason.
- Do not paste customer payloads, credentials or exported packages into GitHub issues or logs.

## Access / portability: export a tenant package

Run from an authorised backend environment with the canonical storage root available:

```text
npm run tenant:data -- export \
  --tenant <tenant-id> \
  --destination <empty-path-outside-production-storage> \
  --approve EXPORT_TENANT_DATA
```

The export contains:

```text
tenant-data.json
accounts.json
legal-acceptances.jsonl
manifest.json
```

`tenant-data.json` is the canonical tenant database. `accounts.json` contains only approved non-secret account metadata for accounts explicitly bound to that tenant. `legal-acceptances.jsonl` contains only acceptance records explicitly bound to that tenant.

The manifest records file sizes and SHA-256 hashes. An export is refused when the tenant database declares a different tenant identity or when the destination is inside production storage.

## Correction

Ordinary club/swimmer/performance corrections should be made through the authenticated AthlyraX application so normal validation, tenant isolation, revision checks and audit events remain in force.

Account corrections use the existing authenticated user-management/onboarding routes. Do not edit `auth-users.json` manually for an ordinary correction.

After a material correction, a new tenant export can be created if a corrected portability/access package is required.

## Remove live tenant data: retire

Retirement removes the tenant directory from the live storage tree only after every file has been copied to the configured safety backup root and verified by SHA-256.

```text
npm run tenant:data -- retire \
  --tenant <tenant-id> \
  --approve RETIRE_TENANT_DATA
```

The command uses `ATHLYRAX_STORAGE_ROOT` and `ATHLYRAX_SAFETY_BACKUP_ROOT` unless explicit roots are supplied.

It creates:

```text
<backup-root>/retired-tenants/<tenant-id>/<timestamp>/
```

with a `retirement-manifest.json`, verifies every copied file against the live source, and only then removes the live tenant directory.

The tool refuses to retire:

- `global-owner`
- `demo-company`
- `snapshot-public`

It also refuses nested/equal primary and backup roots.

After live tenant data is retired, remove or disable the tenant's remaining authentication accounts through the existing authenticated admin workflow. AthlyraX deliberately does not silently rewrite the authentication store from this filesystem tool.

## Final erasure of the retained retirement archive

A retirement archive is not purged automatically. Purge it only when the applicable retention policy, contractual requirement and any legal hold permit final deletion.

```text
npm run tenant:data -- purge-retired \
  --tenant <tenant-id> \
  --archive <exact-retirement-archive-path> \
  --approve PURGE_RETIRED_TENANT_ARCHIVE
```

Before deletion, the command verifies that the selected archive sits under the selected tenant's retirement root and that every file still matches the SHA-256 values recorded in `retirement-manifest.json`. A missing, mismatched or tampered file causes a fail-closed refusal.

Provider-level disk snapshots follow the hosting provider's own snapshot lifecycle. They are not directly deleted by this application command.

## Evidence and testing

Every backend security/storage CI run executes:

```text
npm run test:tenant-data-ops
```

The regression proves that:

- tenant A export never includes tenant B data;
- password hashes and token-revocation fields are excluded from account exports;
- tenant identity mismatches fail closed;
- an export cannot be written inside live production storage;
- a retirement creates and verifies the safety archive before deleting live data;
- protected system/demo tenants cannot be retired;
- a retired archive is verified before purge;
- tampering prevents purge.

## Operational record

For an actual customer request, record only metadata such as request ID, tenant ID, action type, operator, timestamps and outcome in the operational case record. Store the exported data package only in an authorised secure delivery location, not in source control or GitHub issues.
