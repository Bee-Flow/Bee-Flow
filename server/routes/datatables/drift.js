/**
 * Is the model what Postgres actually has, and the button that re-emits the
 * DDL when it is not.
 *
 * Every repair statement is IF NOT EXISTS and the baseline it diffs against is
 * this table with NO fields, so the plan can only ever add — which is what
 * makes it safe to offer as a button rather than as a support procedure.
 */

'use strict';

const datatableStore = require('../../stores/datatableStore');
const datatableDbStore = require('../../stores/datatableDbStore');
const { migrationPlan } = require('../../core/dataEngine/dataModel/migrationPlan');
const { ddlForTable } = require('../../core/dataEngine/dataModel/ddl');
const { PG, keyOf } = require('./engine');
const { requireDatatableGrade, requireManageForOrgScope } = require('./grade');
const { answerDatatableError } = require('./refusals');
const { validate } = require('../../core/http/validate');
const { z } = require('zod');
const { bodyOf } = require('./schemas');
const log = require('../../telemetry/log');

// Neither route takes anything. Said out loud rather than left implicit: the
// repair below is add-only BECAUSE the plan is scoped to this one table from
// the path, so a body key that looks like it narrows or widens it
// (`onlyTableIds`, `dialect`, `force`) must be refused and not ignored.
const NOTHING = bodyOf({});
const NO_QUERY = z.object({}).strict();

/**
 * The columns the model promises that the physical table does not have.
 *
 * `schemaStamp` and `modelVersion` disagreeing is the CHEAP signal, but it only
 * fires for the transaction-shaped failures; a table that was never created at
 * all (the id-less-fields era) can have a perfectly plausible stamp. So the
 * real answer comes from information_schema, through the engine.
 */
async function describeDrift(scope, table) {
    const scopeKey = keyOf(scope);
    const [{ modelVersion }, meta, stamp, live] = await Promise.all([
        datatableStore.getModel(scope),
        datatableStore.getTableMeta(scope, table.id),
        datatableDbStore.getSchemaStamp(scopeKey, scopeKey).catch(() => 0),
        datatableDbStore.schema(scopeKey, scopeKey).catch(() => ({ tables: [] })),
    ]);
    const physical = (live.tables || []).find(t => t.name === table.key) || null;
    const have = new Set((physical?.columns || []).map(c => c.name));
    const missingColumns = (meta?.fields || [])
        .map(f => f && f.key)
        .filter(k => k && !have.has(k));
    return {
        modelVersion,
        schemaStamp: stamp,
        tableExists: !!physical,
        missingColumns,
        // The stamp is only ever BEHIND now (applyMigration takes the GREATEST),
        // so "ahead" would mean somebody wrote it by hand.
        stampBehind: stamp < modelVersion,
        healthy: !!physical && missingColumns.length === 0,
    };
}

function register(router) {
    router.get('/:id/health', requireDatatableGrade('owner'), validate({ query: NO_QUERY }), async (req, res) => {
        try {
            res.json(await describeDrift(req.datatableScope, req.datatable));
        } catch (e) {
            if (answerDatatableError(res, e, req.datatableScope)) return;
            log.error('[datatables] health read failed:', e.message);
            res.status(500).json({ error: 'Could not check this datatable' });
        }
    });

    /**
     * Re-emit this table's own DDL. Every statement is IF NOT EXISTS, so on a
     * healthy table it is a no-op — which is what makes it safe to offer as a
     * button rather than as a support procedure.
     *
     * Scoped to ONE table and add-only by construction: the baseline it diffs
     * against is this table with NO fields, so the planner can only ever produce
     * CREATE TABLE and ADD COLUMN. It can never drop a column the model still has.
     */
    router.post('/:id/repair',
        requireDatatableGrade('owner'),
        requireManageForOrgScope(),
        validate({ body: NOTHING, query: NO_QUERY }),
        async (req, res) => {
            try {
                const scope = req.datatableScope;
                const scopeKey = req.datatableScopeKey;
                const { model, modelVersion } = await datatableStore.getModel(scope);
                const t = (model.tables || []).find(x => x && x.id === req.datatable.id);
                if (!t) return res.status(409).json({ error: 'This datatable is not in the scope model' });

                const stripped = {
                    ...model,
                    tables: (model.tables || []).map(x => (x.id === t.id ? { ...x, fields: [] } : x)),
                };
                const ensure = ddlForTable(t, {
                    tableKeyById: new Map((model.tables || []).map(x => [x.id, x.key])),
                    dialect: 'pg',
                    rowScope: req.datatable.rowScope,
                });
                const plan = migrationPlan(stripped, model, { ...PG, onlyTableIds: [t.id] });
                await datatableDbStore.applyMigration(scopeKey, scopeKey, [ensure, ...plan],
                    { targetVersion: modelVersion });
                res.json({ repaired: true, ...(await describeDrift(scope, req.datatable)) });
            } catch (e) {
                if (answerDatatableError(res, e, req.datatableScope)) return;
                log.error('[datatables] repair failed:', e.message);
                res.status(500).json({ error: 'Could not repair this datatable' });
            }
        });
}

module.exports = { register };
