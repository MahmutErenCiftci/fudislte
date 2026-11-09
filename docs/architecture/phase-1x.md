# Phase 1.x — Security follow-ups

Status: **Done** — account disable, domain verification, HTML emails and desktop
packaging implemented; release code signing needs the organization's certificate.

## Disabling accounts

- Instance administrators disable or re-enable a member's account from *Settings →
  Users* (`POST /orgs/{orgID}/members/{userID}/disable` and `/enable`). An account spans
  every workspace on the server, so workspace roles cannot do it.
- A disabled account cannot request codes (same response as unknown addresses, no
  email) or sign in. Its sessions are revoked in the same transaction and its live event
  streams close at once. Memberships, messages and files stay; re-enabling restores
  access with a new sign-in.
- Nobody disables their own account, and the last active instance administrator cannot
  be disabled. Audit: `member.disabled`, `member.enabled`.

## Verifying email domains (migration 00010)

- A newly added email domain gets a verification token. People join automatically only
  after an `org.manage` holder publishes the TXT record `fudislte-verification=<token>` on
  the domain or on `_fudislte-verification.<domain>` and presses *Verify*
  (`POST /orgs/{orgID}/domains/{domain}/verify`). Lookups are limited to ten in a burst,
  then one every ten seconds per workspace, with a ten-second timeout.
- Domains added before verification existed were trusted by an administrator and stay
  verified. Audit: `org.domain_verified`.
- *Settings → Access* shows each domain as "Doğrulandı" or "Doğrulama bekliyor", with the
  record to copy; the access summary counts verified domains only.

## HTML emails

Every email is sent as `multipart/alternative`: the existing plain-text part plus an
HTML version (inline styles and tables, the code in a large box, invitation links as a
button). Both come from one content model; `html/template` escapes every value, so a
workspace or person name cannot inject markup. Emails are in the recipient's language
(Turkish or English), as before.

## Desktop packaging

`pnpm --filter @fudislte/desktop package` builds an unpacked app (`release/win-unpacked`)
and `dist` an installer (NSIS on Windows, DMG on macOS, AppImage on Linux) with
electron-builder (MIT). The build reuses the checksum-verified Electron binary and flips
Electron fuses: no `RunAsNode`, no `NODE_OPTIONS` or inspector flags, cookie encryption,
ASAR integrity validation and loading only from the ASAR. Packaged builds ignore the
development variables (dev server URL, smoke test).

Release builds must be code signed: on Windows with the organization's certificate
(`CSC_LINK`, `CSC_KEY_PASSWORD`) or Azure Trusted Signing, on macOS with a Developer ID
certificate and notarization. Signed auto-updates follow in Phase 10.

## Verification

Run 2026-10-30.

| Check | Result |
| --- | --- |
| `pnpm check:api` | 83 Go tests pass. New: disabling needs an instance administrator and never targets oneself; it closes the person's live stream, ends the session (401) and stops codes; re-enabling lets them sign in; audit entries. Domain verification: a new domain admits nobody and fails verification until the right TXT record appears (a wrong token is refused), then people join. Emails: Turkish text and HTML, escaping of a hostile workspace name, multipart/alternative with text then HTML |
| Browser | *Settings → Access*: the existing domain shows "Doğrulandı"; a new one shows its TXT record, and *Verify* against real DNS reports in Turkish that the record was not found. *Settings → Users*: an instance administrator disables a member after confirmation ("Devre dışı" badge) |
| Desktop | `pnpm --filter @fudislte/desktop package` builds `FUDISLTE.exe`; the fuses read back as configured; the unsigned build starts on this machine |

Not verified: signed installers (no certificate here), the NSIS installer itself, and a
real HTML email in mail clients (SMTP delivery still waits on the SMTP settings).
