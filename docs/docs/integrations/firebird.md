---
title: Firebird database
---

# Firebird database

[Firebird](https://firebirdsql.org/) is an open-source relational database. Several business applications keep their data in it, for example **Syntess Atrium**. With this integration an agent or automation can look up tables and columns and read rows with `SELECT` queries.

The integration is **read-only**. Every statement runs in a read-only transaction, and `firebird_query` additionally refuses anything but a single `SELECT` (or `WITH ... SELECT`) statement. Nothing is created, changed or deleted. That is enforced in the tool set itself (`server/integrations/firebirdTools.js`) and asserted by its unit tests.

## Setup

You need four values, plus an optional fifth:

| Field | What to enter |
|-------|---------------|
| **Server** | The host name or IP address of the machine that runs the Firebird server. No scheme, no path. |
| **Port** | Leave empty for the default, `3050`. |
| **Database** | The database as the Firebird **server** sees it: an alias from its `databases.conf`, or a file path on that machine such as `C:\Data\Atrium.fdb` or `/data/atrium.fdb`. Bee Flow never opens the file itself. |
| **User** and **Password** | The Firebird account to read with. |
| **Character set** | Optional. `UTF8` by default. Older databases, Atrium databases included, often use `NONE` or `WIN1252`. If text with accents looks wrong, try another set. |

Then go to **Settings → Connections → Firebird database**, fill in the fields, click **Test connection** and save. The test shows the Firebird version and the number of tables.

Notes for **Syntess Atrium**:

- Use the **server name** of the machine that runs the database, not a name from a client shortcut. The Bee Flow server must be able to reach it on the Firebird port (3050 unless changed). A private or internal address is fine: Bee Flow runs in your own network.
- **Never use `SYSDBA`.** Ask your Atrium administrator for a dedicated account that may only read (`GRANT SELECT` on the tables you need). A read-only account is recommended even though Bee Flow only reads, so the database itself enforces it as well.

The values are stored per user and encrypted at rest (AES-256-GCM). The integration is deliberately **not lendable**: database credentials are never shared between users. Each user connects their own account.

An administrator can restrict which hosts may be used with the environment variable `FIREBIRD_ALLOWED_HOSTS` (comma-separated list; empty means any host).

## Tools

| Tool | Purpose |
|------|---------|
| `firebird_whoami` | Server version, database, account, character set and table count; also the connection test. |
| `firebird_list_tables` | Tables and views (system tables excluded), optionally filtered by part of the name. **Start here.** |
| `firebird_describe_table` | Columns with type, nullability and default, the primary key and the foreign keys of one table. |
| `firebird_sample_rows` | The first rows of one table, to see what the data looks like. |
| `firebird_query` | A `SELECT` statement, with optional `?` parameters and a row limit. |

A good order for an agent: list the tables, describe the ones that look relevant, then query.

## Use cases

- "Which tables hold projects and their invoices?"
- "List the open work orders of this month with their customer."
- (Automation) Every morning, read yesterday's booked hours and write a summary to a data table.

## Limits and behaviour

- **Row cap**: 100 rows by default per call, at most `FIREBIRD_MAX_ROWS` (default 1000; `0` means unlimited). When more rows exist the result says `truncated: true`. Ask for a narrower `WHERE` rather than a bigger page.
- **Statement timeout**: 20 seconds (`FIREBIRD_STATEMENT_TIMEOUT_MS`). The connection attempt times out after 10 seconds.
- **Output budget**: about 30,000 characters per call; rows beyond that are left out and the result is marked truncated.
- **Text and BLOBs**: text BLOB columns come back as text, each value cut at 2,000 characters. Dates are ISO strings.
- **One statement**: a `;` outside a string literal, comments that hide a second statement, and the keywords `INSERT`, `UPDATE`, `DELETE`, `MERGE`, `EXECUTE`, `ALTER`, `CREATE`, `DROP`, `GRANT`, `REVOKE`, `RECREATE`, `COMMIT`, `ROLLBACK`, `TRUNCATE` and `SET TRANSACTION` are refused.
- **Personal data**: rows come straight from your database and can contain personal data. They are handled like any other tool result, including the Privacy Shield.

## Common errors

| Error | Cause | Fix |
|-------|-------|-----|
| `Firebird database not configured` | Server, database, user or password is missing | Fill in all four in Settings → Connections. |
| `connection refused` / `timed out` for `host:3050` | The Bee Flow server cannot reach the database server, or a firewall blocks the port | Check the host name, the port and the firewall. |
| `Your user name and password are not defined` | Wrong account or password | Re-enter them; check the account on the database server. |
| `I/O error ... Database` or `unavailable database` | The database path or alias is not known to the Firebird server | Use the path or alias exactly as the server sees it. |
| `no permission for SELECT access to TABLE ...` | The account may not read that table | Ask the administrator to grant `SELECT`. |
| Garbled accents in text | Wrong character set | Try `WIN1252`, `ISO8859_1` or `NONE`. |

## Not included

Writing to the database (`INSERT`, `UPDATE`, `DELETE`, DDL), executing stored procedures, and managing users or backups are out of scope. This is by design: the integration reads, it never changes your business data.
