---
title: Data in apps, rules and access
---

# Data in apps: reads, fields and access

This page covers what an app can now do with its data: richer reads, new field types, rules the
server checks on every write, relations that follow each other, access rules per operation, and
rights per column. The basics are in [App Studio](./apps.md#data-tables-roles--access). Everything
here is optional, and an existing app reads and writes exactly as before.

## Reading data

A component reads a table through a binding: a record, a list of records, an aggregate or a saved
dataset. These settings are new.

**On a list of records**

- **Search** (`search`): rows where any of the listed fields contains a text. The text can be a
  formula, such as a search box. It combines (AND) with the filters, and a search text that
  resolves to nothing shows every row.
- **Columns** (`fields`): return only the listed columns (1 to 100) and the id, instead of every column.
- **Sort on several columns** (`orderBy`): up to 3 columns, each ascending or descending. Use it
  instead of the single sort, not beside it. On an aggregate, a column is one of its output columns.
- **Match any** (`match: "any"`): the top-level filters join with OR instead of AND.
- **Expand** (`expand`): take the row a relation points at along with each record, 1 to 5 relations. It
  lands under `<field>_record`, one relation deep, and is read under the related table's own row
  rules. `pick` chooses which of its fields to carry.

**Filters**

- **Groups** of `any` and `all`, nested up to 3 levels deep, and `not`.
- **Compare two columns** of the same row (`otherField`).
- **A field of the related row** (`"<relation>.<field>"`), one relation deep, read under the related
  table's own row rules.
- **Contains** and **not contains** on a relation that holds several records.

**Aggregates and grouping**

- `countDistinct` counts the different non-empty values of a field.
- **Group by a column of the related row** (`relatedField`), or **fold a number onto steps** of a
  width (`binWidth`, so 0, 10, 20 and so on, named `<field>_bin`).
- **Keep groups** whose aggregate passes a test (`groupFilter`, like SQL HAVING; the tests are `eq`,
  `neq`, `gt`, `gte`, `lt` and `lte`).

**Paging.** A table, data grid and list can page; see
[More components](./apps-components.md#paging-long-lists).

### Dataset parameters

A saved dataset can declare up to 10 **parameters** (a name, a type of `text`, `number`, `boolean`
or `date`, an optional default and a label). A filter clause then takes its value from a
parameter, and the binding that reads the dataset sends the values, each a literal or a formula:

```json
{ "kind": "dataset", "datasetId": "ds_sales", "params": { "region": "south" } }
```

Only the value of a clause you wrote can come from a parameter. The field, the operator and the
rest of the query stay yours. A sent value is only read for a declared name and is converted to the
declared type. A parameter without a value uses its default; without either, the clause is
dropped, as an empty filter field filters nothing, unless the clause is marked `required`, in which
case the read returns no rows. A parameter can narrow what a viewer sees and never widen it past
their row rules. A dataset that declares no parameters works exactly as before.

## Field types

| Type | What it is |
|------|------------|
| `autonumber` | A whole number the server assigns on create: 1, 2, 3 and on, per table. Read-only and always unique: never write, seed or default it. |
| `json` | A JSON value (an object, a list, a number, a string or a boolean), stored as JSON text. A written string must itself be JSON text. |
| `user` | The user id of a member of the organisation. |
| `lookup` | Shows one field of the record a relation points at. Read-only, no column. It reads empty when the viewer may not read that record, and you filter on `<relation>.<field>` instead of on the lookup. |
| `rollup` | A count, sum, minimum, maximum or average over the records that point here, optionally only those that match up to 5 conditions. Only child records the viewer may read are counted. An empty count reads 0 and an empty sum, min, max or average reads empty. It cannot be filtered, sorted or aggregated on. |

These types work on an app's own tables, not on an automation datatable. A **computed** field is worked out
every time a record is read from the table's own columns: you can show it, but not filter or sort
on it.

### Field options

- **Validation.** Rules every write of the field must pass, checked on the server: `min` and `max` for numbers,
  `minLength`, `maxLength` and `pattern` (a case-sensitive regular expression) for text, `enforceOptions` to
  accept only the listed options of a select, and a `message` that replaces the generated error
  sentence. An empty value always passes (use *required* for that), and rows already stored are not
  re-checked.
- **Format.** A text field can hold an `email`, a `url` or a `phone` number, checked on every write. The column stays text.
- **Default when created.** `now` for a date and time, `today` (UTC) for a date, `currentUser.id` for
  a text or user field. Not together with a fixed default.
- **Display.** How a value is shown, never how it is stored: currency, decimals and unit for numbers, a date style for dates.
- **Several records in one relation** (`many`). The value is a list of record ids. Write the whole
  list (`[]` clears it), expand it to the records, and filter with *contains*. Ids of records the
  viewer may not read are left out of what they see and are kept when they write the list. It works between
  an app's own tables and cannot be unique, required or have a delete rule.
- **Indexes.** A table can list up to 10 indexes of 1 to 4 stored columns each, which make filters and sorts on those
  columns fast on big tables. Adding or removing one never rebuilds the table or changes a row. A lookup,
  rollup, many relation or computed field cannot be indexed.

### What deleting a record does to related records

A single relation between two of the app's own tables can say what a delete does
(`onDelete`):

| Rule | Effect |
|------|--------|
| `restrict` | The delete is refused while any record points at it. |
| `setNull` | The relation of those records is emptied. |
| `cascade` | Those records are deleted too, and so on down. |

The person deleting must be allowed to change (`setNull`) or delete (`cascade`) every one of those
records, or nothing is deleted. At most 500 records are affected by one delete by default.

## Who can read and change rows

Row rules decide which rows a role sees. Beyond `viewer.id`, `viewer.role` and `viewer.groups`,
a rule can use `viewer.email` and `viewer.orgId` (the organisation of the viewer's own account; empty
for an anonymous visitor of a public page). Test membership of a list with `in`:
`record.team in viewer.groups`; a viewer in no group matches no row.

**A rule per action.** Instead of one rule for seeing, changing and deleting, give each its own:
`{ read, update, delete }`. A key left out follows the read rule, so it is never wider than seeing
because a rule is missing. The formula `true` gives that action every row.

## Who can read and change a column

Under **Data**, a field can have **column rights** (`access`): which roles may read it and which
may write it.

- **Read.** Only the listed roles, and the owner, get the field. For every other role it is left out
  of each record, and it cannot be used in a filter, sort, search, grouping or aggregate: such a read
  is refused, as it would be for a field that does not exist. So do not bind a chart, a filter or a
  sort that other roles see to it. A computed field over a hidden field is hidden too, and so is a
  lookup through a hidden relation. A lookup or rollup that reads a field the role may not read on
  the other table reads empty.
- **Write.** Only the listed roles may set the field. Left out, write follows read.
- **An empty list** means the owner only. The anonymous `public` role has the field only when a list names it.
- **Not allowed together:** a unique field that a role may write but not read; a relation with a delete
  rule and a read list. Column rights are not available on a table linked to a Studio datatable.

The server enforces this in the data layer, for every way a viewer could ask (a filter, a sort, a
search, a grouping, a count, an expanded relation, a bulk change), not only in what a screen
shows.
