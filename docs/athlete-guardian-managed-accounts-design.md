# Guardian-managed Athlete App accounts (no athlete email) — security design for approval

Status: IMPLEMENTED in the guardian-managed-accounts PR (stacked on the invitation automation PR). Defaults chosen: the guardian sets the initial password; recovery codes go to the guardian. Both can be changed before release.
"Consent given: athlete email needed" until the coach adds one.

## Problem
Every AthlyraX login has an email address. It is used for password reset and for binding an
invitation (`targetEmail`). A young athlete may have no email address of their own.

## Proposed design
1. **Who creates it.** Only the verified parent/guardian, after consent, from the guardian link.
   They choose "My child has no email address: set up their login for them".
2. **Account.** A normal `swimmer` account with a unique username and its own password (at least
   10 characters; set by the guardian and given to the child). No email field. It is marked
   `managedBy: { guardianEmail, inviteId, consentAt }`.
3. **Separate credentials.** The guardian does not get a login to the child's account. The child's
   password is never stored or emailed in readable form.
4. **Recovery.** Password reset for a managed account sends the one-time code to the
   *guardian's verified email*. The reset screen says so ("code sent to the parent/guardian").
   The existing reset rate limits apply.
5. **Revocation.** The guardian link (re-issued by the club on request) lets the guardian revoke
   access. This uses the existing "Correct account link" path: the link is removed, the account's
   club connection is revoked and sessions end. The club can do the same.
6. **Later migration.** When the athlete gets their own email, they add and verify it with a
   code. `managedBy` is then cleared and recovery moves to the athlete.
7. **Audit.** Account creation, resets, revocation and migration are audit events. No codes or
   passwords are logged.

## Changes needed (after approval)
- Password-reset delivery: send to `managedBy.guardianEmail` when the account has no email.
- Guardian page: a "set up login without email" form (username and password), allowed only after
  verified consent on a live invitation.
- Acceptance: a variant that creates the managed account with no email, bound to the invitation.
- Tests: no reset to an unverified address; guardian revocation; email migration; no secrets in logs.

## Decisions for the owner
- Approve guardian-set passwords, or require the child to set one on first sign-in.
- Approve recovery via the guardian's email.
