/**
 * A row changed IN BEE FLOW → Nextcloud first, then the copy.
 *
 * The contract — the caller's own probe of the copy BEFORE Nextcloud is
 * asked, Nextcloud as the LINKER, only Nextcloud's answer written into the
 * copy, a refusal changing nothing on either side — is every mirror's and
 * lives in ../mirror/writeThrough.makeWriteThrough. What is Nextcloud's is
 * here: the wire shape of a row ([{columnId, value}] pairs, translated by
 * values.localToWire), the three REST calls, and reading a row back.
 *
 * ── WHAT CANNOT BE WRITTEN ──────────────────────────────────────────
 * A derived column (a match relation's `_ref`, an nc relation's `_label`) is
 * filled by the engine and refused here with `derived_column`: the value a
 * person wants to change is the column it derives from. System columns are
 * dropped the way compileInsert drops them. An unknown column is the same
 * CompileError the local path raises.
 */

'use strict';

const queryCompiler = require('../../queryCompiler');
const { SYSTEM_COLUMNS } = require('../../dataModel/vocabulary');
const { makeWriteThrough, sameInstant } = require('../mirror/writeThrough');
const { resolveLinker } = require('./linkerAuth');
const ncApi = require('./ncApi');
const { localToWire } = require('./values');
const { mirrorRowFromNc, fieldsByIdOf } = require('./rows');
const { buildRelationIndexes } = require('./relations');
const { NextcloudSourceError } = require('./errors');
const { KIND, isMirror } = require('./index');

function refOf(source) {
    return source.ncViewId ? { viewId: source.ncViewId, tableId: source.ncTableId } : { tableId: source.ncTableId };
}

/**
 * The caller's `values` → Nextcloud's [{columnId, value}] pairs. Derived and
 * unknown columns refused; system columns dropped.
 */
function toPairs(ctx, values) {
    const source = ctx.table.source;
    const byKey = new Map((ctx.tableMeta.fields || []).filter(f => f && f.key).map(f => [f.key, f]));
    const pairs = [];
    for (const [k, v] of Object.entries(values && typeof values === 'object' && !Array.isArray(values) ? values : {})) {
        if (SYSTEM_COLUMNS.includes(k)) continue;
        const field = byKey.get(k);
        if (!field) throw new queryCompiler.CompileError(`unknown field: ${k}`);
        const entry = source.columnMap && source.columnMap[field.id];
        if (!entry || entry.derived || field.derived) {
            throw new NextcloudSourceError(400, 'derived_column',
                `"${field.name || k}" is filled in from a relation and cannot be set directly — change the column it is derived from.`);
        }
        pairs.push({ columnId: entry.ncColumnId, value: localToWire(v, entry, field) });
    }
    return pairs;
}

async function linkerApi(ctx) {
    const { auth } = await resolveLinker(ctx.table.source, { orgId: ctx.table.organizationId || null });
    return ncApi.forLinker(auth);
}

/** The copy's values for a Nextcloud row, derived columns included. */
async function localValuesFor(ctx, ncRow, { rowId = null } = {}) {
    const idx = await buildRelationIndexes(ctx.scope, ctx.table.source);
    return mirrorRowFromNc(rowId === null ? ncRow : { ...ncRow, id: rowId }, {
        columnMap: ctx.table.source.columnMap,
        fieldsById: fieldsByIdOf(ctx.tableMeta),
        relationIndexes: idx.relationIndexes,
        labelIndexes: idx.labelIndexes,
    });
}

const writes = makeWriteThrough({
    KIND,
    isMirror,
    Err: NextcloudSourceError,
    forbiddenCode: 'nextcloud_forbidden',
    notFoundCodes: new Set(['nextcloud_not_found']),
    toWire: toPairs,
    apiFor: linkerApi,
    async sourceInsert(api, ctx, pairs) {
        const ncRow = await api.createRow(refOf(ctx.table.source), pairs);
        if (!ncRow || ncRow.id === undefined || ncRow.id === null) {
            throw new NextcloudSourceError(502, 'nextcloud_unavailable', 'Nextcloud accepted the row but did not say which row it made.');
        }
        return ncRow;
    },
    sourceUpdate: (api, ctx, rowId, pairs) => api.updateRow(Number(rowId), pairs),
    sourceDelete: (api, ctx, rowId) => api.deleteRow(Number(rowId)),
    localValuesFor,
});

module.exports = { ...writes, toPairs, _sameInstant: sameInstant };
