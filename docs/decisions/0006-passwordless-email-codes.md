# ADR-0006: Passwordless sign-in with one-time email codes

Status: Accepted · Phase 1 · Supersedes the password parts of ADR-0004

## Context
The product owner wants no usernames or passwords: people enter their work email and
receive a one-time code. Organizations also want colleagues with a company address to
join without individual invitations.

## Decision
- **Sign-in**: `POST /auth/code {email}` emails an 8-digit code; `POST /auth/verify
  {email, code}` exchanges it for the existing server-side session (ADR-0004). No
  password is stored anywhere; `users.password_hash` was dropped (migration 00002).
- **Who receives a code**: existing active accounts, and new addresses whose domain a
  workspace has registered. Everyone else silently receives nothing. The response is
  identical in all cases and the lookup runs after the response (background outbox), so
  neither content nor timing reveals which addresses have accounts.
- **Codes**: 8 digits from `crypto/rand`, valid 10 minutes, single use, 5 guesses, a new
  code supersedes older ones, separate purposes (`login`, `setup`, `invitation`). Stored
  as SHA-256(code ID ‖ code). Failed attempts are committed in their own transaction.
- **Limits** (per API process): 3 codes per address then 1 per 10 minutes; 10 code
  requests per IP then 1 per 30 s; 20 verifications per IP then 1 per 3 s. Worst case
  ≈ 30 guesses per address per hour → about 0.3 % chance per year of guessing one
  address's code under a continuous attack, while the victim receives a stream of
  unsolicited code emails.
- **Email domains**: an administrator with `org.manage` registers domains (for example
  `firma.com`) with a join role. A first sign-in from that domain creates the account
  and adds it to every matching workspace. Public providers (gmail.com, outlook.com, …)
  and roles with management permissions are rejected. Domain joining applies only when
  an account is created; removed members do not rejoin automatically.
- **Invitations**: emailed with a single-use link. A new person enters their name and a
  code sent to the invited address — possessing a forwarded link is not enough.
- **First-run setup**: setup token + a code sent to the owner's email, which also proves
  that mail delivery works before the instance is created.
- **Mail**: SMTP with STARTTLS or implicit TLS is required in production
  (`FUDISLTE_SMTP_*`). In development `FUDISLTE_MAIL_TRANSPORT=log` writes emails to the API
  log instead.

## Consequences
- Account security equals mailbox security. Organizations should protect mailboxes with
  MFA; FUDISLTE adds OIDC/SAML SSO in Phase 10 for those who want their identity provider
  in charge.
- Codes can be phished like any one-time code; emails tell people never to share them.
- FUDISLTE cannot run without outgoing email. Setup refuses to complete until a code is
  delivered.
- Argon2id (`auth/password.go`) remains for room passwords in Phase 3.
