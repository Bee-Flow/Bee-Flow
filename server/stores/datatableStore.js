// @typecheck
/**
 * Datatables — the METADATA store.
 *
 * A datatable is a persistent table that routines read and write. Rows live in
 * Postgres, in a schema per SCOPE, and are reached only through the shared
 * engine (core/dataEngine) — see datatableDbStore.js. THIS module owns
 * everything *about* a table: who created it, who may use it, what its columns
 * are, how many rows it holds, and which routines touch it.
 *
 * ── FOUR TABLES, AND WHY ────────────────────────────────────────────
 *   datatables                 one row per table — identity, sharing, retention,
 *                              and the two hot counters
 *   datatable_models           one row per SCOPE — the engine's model document,
 *                              holding every table's columns
 *   datatable_grants           explicit per-principal write/read grants
 *   automation_datatable_usage which CONSUMER (a routine step, an app table
 *                              binding, a webpage block) reads or writes which
 *                              table — see the dependents index below
 *
 * ── THE DEPENDENTS INDEX IS GENERIC; ITS NAME IS NOT ─────────────────
 * `automation_datatable_usage` was built for routines and is now the index for
 * every kind of consumer: `consumer_kind` ('automation' | 'app' | 'webpage' |
 * 'kb', see CONSUMER_KINDS) says which, and `automation_id` is the GENERIC CONSUMER
 * ID — an automation id, a studio_apps id or a webpages id, depending on the
 * kind. The column keeps its old name on purpose.
 *
 * Neither the table nor its primary key `(automation_id, step_id)` is renamed
 * or reshaped in this release, and that is a deployment decision, not laziness:
 * this DDL runs at module load on every replica, migrations/datatable-scope-
 * 2026-09 ALTERs the old name on EVERY boot, and production is a two-replica
 * rolling deploy with automatic `rollout undo`. A renamed table would let an
 * old or rolled-back replica recreate an EMPTY table under the old name — its
 * listUsage would answer [] and `DELETE /:id` would drop a table that routines
 * still write to. `ADD COLUMN IF NOT EXISTS … DEFAULT 'automation'` is
 * metadata-only and reads correctly from both sides of a deploy. If a rename is
 * ever wanted: its own migration, a view under the old name for one release,
 * and the table list in datatable-scope-2026-09 updated with it.
 *
 * The PK stays valid across kinds because automations, studio_apps, webpages
 * and knowledge_bases are ALL UUID ids — two consumers of different
 * kinds sharing an id is a probabilistic impossibility, not a structural one.
 * Every DELETE and every purge is therefore keyed on `(consumer_kind,
 * automation_id)`, never on the id alone, so the guarantee is never leaned on
 * where it does not have to be.
 *
 * The model is per-SCOPE, not per-table, for a reason that is easy to get
 * wrong: core/dataEngine/dataModel/ddl.js emits relation foreign keys as an
 * UNQUALIFIED `REFERENCES "<targetKey>"(id)`, so related tables have to live in
 * one Postgres schema. `migrationPlan(oldModel, newModel)` also diffs whole
 * models. And "shared between automations" is the point of the feature — a
 * per-table schema would forbid one step joining orders to customers.
 *
 * ── WHY row_count AND data_version ARE SCALAR COLUMNS ───────────────
 * App Studio keeps the equivalents in a JSONB blob and bumps them with a
 * `SELECT … FOR UPDATE` read-modify-write on EVERY record write
 * (studioAppDataStore.bumpDataVersion). With one row per scope and routines
 * writing on a schedule, every automation in the org would serialise on that
 * single row. Scalar columns let a write be one arithmetic UPDATE, once per
 * write STEP (per batch, never per row), with no lock.
 *
 * ── TENANCY IS A SCOPE, NOT AN ORGANISATION ─────────────────────────
 * Every row carries `(scope_kind, scope_id)`: `('org', <orgId>)` for a table the
 * organisation owns, `('user', <userId>)` for a PERSONAL one. Both halves are
 * NOT NULL and every query below is narrowed to the pair — the same rule
 * integrationConnectionStore.listGrants enforces by throwing when called
 * unscoped, because an unfiltered list would return every row in the deployment.
 *
 * A personal scope is not a workaround. An account with no organisation is a
 * first-class supported state (auth/accountProvisioning.consumerPlacement says
 * so, and POST /setup's instance operator has none), and the sibling stores
 * already fall back to owner scope — skillStore explicitly DROPPED its
 * `org_id NOT NULL` so an org-less account could create skills. A nullable
 * `organization_id` could not have done this job: `datatable_models` is keyed
 * on the scope, one model document and one physical schema per tenant, and a
 * NULL cannot address a tenant.
 *
 * `organization_id` stays on `datatables` as "the org this table belongs to,
 * NULL for a personal one" — org teardown, the org indexes, the FK to
 * `organizations` and admin queries all need a truthful column to filter on.
 *
 * Authorization is NOT decided here. This store answers "what is there"; who
 * may see it is auth/datatableAccess.gradeForPrincipal, called by the routes
 * and by the runner so the two cannot drift.
 *
 * ── THIS FILE IS A FACADE ───────────────────────────────────────────
 * The implementation lives in ./datatableStore/, a module per domain, behind
 * this stable path — migrateDb.js STORE_MODULES and every
 * require('../stores/datatableStore') caller is unchanged, and a store has to
 * stay a FILE for that registration to resolve. The parts:
 *
 *   scope.js              the tenancy address: the two kinds, and refusing a
 *                         malformed one
 *   schema.js             the four tables, their indexes, and initDB
 *   rowMappers.js         a row → the object callers see, plus the one-commit
 *                         transaction envelope
 *   datatables.js         the `datatables` row and the scope model document:
 *                         create, save, share, edit, bump, delete
 *   retention.js          the sweep's listing, heartbeat and count re-sync
 *   liveChanges.js        the debounced tap that wakes live consumers, and
 *                         the data_version they compare against
 *   grants.js             the explicit per-principal grants
 *   sourceMirrors.js      a table whose ROWS come from elsewhere
 *   definitionSources.js  a table whose COLUMNS follow a definition here
 *   usage.js              the dependents index (which consumer touches what)
 *   projects.js           Solution membership
 *   erasure.js            what a departing account's tables become
 */

'use strict';

const { SCOPE_KINDS, orgScope, userScope, assertScope } = require('./datatableStore/scope');
const { initDB } = require('./datatableStore/schema');
const { newDatatableId, rowToDatatable } = require('./datatableStore/rowMappers');

module.exports = {
    initDB,
    newDatatableId,
    SCOPE_KINDS,
    orgScope,
    userScope,
    assertScope,
    ...require('./datatableStore/datatables'),
    ...require('./datatableStore/retention'),
    ...require('./datatableStore/liveChanges'),
    ...require('./datatableStore/grants'),
    ...require('./datatableStore/sourceMirrors'),
    ...require('./datatableStore/definitionSources'),
    ...require('./datatableStore/usage'),
    ...require('./datatableStore/projects'),
    ...require('./datatableStore/erasure'),
    // test-only
    _rowToDatatable: rowToDatatable,
};
