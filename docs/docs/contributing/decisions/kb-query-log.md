---
title: "0016: The knowledge-base search log is opt-in, manager-only and sealed under an organisation key"
description: Why the log of knowledge-base questions and answers is off by default per base, readable only by the base's managers, encrypted with a key derived from the organisation root key (also on the zero-knowledge tier), and why compliance sees content only behind an open data-subject request.
---

# 0016: The knowledge-base search log is opt-in, manager-only and sealed under an organisation key

**Status:** accepted, in effect. **Code:** `server/core/kb/queryLog/` (`recorder.mts`, `crypto.mts`,
`hook.mts`, `vocab.mts`), `server/stores/kb/queryLog/`, `server/routes/knowledgeBases/queryLog.js`,
`server/routes/compliance/kbQueryLog.js`, `server/jobs/kbQueryLogRetention.mts`. **Enforced by:**
`core/kb/queryLog/recorder.pg.test.js` and `channels.pg.test.js` (nothing is written when a base does not
log or the licence is missing), `core/kb/queryLog/searchCallSites.inventory.test.js` (every search call
site is hooked or says why not), `routes/knowledgeBases/queryLog.test.js` (readers and other organisations
get 404), `routes/compliance/kbQueryLog.test.js` (no content without an open data-subject request; the
audit row is written first and its failure refuses the request), `core/kb/queryLog/crypto.test.js`,
`server/routes.contract.test.js` and `server/tenantIsolation.matrix.test.js`.

## Context

The people who curate a knowledge base want to know whether the AI answers from it correctly: which
questions came in, which passages were found, what was answered, and what is missing. Teams built that
themselves in App Studio, one app per base. A standard log answers the need once, but it holds personal
data: who asked what, in their own words, and what they were told.

## Decision

- **Opt-in per base, Enterprise only.** `knowledge_bases.query_log_enabled` is false by default. The
  recorder writes nothing unless the base logs, the organisation holds `kb_query_log`, and the base belongs
  to an organisation. The insert itself re-checks the setting, so a switch-off on another pod, or a purge,
  wins over a search already in flight.
- **One row per search per base.** A search over several bases writes one row for each base that logs,
  holding only that base's passages, so a manager of one base never reads another base's content.
- **Managers only.** Reading, reviewing and exporting require `canManageKB` (the owner, or a member of the
  base's organisation with `manage_knowledge`). Reading the base is not enough.
- **Sealed under an organisation key.** Question, passages, answer, citations and the review note are
  encrypted with a per-base key derived from the organisation root key, AAD-bound to organisation, base,
  row and field. The managers and compliance must be able to read the log, so a user's own key cannot be
  used. On the zero-knowledge tier this is a stated weakening, the same trade as shared project
  conversations: the setting says so before it is switched on.
- **Compliance sees metadata.** The Compliance Center shows the setting, term, managers and counts per base,
  and entries without text. One person's content, export or erasure needs an open data-subject request
  about that person, and the access is audited before it happens. These routes are not licence-gated, so
  erasure keeps working after a licence lapses.
- **Retention is a property of the row.** `expires_at` is set at write time from the base's term and
  recomputed when the term changes; an hourly job deletes expired rows. Deleting the base, the user, or
  moving the base to another organisation removes its rows.
- **Logging never costs the search.** The handle is returned without a database round-trip; all lookups
  and writes happen behind it, and a failure is logged and dropped.

## Consequences

- An organisation that rotates its root key while sealed log rows exist is refused until those rows are
  gone, because they could not be read afterwards.
- Builder steps (`kb_log_query`, `kb_log_review`, automation `kb_query_log`) apply the same manager rule to
  the owner and, in an app, to the viewer. Run histories keep a redacted copy only, so retention and erasure
  are not undone by a run log.
- A new place that searches a knowledge base fails the inventory test until it is hooked or listed with its
  reason.
