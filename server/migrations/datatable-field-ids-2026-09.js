/**
 * Migration: give every datatable column a stable id, then build the columns
 * that were never built (2026-09).
 *
 * ── WHAT WENT WRONG ─────────────────────────────────────────────────
 * `/api/datatables` wrote the client's `{key, name, type}` column objects into
 * the org model verbatim. `migrationPlan` matches fields by `id` — its
 * `coerceModelShape` drops any field without a string one, and step 4 asks
 * `oldIds.has(nf.id)`, which for two id-less fields is `has(undefined)` and
 * therefore true. So the planner saw no columns at all:
 *
 *   * creating a table emitted a CREATE TABLE carrying only the system columns;
 *   * adding a column emitted an EMPTY plan, so the route skipped
 *     `applyMigration` altogether and answered 200.
 *
 * The model listed columns the database did not have, and the first honest
 * error arrived much later, from a read: `relation "x" does not exist`, or a
 * missing column. The route fix (dataModel/datatableFields.normalizeFields)
 * stops new tables landing in that state. This migration repairs the ones
 * already stored.
 *
 * ── WHAT IT DOES ────────────────────────────────────────────────────
 * 1. Backfills a `fld_*` id onto every field that has none, per organisation,
 *    under the same row lock a schema save takes.
 * 2. For exactly the organisations it repaired, reconciles the physical schema:
 *    a CREATE TABLE IF NOT EXISTS for every table (the whole table, columns
 *    included, for the ones that never existed) followed by an ADD COLUMN IF
 *    NOT EXISTS for every field (for the ones that exist but are missing
 *    columns). Both halves are natively idempotent in Postgres, and
 *    `applyMigration` additionally tolerates 42701/42P07.
 *
 * ── WHY IT IS SAFE TO RE-RUN ────────────────────────────────────────
 * Self-limiting rather than marker-guarded: after one successful pass no model
 * has an id-less field, so the SELECT finds nothing and the DDL sweep is
 * skipped entirely. An org that fails halfway is retried on the next boot,
 * because its fields are still id-less. Nothing is dropped, renamed or
 * retyped — every statement this emits only ADDS.
 *
 * A failure for one organisation is logged and does not stop the others: one
 * tenant with an unusual model must not hold back everyone else's repair.
 */

const { getAll, getOne, withTransaction } = require('../db');
const { backfillModelFieldIds } = require('../core/dataEngine/dataModel/datatableFields');
const { migrationPlan } = require('../core/dataEngine/dataModel/migrationPlan');

const PG = { dialect: 'pg' };
// applyMigration refuses more than 500 statements in one call.
const MAX_STATEMENTS = 400;

function parseModel(raw) {
    if (raw && typeof raw === 'object') return raw;
    try { return JSON.parse(raw); } catch { return null; }
}

/**
 * Every statement needed to make the physical schema match `model`, assuming
 * nothing about what is already there.
 *
 * Two passes, because one cannot do both jobs: a CREATE TABLE IF NOT EXISTS
 * builds a missing table WITH its columns but is a no-op on a table that
 * already exists, and an ADD COLUMN IF NOT EXISTS fills in a table that exists
 * but is missing columns. Running both covers every state a broken model can
 * be in.
 */
function reconcileDdl(model) {
    const tables = Array.isArray(model?.tables) ? model.tables : [];
    if (!tables.length) return [];
    const createAll = migrationPlan({ tables: [] }, model, PG);
    const columnsOnly = migrationPlan(
        { tables: tables.map(t => ({ ...t, fields: [] })) },
        model,
        PG,
    );
    return [...createAll, ...columnsOnly];
}

async function up() {
    // Nothing to repair before the datatable tables exist — a fresh install
    // reaches this migration with no models at all.
    const probe = await getOne(`SELECT to_regclass('datatable_models') AS t`).catch(() => null);
    if (!probe?.t) return;

    // Scoped, not org-keyed: datatable-scope-2026-09 runs first, so every model
    // row already carries the (scope_kind, scope_id) the engine addresses a
    // tenant by — and a PERSONAL model has no organisation to name here.
    const rows = await getAll(`SELECT scope_kind, scope_id, model FROM datatable_models`);
    const repaired = [];

    for (const row of rows) {
        const scope = { kind: row.scope_kind, id: row.scope_id };
        const label = `${scope.kind}:${scope.id}`;
        const model = parseModel(row.model);
        if (!model) {
            console.warn(`[Migration] datatable-field-ids: scope ${label} has an unreadable model — left alone`);
            continue;
        }
        if (!backfillModelFieldIds(model).changed) continue;   // already healthy

        try {
            const next = await withTransaction(async (client) => {
                // Re-read under the lock a schema save takes: a save landing
                // between the SELECT above and this write would otherwise be
                // overwritten with the stale copy.
                const cur = await client.query(
                    `SELECT model FROM datatable_models
                      WHERE scope_kind = $1 AND scope_id = $2 FOR UPDATE`,
                    [scope.kind, scope.id],
                );
                if (!cur.rows.length) return null;
                const fresh = parseModel(cur.rows[0].model);
                if (!fresh) return null;
                const { model: fixed, changed } = backfillModelFieldIds(fresh);
                if (!changed) return null;
                await client.query(
                    `UPDATE datatable_models
                        SET model = $1::jsonb, model_version = model_version + 1, updated_at = NOW()
                      WHERE scope_kind = $2 AND scope_id = $3`,
                    [JSON.stringify(fixed), scope.kind, scope.id],
                );
                return fixed;
            });
            if (next) repaired.push({ scope, label, model: next });
        } catch (e) {
            console.error(`[Migration] datatable-field-ids: backfill failed for scope ${label}: ${e.message}`);
        }
    }

    if (!repaired.length) return;

    // Required lazily: the store opens an engine, and a migration that merely
    // finds nothing to do should not pay for that.
    const datatableDbStore = require('../stores/datatableDbStore');

    let tablesTouched = 0;
    for (const { scope, label, model } of repaired) {
        const plan = reconcileDdl(model);
        if (!plan.length) continue;
        const key = datatableDbStore.scopeKey(scope);
        try {
            for (let i = 0; i < plan.length; i += MAX_STATEMENTS) {
                await datatableDbStore.applyMigration(key, key, plan.slice(i, i + MAX_STATEMENTS));
            }
            datatableDbStore.invalidate(key);
            tablesTouched += (model.tables || []).length;
        } catch (e) {
            // The model is repaired either way, so the next schema save from
            // the UI will emit the same statements and finish the job.
            console.error(`[Migration] datatable-field-ids: physical repair failed for scope ${label}: ${e.message}`);
        }
    }

    console.log(`[Migration] datatable-field-ids-2026-09 repaired ${repaired.length} scope(s), ${tablesTouched} table(s)`);
}

module.exports = { up, reconcileDdl };
