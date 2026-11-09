# ADR-0016: Source-available under the PolyForm Internal Use License

Status: Accepted · 2026-11-09 · Supersedes [ADR-0014](0014-open-source-apache-2.md)

## Context

ADR-0014 chose Apache-2.0 so that anyone could use, change, host and redistribute FUDISLTE.
Before anything was published, the owner changed the goal on 2026-11-09:

- everyone may **use** FUDISLTE, free of charge;
- nobody may **copy** it: no redistribution, no forks offered to others, no products or
  services built from it;
- changes to the project itself come from **contributors**, whose terms the owner decides
  (a paid contributor program for the IT staff of organizations that already run FUDISLTE
  may follow later).

Nothing had been released under Apache-2.0, so no Apache-2.0 rights were granted for any
version and the license can still be chosen freely.

| License | For | Against |
| --- | --- | --- |
| Apache-2.0 (ADR-0014) | Open source, widest adoption | Permits copying, redistribution and resale |
| Business Source License 1.1, Functional Source License | Well known; restrict competing production use | Permit copying and redistribution; turn into open source after 2–4 years |
| Elastic License 2.0 | Short; forbids offering the software as a hosted service | Permits copying and redistribution |
| PolyForm Strict 1.0.0 | Forbids changes and distribution | Noncommercial use only: companies could not use it |
| **PolyForm Internal Use 1.0.0** | Organizations may use it, and change it for themselves, for their internal business operations; distribution is forbidden; a standard text written by lawyers, with a patent license and a 32-day cure period | Not open source; use outside internal business operations (e.g. purely personal use) is not granted and needs a separate permission |
| A custom "use only, no changes" license | Matches "no changes" exactly | Self-hosted software needs local changes (configuration, patches); untested legal text |

## Decision

The whole repository is licensed under the **PolyForm Internal Use License 1.0.0**, with
**Mahmut Eren Çiftçi** as the licensor.

- `LICENSE` holds the unmodified license text; `NOTICE` names the licensor, summarises the
  grant and keeps the shadcn/ui attribution (MIT).
- REUSE stays in place. The license is not on the SPDX list, so it is
  `LicenseRef-PolyForm-Internal-Use-1.0.0` (`LICENSES/`). Package manifests say
  `SEE LICENSE IN LICENSE`.
- Contributions are accepted under a Contributor License Agreement ([CLA.md](../../CLA.md))
  instead of the DCO: the licensor must be able to license contributions under any terms,
  including commercial ones, which a DCO sign-off under the project license does not give.
- FUDISLTE is described as **source-available**, never as open source.

## Consequences

- Organizations install and run FUDISLTE for their own people at no cost and may patch
  their installation. They may not give copies to anyone else, publish a modified version,
  sell it, or host it for other organizations.
- Public forks on GitHub can still be created (GitHub's terms allow viewing and forking);
  the license does not allow using such a fork outside the grant. Enforcement is legal, not
  technical.
- Uses outside the grant — personal use, hosting for customers, redistribution — need a
  separate written permission or commercial license from the licensor.
- Dependency policy ([dependencies.md](../dependencies.md)) is unchanged: permissive
  licenses, MPL-2.0 files used unmodified and OFL fonts work inside a source-available
  product; GPL and AGPL code stay out of shipped components.
- Images, installers and the VS Code extension ship FUDISLTE's `LICENSE` and `NOTICE` with
  the third-party notices, as before.
- The CLA text should be reviewed by a lawyer before the first outside contribution is
  merged.
