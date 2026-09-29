// @typecheck
'use strict';

/**
 * The four tables, and the boot-time DDL that keeps them true.
 *
 * `datatables`, `datatable_models`, `datatable_grants` and
 * `automation_datatable_usage` — why each exists, and why the dependents index
 * is NOT renamed, is written out in the header of stores/datatableStore.js.
 * This module owns only the statements: the CREATE TABLEs, the ADD COLUMN IF
 * NOT EXISTS ladder that a rolling deploy reads correctly from both sides, the
 * partial indexes, the one CHECK that had to be widened, and the `initDB` every
 * other module awaits before it queries.
 *
 * It is reached through the stores/datatableStore.js facade, which is what
 * migrateDb.js STORE_MODULES registers — see the EXEMPT entry for this file in
 * migrateDb.registration.test.js.
 */

const { getOne, exec } = require('../../db');
const { makeStoreInit } = require('../lib/storeInit');

async function createSchema() {
    await exec(`
        CREATE TABLE IF NOT EXISTS datatables (
            id               TEXT PRIMARY KEY,
            scope_kind       TEXT NOT NULL DEFAULT 'org',
            scope_id         TEXT NOT NULL,
            organization_id  TEXT,
            owner_user_id    TEXT NOT NULL,
            project_id       TEXT,
            key              TEXT NOT NULL,
            name             TEXT NOT NULL,
            description      TEXT NOT NULL DEFAULT '',
            lawful_basis     TEXT,
            is_published     BOOLEAN NOT NULL DEFAULT FALSE,
            shared_groups    JSONB   NOT NULL DEFAULT '[]'::jsonb,
            write_mode       TEXT    NOT NULL DEFAULT 'grants',
            row_scope        TEXT    NOT NULL DEFAULT 'all',
            retention_days   INTEGER,
            retention_field  TEXT    NOT NULL DEFAULT 'created_at',
            subject_column   TEXT,
            last_retention_at TIMESTAMPTZ,
            row_count        INTEGER NOT NULL DEFAULT 0,
            data_version     INTEGER NOT NULL DEFAULT 0,
            created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    `);
    // The sweep's heartbeat, added after `datatables` shipped. Not folded into
    // a migration because it is one nullable column with no backfill: an
    // existing row's NULL reads correctly as "never swept", which is exactly
    // what it is. jobs/datatableRetention stamps it, and a control that
    // promises deletion has to be able to show when deletion last happened.
    await exec(`ALTER TABLE datatables ADD COLUMN IF NOT EXISTS last_retention_at TIMESTAMPTZ`);
    // A table whose COLUMNS the platform owns — see
    // core/dataEngine/dataModel/managedTables.js. NULL is an ordinary table, so
    // every existing row already reads correctly and there is nothing to
    // backfill. Emitted here as well as in migrations/datatable-managed-kind-
    // 2026-09 because this store initialises independently of the automation
    // migration ladder, and a create against a column that does not exist yet
    // is a 500 at exactly the moment somebody first uses the feature.
    await exec(`ALTER TABLE datatables ADD COLUMN IF NOT EXISTS managed_kind TEXT`);
    // A table whose ROWS come from elsewhere — a Nextcloud Tables mirror
    // (core/dataEngine/sources/nextcloudTable). `source` is where the rows come
    // from and how the columns map, `sync_state` how the last fetch went. Same
    // dual-emission story as managed_kind: migrations/datatable-nextcloud-
    // source-2026-09 has them too, and NULL is what every existing row is.
    await exec(`ALTER TABLE datatables ADD COLUMN IF NOT EXISTS source JSONB`);
    await exec(`ALTER TABLE datatables ADD COLUMN IF NOT EXISTS sync_state JSONB`);
    // One physical table name per SCOPE. Case-insensitive so "Orders" and
    // "orders" cannot both exist and confuse the picker.
    await exec(`CREATE UNIQUE INDEX IF NOT EXISTS uq_datatables_scope_key ON datatables(scope_kind, scope_id, lower(key))`);
    await exec(`CREATE INDEX IF NOT EXISTS idx_datatables_scope ON datatables(scope_kind, scope_id)`);
    await exec(`CREATE INDEX IF NOT EXISTS idx_datatables_org ON datatables(organization_id)`);
    await exec(`CREATE INDEX IF NOT EXISTS idx_datatables_org_pub ON datatables(organization_id, is_published)`);
    await exec(`CREATE INDEX IF NOT EXISTS idx_datatables_owner ON datatables(owner_user_id)`);
    await exec(`CREATE INDEX IF NOT EXISTS idx_datatables_retention ON datatables(retention_days) WHERE retention_days IS NOT NULL`);
    await exec(`CREATE INDEX IF NOT EXISTS idx_datatables_managed ON datatables(scope_kind, scope_id, managed_kind) WHERE managed_kind IS NOT NULL`);
    await exec(`CREATE INDEX IF NOT EXISTS idx_datatables_project ON datatables(project_id) WHERE project_id IS NOT NULL`);
    await exec(`CREATE INDEX IF NOT EXISTS idx_datatables_nc_table ON datatables (organization_id, ((source->>'ncTableId')::int)) WHERE managed_kind = 'nextcloud_table'`);
    await exec(`CREATE INDEX IF NOT EXISTS idx_datatables_nc_due ON datatables ((sync_state->>'nextRunAt')) WHERE managed_kind = 'nextcloud_table'`);
    // The second source kind (a spreadsheet file): the file-event fan-out and
    // one due-list index over BOTH kinds. Text expressions only — a `::int` or
    // `::timestamptz` cast is not IMMUTABLE and Postgres refuses it in an
    // index. Same dual emission as above: migrations/datatable-spreadsheet-
    // source-2026-09 has them too.
    await exec(`CREATE INDEX IF NOT EXISTS idx_datatables_source_file ON datatables (organization_id, (source->>'provider'), (source->'file'->>'id')) WHERE managed_kind = 'spreadsheet_file'`);
    await exec(`CREATE INDEX IF NOT EXISTS idx_datatables_source_due ON datatables ((sync_state->>'nextRunAt')) WHERE managed_kind IN ('nextcloud_table', 'spreadsheet_file')`);
    // The definition-owned kind (a form's answers): "which table holds the
    // answers to routine X" on every routine save and every submission. Text
    // expression, same IMMUTABLE rule; dual emission in
    // migrations/datatable-form-answers-2026-09.
    await exec(`CREATE INDEX IF NOT EXISTS idx_datatables_form_answers_automation ON datatables ((source->>'automationId')) WHERE managed_kind = 'form_answers'`);

    await exec(`
        CREATE TABLE IF NOT EXISTS datatable_models (
            scope_kind       TEXT NOT NULL DEFAULT 'org',
            scope_id         TEXT NOT NULL,
            organization_id  TEXT,
            model            JSONB   NOT NULL DEFAULT '{}'::jsonb,
            model_version    INTEGER NOT NULL DEFAULT 0,
            schema_stamp     INTEGER NOT NULL DEFAULT 0,
            size_bytes       BIGINT  NOT NULL DEFAULT 0,
            created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            PRIMARY KEY (scope_kind, scope_id)
        )
    `);

    await exec(`
        CREATE TABLE IF NOT EXISTS datatable_grants (
            id             TEXT PRIMARY KEY,
            datatable_id   TEXT NOT NULL REFERENCES datatables(id) ON DELETE CASCADE,
            scope_kind     TEXT NOT NULL DEFAULT 'org',
            scope_id       TEXT,
            grantee_type   TEXT NOT NULL CHECK (grantee_type IN ('user','group')),
            grantee_id     TEXT NOT NULL,
            grade          TEXT NOT NULL CHECK (grade IN ('viewer','editor')),
            granted_by     TEXT NOT NULL,
            created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    `);
    await exec(`CREATE UNIQUE INDEX IF NOT EXISTS uq_datatable_grants ON datatable_grants(datatable_id, grantee_type, grantee_id)`);
    await exec(`CREATE INDEX IF NOT EXISTS idx_datatable_grants_grantee ON datatable_grants(grantee_type, grantee_id)`);

    await exec(`
        CREATE TABLE IF NOT EXISTS automation_datatable_usage (
            scope_kind      TEXT NOT NULL DEFAULT 'org',
            scope_id        TEXT,
            organization_id TEXT,
            datatable_id    TEXT NOT NULL REFERENCES datatables(id) ON DELETE CASCADE,
            automation_id   TEXT NOT NULL,
            step_id         TEXT NOT NULL,
            consumer_kind   TEXT NOT NULL DEFAULT 'automation',
            mode            TEXT NOT NULL CHECK (mode IN ('read','write','readwrite')),
            columns         JSONB NOT NULL DEFAULT '[]'::jsonb,
            updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            PRIMARY KEY (automation_id, step_id)
        )
    `);
    // The generic-consumer column, for a table that predates it. Metadata-only
    // (a DEFAULT on an ADD COLUMN is not a rewrite in Postgres 11+), so it is
    // safe under a rolling deploy: an old replica's INSERT names its columns
    // explicitly and gets the default, and its `SELECT u.*` simply carries one
    // more field. Every existing row IS a routine's, so the default is also the
    // backfill.
    await exec(`ALTER TABLE automation_datatable_usage ADD COLUMN IF NOT EXISTS consumer_kind TEXT NOT NULL DEFAULT 'automation'`);
    await widenUsageModeCheck();
    await exec(`CREATE INDEX IF NOT EXISTS idx_dt_usage_table ON automation_datatable_usage(datatable_id)`);
    await exec(`CREATE INDEX IF NOT EXISTS idx_dt_usage_org ON automation_datatable_usage(organization_id)`);
    await exec(`CREATE INDEX IF NOT EXISTS idx_dt_usage_scope ON automation_datatable_usage(scope_kind, scope_id)`);
    await exec(`CREATE INDEX IF NOT EXISTS idx_dt_usage_consumer ON automation_datatable_usage(consumer_kind, automation_id)`);
}

