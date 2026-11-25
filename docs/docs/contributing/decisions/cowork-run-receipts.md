---
title: "0041: Every closed Cowork run gets a signed, chained receipt of names and counts, issued apart from closing the run"
description: Why a run receipt holds what the run was allowed to do and what it did as apps, tools and counts only, why receipts are linked by hash per item and signed with an Ed25519 key of the installation, and why issuing one can never stop a run from closing.
---

# 0041: Every closed Cowork run gets a signed, chained receipt

**Status:** accepted, in effect. **Supersedes:** no earlier record. It builds on
[0030](./cowork-plan-closed-step-list.md) and [0037](./cowork-organisation-policy.md).
**Code:** `server/core/cowork/receipts/receiptFacts.mts` (what a receipt holds, from an allow-list),
`receiptKey.mts` (the key), `issueReceipts.mts` (issuing, after a run ends and by a sweep),
`verifyReceipts.mts` (the verdict), `server/stores/coworkReceipts.mts` (`cowork_receipts`, the item's
chain lock), `server/usecases/coworkReceipts.mts`, `server/routes/coworkReceiptRoutes.js`.
**Enforced by:** `server/core/cowork/receipts/receipts.pg.test.js` (three runs give a linked, signed
chain; a removed receipt is a gap, an edited one changed content, a forged signature a bad signature;
a marker planted in a result, a subject, a brief and a tool's reason reaches no receipt; a waiting run
gets its receipt when its journey ends), `server/usecases/coworkReceipts.test.js`.

## Context

An audit, an AI Act record or a curious owner asks the same question: what did this cowork do, under
which plan, approved by whom, and what left Bee Flow? The run history answers it today, but a history
row can be edited or removed without anyone seeing, and it holds the run's text, which an audit should
not need.

## Decision

- **Names and counts.** A receipt holds the run, how it started and ended, the approved plan's version
  and fingerprint, who approved it and when, what it was allowed to do, how independent it ran, and
  what it did as app, tool, effect and count. It is built from an allow-list; no text a run read or
  wrote, no address, no subject, no tool arguments, no error message.
- **One chain per item.** Receipts are numbered and each names the hash of the one before it; a
  missing or edited one shows. A closed run that has no receipt after the grace time is reported as
  missing, so a receipt that was never issued shows too.
- **Signed.** One Ed25519 key per installation, its private half a secret in the config store, sealed
  under a key derived from `MASTER_ENCRYPTION_KEY`; the public half is served so a receipt can be
  checked elsewhere. Without a master key receipts are issued unsigned and say so.
- **Apart from closing.** A receipt is issued right after a run ends and by a sweep every five minutes,
  under the item's chain lock. A failure to issue one never stops a run from closing; the next sweep
  issues it.

## Consequences

- The signature does not protect against someone who holds both the database and the master key: they
  can sign too. The chain still shows a receipt removed without re-signing every later one.
- Receipts go with their item; deleting the item deletes its chain.
