// @typecheck noImplicitAny
/**
 * Make a MANAGED datatable (dataModel/managedTables.js): the metadata row, the
 * scope model and the CREATE TABLE, in one transaction.
 *
 * Shared by the two places that provision one: POST /api/datatables/managed
 * (a person picks a kind in the Studio) and the spreadsheet document type
 * (core/documents/sheet, which makes the table that holds a sheet's cells).
 * Both share one copy of this transaction; a second copy would be a
 * second place for the quota lock or the physical DDL to drift.
 *
 * What this does NOT do is decide WHO may make the table or WHERE: the caller
 * passes the scope it already authorised. The kind's columns are the
 * contract's own (ids included) and pass through the same normaliser every
 * other create uses.
 *
 * A kind the DOCUMENT makes (`madeByDocument`: a spreadsheet tab) counts on
 * the spreadsheet-tab cap, not on the cap of tables people make
 * (datatableLimits header). Its volume guard is the scope's byte limit, and
 * because `datatable_models.size_bytes` is only refreshed by the retention
 * sweep, the schema is measured here (cached 30 s by the engine) and the
 * larger of the two is what the check sees. A measurement that fails falls
 * back to the stored number rather than refusing the sheet.
 *
 * LAYER: core/. Uses stores/ and the data-model compiler; knows no feature.
 */

'use strict';

const db = require('../../db');
const datatableStore = require('../../stores/datatableStore');
const datatableDbStore = require('../../stores/datatableDbStore');
const { migrationPlan } = require('./dataModel/migrationPlan');
const { ddlForTable } = require('./dataModel/ddl');
const { normalizeFields } = require('./dataModel/datatableFields');
const { assertDatatableQuota } = require('./datatableLimits');
const { fallback } = require('../../utils/bestEffort');

const PG = Object.freeze({ dialect: 'pg' });

/**
 * @param {object} o
 * @param {import('../../stores/datatableStore/scope').DatatableScope} o.scope   an authorised scope (orgScope/userScope)
 * @param {string} o.ownerUserId
 * @param {ReturnType<typeof import('./dataModel/managedTables').managedKindSpec>} o.spec  managedKindSpec(kind)
 * @param {string} o.key
 * @param {string} o.name
 * @param {string} o.description                   the Art. 30 purpose
 * @param {number|null} [o.retentionDays]
 * @param {string|null} [o.projectId]
 * @returns {Promise<object>} the datatable row
 */
async function provisionManagedTable({ scope, ownerUserId, spec, key, name, description, retentionDays = null, projectId = null }) {
    const norm = normalizeFields(spec.fields, []);
    if (!norm.ok || !('fields' in norm)) {
        /** @type {Error & { status?: number }} */
        const e = new Error('error' in norm ? norm.error : 'The managed columns are not valid');
        e.status = 500;
        throw e;
    }
    const scopeKey = datatableDbStore.scopeKey(scope);
    const bySheet = spec.madeByDocument === true;
    const liveBytes = bySheet ? await measuredBytes(scopeKey) : 0;
    try {
        const table = await db.withTransaction(async (client) => (
            datatableStore.createDatatable({
                scope, ownerUserId,
                key, name, description,
                fields: norm.fields,
                managedKind: spec.kind,
                projectId,
                // The whole expiry story: the ordinary sweeper, on the kind's
                // own timestamp column.
                retentionField: spec.retentionField,
                retentionDays,
            }, {
                client,
                assertQuota: (usage) => assertDatatableQuota(scope, bySheet
                    ? { addSheetTables: 1, usage: { ...usage, bytes: Math.max(Number(usage.bytes) || 0, liveBytes) } }
                    : { addTables: 1, usage }),
                applyPhysical: async (c, { before, next, modelVersion }) => {
                    const created = next.tables[next.tables.length - 1];
                    const ensure = ddlForTable(created, {
                        tableKeyById: new Map((next.tables || []).map(x => [x.id, x.key])),
                        dialect: 'pg',
                        rowScope: 'all',
                    });
                    const plan = migrationPlan(before, next, { ...PG, onlyTableIds: [created.id] });
                    await datatableDbStore.applyMigration(scopeKey, scopeKey, [ensure, ...plan],
                        { client: c, targetVersion: modelVersion });
                },
            })
        ));
        datatableDbStore.invalidate(scopeKey);
        return table;
    } catch (e) {
        // The engine memoises "this scope has a model row" inside the
        // transaction that just rolled back; the memo goes with it.
        datatableDbStore.invalidate(scopeKey);
        throw e;
    }
}

/**
 * The scope's on-disk bytes as Postgres has them now; 0 when it cannot say
 * (a scope without a schema yet, or a failed read).
 * @param {string} scopeKey
 */
async function measuredBytes(scopeKey) {
    try {
        return Number(await datatableDbStore.sizeBytes(scopeKey, scopeKey)) || 0;
    } catch (e) {
        // A scope's first table: there is no schema to measure yet.
        if (/** @type {{ status?: number }} */ (e)?.status === 404) return 0;
        return fallback('core/dataEngine/provisionManagedTable:measuredBytes', e, 0);
    }
}

module.exports = { provisionManagedTable };
