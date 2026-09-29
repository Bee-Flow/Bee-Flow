/**
 * Write a mirror's derived field list into the scope model, with the DDL that
 * follows from it, in ONE transaction — the schema route's own idiom
 * (routes/datatables.js PUT /:id/schema), for the one writer a mirror's
 * columns have.
 *
 * ── RETYPES ARE TWO STATEMENTS, AND THE ORDER IS OURS ───────────────
 * The migration planner does not retype (dataModel/migrationPlan.js says so):
 * it diffs by field id, ADDs before it DROPs, and would read "same key, new
 * id" as ADD-IF-NOT-EXISTS (a no-op on the live column) followed by DROP —
 * losing the column. So a retype is handled here: the OLD field is removed
 * from the `before` model the planner is handed (so it emits only the ADD)
 * and its DROP COLUMN is issued first, explicitly. Dropping a mirror column
 * loses nothing: the source is the truth, and the same pass refills it.
 *
 * No optimistic lock: the sync is the only writer of these fields, and it
 * runs under its own claim (datatableStore.claimSourceSync).
 *
 * Shared by every source kind (a Nextcloud table, a spreadsheet): nothing
 * here knows where the columns came from, only that the source is the truth
 * and that the same pass refills what a retype drops.
 */

'use strict';

const db = require('../../../../db');
const datatableStore = require('../../../../stores/datatableStore');
const datatableDbStore = require('../../../../stores/datatableDbStore');
const { migrationPlan } = require('../../dataModel/migrationPlan');
const { ddlForTable, dropColumnDdl } = require('../../dataModel/ddl');

const PG = { dialect: 'pg' };

/**
 * @param {{kind:string,id:string}} scope
 * @param {object} datatable        the mirror's datatables row
 * @param {Array}  nextFields       the adapter's derived field list (deriveFields)
 * @param {object} [opts]
 * @param {Array}  [opts.retyped]   old fields to DROP first (same column, new type)
 * @returns {Promise<{ modelVersion:number }>}
 */
async function reconcileMirrorSchema(scope, datatable, nextFields, { retyped = [] } = {}) {
    const scopeKey = datatableDbStore.scopeKey(scope);
    const retypedIds = new Set(retyped.map(f => f.id));
    const saved = await db.withTransaction(async (client) => {
        const { model } = await datatableStore.getModel(scope);
        const next = JSON.parse(JSON.stringify(model));
        const t = (next.tables || []).find(x => x && x.id === datatable.id);
        if (!t) {
            const e = new Error('This mirror is not in the scope model');
            e.status = 409;
            e.code = 'mirror_not_in_model';
            throw e;
        }
        t.fields = nextFields;
        t.name = datatable.name;
        return datatableStore.saveModel(scope, next, {
            client,
            applyPhysical: async (c, { before: locked, next: after, modelVersion }) => {
                // The retyped fields' OLD ids leave `before` so the planner
                // emits their ADD; their DROP goes first, by hand.
                const beforeMinus = {
                    ...locked,
                    tables: (locked.tables || []).map(x => (x && x.id === datatable.id
                        ? { ...x, fields: (x.fields || []).filter(f => f && !retypedIds.has(f.id)) }
                        : x)),
                };
                const drops = retyped.filter(f => f && f.key).map(f => dropColumnDdl(t.key, f.key, 'pg'));
                const plan = migrationPlan(beforeMinus, after, { ...PG, onlyTableIds: [datatable.id] });
                if (!drops.length && !plan.length) return;
                const ensure = ddlForTable(t, {
                    tableKeyById: new Map((after.tables || []).map(x => [x.id, x.key])),
                    dialect: 'pg',
                    rowScope: datatable.rowScope,
                });
                await datatableDbStore.applyMigration(scopeKey, scopeKey,
                    [ensure, ...drops, ...plan], { client: c, targetVersion: modelVersion });
            },
        });
    });
    datatableDbStore.invalidate(scopeKey);
    if (!saved || !saved.ok) {
        const e = new Error('Could not save the mirrored columns');
        e.status = 409;
        e.code = 'version_conflict';
        throw e;
    }
    return { modelVersion: saved.modelVersion };
}

module.exports = { reconcileMirrorSchema };
