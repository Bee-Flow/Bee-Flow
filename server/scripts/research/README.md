# Research scripts

Everything the research plan needs that is code. The contract these run under —
who may be asked, what is collected, how long it is kept — is published at
[`docs/reference/user-research`](../../../docs/docs/reference/user-research.md),
not here.

## `s1-query-pass.sql`

The five reads that turn each thing a screenshot showed once into a
distribution. Tenant-scoped, count-only, no message or document text.

```bash
psql "$CORE_DATABASE_URL" -v org=bee-flow -f server/scripts/research/s1-query-pass.sql
```

Run it **before any fix lands** — the first commit closes the window on the
before-picture. Then check the kill criterion at the bottom: under about twenty
rows anywhere and this instance is not a data source, whatever else the plan
says.

## `reseed-fixture-account.js`

Puts the S3 fixture account back the way session one found it, so participant
two is not navigating participant one's leftovers.

```bash
# Once, before the first session:
node server/scripts/research/reseed-fixture-account.js --user <id> --org <id> --seed

# Between every session:
node server/scripts/research/reseed-fixture-account.js --user <id>            # see what would go
node server/scripts/research/reseed-fixture-account.js --user <id> --reset --apply
```

`--seed` writes a baseline timestamp last, and `--reset` deletes only what the
account created after it. That is why the fixture documents and the aged failed
runs survive every reset without being re-created, and why the script refuses to
run against an account it has never marked.

It will not touch a non-local database unless `RESEARCH_ALLOW_REMOTE=1` is set.
Do not set it.

## `fixtures/`

The invented documents the fixture account holds, and what each one is for. Read
`fixtures/README.md` before changing any of them — three of the six exist to be
the *wrong* answer, and replacing one with a tidier document quietly removes the
thing the retrieval task measures.