/**
 * Let `mode` be 'readwrite' as well as 'read' | 'write'.
 *
 * An app table binding is one consumer that both reads and writes, where a
 * routine step is always one or the other. The original CHECK only knew the
 * pair. Widening a CHECK is drop-and-add, so it is asked of pg_constraint
 * first and done ONCE: a boot that finds the wider constraint does nothing,
 * and two replicas racing here are harmless — the loser's DROP is IF EXISTS
 * and its ADD fails on the name, which makeStoreInit retries on first use,
 * by which time the question is already answered. Safe under old replicas:
 * they only ever write the two values the wider set still contains.
 */
async function widenUsageModeCheck() {
    const chk = await getOne(
        `SELECT conname, pg_get_constraintdef(oid) AS def
           FROM pg_constraint
          WHERE conrelid = 'automation_datatable_usage'::regclass
            AND contype = 'c' AND pg_get_constraintdef(oid) ILIKE '%mode%'`,
    );
    if (!chk || /readwrite/.test(String(chk.def || ''))) return;
    const name = String(chk.conname).replace(/"/g, '""');
    await exec(`ALTER TABLE automation_datatable_usage DROP CONSTRAINT IF EXISTS "${name}"`);
    await exec(`ALTER TABLE automation_datatable_usage
                  ADD CONSTRAINT automation_datatable_usage_mode_check
                  CHECK (mode IN ('read','write','readwrite'))`);
}

const initDB = makeStoreInit('DatatableStore', createSchema);

module.exports = {
    createSchema,
    widenUsageModeCheck,
    initDB,
};
