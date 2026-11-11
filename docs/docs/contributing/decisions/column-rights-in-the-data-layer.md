---
title: "0025: Column rights are enforced in the data layer and proved by oracle tests"
description: Why the roles that may read or write a field of an App Studio table are decided where the query is compiled and the row is written, and how tests that compare two worlds prove that a hidden value cannot be learned.
---

# 0025: Column rights are enforced in the data layer and proved by oracle tests

**Status:** accepted, in effect. **Supersedes:** no earlier record. **Code:**
`server/core/dataEngine/columnRights.mts` (the rule and its enforcement, at the top of the file),
`columnRightsLinked.mts` (lookup, rollup and many-relation fields), `columnRightsSave.mts` (what a
model save may declare), `accessFilter.js` (carries the verdict per role next to the row predicate),
`server/appStudio/validate/columnRightsChecks.mts`. **Enforced by:**
`server/core/dataEngine/columnRights.oracle.engines.test.js` (the oracle test, on SQLite and
Postgres), `columnRights.test.js`, `columnRightsLinked.test.js`,
`server/appStudio/columnRights.doors.test.js` (every way into a table goes through the rule) and
`server/appStudio/validate/columnRightsChecks.test.js`.

## Context

A field can be limited to some roles for reading and writing. A screen that does not show the field
is not enough: a viewer can ask the server directly, and a filter, a sort, a search, a grouping, a
count, a computed field, an expanded relation or a bulk change can all tell them something about a
value they may not read, without ever receiving it.

## Decision

- **The rule lives in the query compiler and the write path.** The access filter carries, next to
  the row predicate, the verdict for that role. Every compiler that reads rows starts from the
  table as that role sees it, with the hidden fields gone. A hidden field then behaves as a field
  that does not exist.
- **Refuse, do not drop.** Where a request names a hidden field to pick, order or fold rows (a
  filter, a sort, a search field, a grouping, an aggregate, a relation path, an upsert key, the
  filter of a bulk change) the read is refused with the answer for an unknown field. Dropping the
  clause would answer a different question, and a write through it would touch other rows.
- **Leave out, where the request only says what to return.** The record is returned without the
  field.
- **Derived fields follow.** A computed field is hidden when it reads a hidden field, a lookup when
  its relation is hidden; a lookup or rollup that reads a field the role cannot read reads empty.
- **The owner reads and writes everything.** The `public` role has a field only when a list names it.
- **Contradictions are refused at save.** A unique field a role may write but not read, and a
  relation with a delete rule and a read list, cannot be declared.
- **Proved by oracle tests.** Two worlds hold the same app and rows, and only the hidden fields
  differ. Every probe a viewer could try is run in both. For a role that may not read the fields, the
  answers (rows, counts, or the refusal and its text) are the same in both worlds. For a role that
  may read them, the probes do tell the worlds apart, so the test is not vacuous.

## Consequences

- A new way to read a table (a new binding key, a new query form, a new aggregate) has to take the
  scoped table, and joins the probes of the oracle test.
- A chart or filter that other roles see cannot be bound to a restricted field: it fails for them.
  The builder, the editor and the documentation say so.
- Column rights are not available on a table linked to a Studio datatable, whose rows are read by
  another store.
