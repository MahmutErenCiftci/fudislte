# Security policy

## Supported versions

FUDISLTE is in early development (0.x). Security fixes go into the latest release only;
upgrade to receive them.

## Reporting a vulnerability

Please do not report security problems in public issues, pull requests or discussions.

Use GitHub's private vulnerability reporting instead: on the repository page open
**Security → Report a vulnerability**. Include:

- the affected version or commit;
- the component: API, web app, desktop app, AI worker, VS Code extension or deployment
  files;
- steps to reproduce or a proof of concept, and the impact you observed.

We confirm receipt, investigate, agree on a disclosure date with you, fix the problem and
publish a security advisory that credits you, unless you prefer not to be named.

## Scope

In scope: the code and the deployment files in this repository. The
[threat model](docs/security/threat-model.md) describes what FUDISLTE defends against and
which risks are accepted; reports that show a practical attack on an accepted risk are
welcome.

Out of scope:

- vulnerabilities in third-party dependencies without a demonstrated impact on FUDISLTE
  (please report those upstream);
- denial of service through traffic volume alone;
- attacks that require a compromised server, database or administrator account;
- weaknesses of a particular deployment, such as a server without TLS.
