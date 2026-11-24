---
title: "0046: A Cowork package is a signed template file; reading one in trusts nothing it says about itself"
description: Why a cowork travels as a template signed with the installation's Ed25519 key, why its permissions are worked out again from its plan when it is read in, and why adding one makes a paused item with its plan unapproved.
---

# 0046: A Cowork package is a signed template file

**Status:** accepted, in effect. **Supersedes:** no earlier record. It builds on
[0041](./cowork-run-receipts.md) (the installation's key) and on the organisation templates of 2.2.
**Code:** `server/usecases/coworkPackages.mts` (`packageOf`, `previewPackage`, `addPackage`),
`server/usecases/coworkTemplates.mts` (`templatePlanOf`, `startFrom`), `server/routes/coworkTemplateRoutes.js`,
`agent-hub/src/components/cowork/CoworkPackageImport.tsx`.
**Enforced by:** `server/usecases/coworkTemplates.test.js` (a package read back names its signer and what
its plan may do, worked out again; a package changed after signing, or signed with another key than it
names, is refused; adding one makes a paused item with the plan unapproved and runs nothing; the preview
says whether the reader's own organisation signed it; a plan in the file is cleaned again).

## Context

A cowork that works well in one organisation is useful in others. A file that carries a plan is also a
way to slip a wider plan into someone's workspace: one that sends where the reader does not expect.

## Decision

- **A package is a template as one file:** title, brief, schedule, the cleaned plan and its fingerprint,
  signed with the installation's Ed25519 key over the canonical JSON of that content.
- **Read in, nothing is trusted:** the signature must hold with the key the file names, and the key id
  must be that key's; the plan must have the fingerprint it was saved with; what it may do is worked out
  again from the plan and shown in the same words as a plan card. The preview says whether this
  installation signed it, or another one, with its key id.
- **The organisation is signed in, the file is cleaned again:** one installation holds many organisations
  and its key signs for all of them, so "signed by this Bee Flow" alone would read as trusted to a member of
  another organisation on the same installation. The signed content therefore carries `origin`, a hash of
  the organisation id under the signing key's id (not the id itself), and the preview reports
  `organisation`: `your_organisation`, `another_organisation`, or `unknown` (a file from before the field,
  which stays readable, or one from another installation); the import screen says which in plain words.
  The plan in the file is put through the export sanitiser again (`buildExport`: pinned outputs, captured
  data, connections, approvers, app links), because a signature only says who wrote the file, not that it
  was written by `packageOf`; a plan the cleaning changed loses its fingerprint and is not attached.
- **Adding runs nothing:** a new item of the reader's, paused, with the plan as an unapproved draft of
  their own. They try it on their own data and approve it like any plan.

## Consequences

- A signature proves the file is unchanged since an installation signed it, not that the installation is
  trustworthy; the preview tells the reader which one it was.
- A Hub listing would add its own co-signature next to the installation's (`hubSignature`, empty now).
  Listing packages in the Hub needs the private licence server and is not part of this repository.
