// @typecheck
/**
 * The model shape the migration planner diffs, for ./migrationPlan.js and
 * ./retainedColumns.js: which model tables have a physical table, and the
 * minimal, non-throwing coercion of a model to tables and fields.
 */

'use strict';

const { isPlainObject } = require('./shared');

/**
 * Does this model table have a PHYSICAL table in the app database?
 *
 * No as soon as it carries a `source`: its rows live in a Studio datatable,
 * outside the app (core/dataEngine/dataModel/vocabulary.js). Every value other
 * than null/undefined counts as "linked" — exactly as
 * appStudio/datatableSource.isDatatableBacked reads it — because treating a
 * broken `source` silently as own storage is how a table comes about that
 * nobody fills and nobody reads.
 *
 * WHY THIS IS HERE. Without this question a linked table simply got a CREATE
 * TABLE, and that shadow table was not only dead weight: it was the landing
 * place that made a write to the wrong storage SILENT. Without the table such
 * a write gives an SQL error; with the table the INSERT succeeds and the row
 * disappears without a trace. The storage side has since been closed
 * (actionExecutor/records.js); this is the other half of that same wave.
 */
function isPhysical(table) {
    const src = table ? table.source : null;
    return src === undefined || src === null;
}

// A minimal, non-throwing coercion used by migrationPlan so it can diff even a
// partly-shaped model (tables/fields arrays with id+key present). Unlike
// canonicalizeDataModel it doesn't invent ids — migration needs the caller's
// stable ids to be authoritative.
function coerceModelShape(model) {
    const src = isPlainObject(model) ? model : {};
    const tables = (Array.isArray(src.tables) ? src.tables : [])
        .filter(t => isPlainObject(t) && typeof t.id === 'string' && typeof t.key === 'string')
        .map(t => ({
            id: t.id,
            key: t.key,
            // `source` survives the coercion, or the planner sees every table
            // as own storage and the question above is 'yes' by definition.
            source: t.source ?? null,
            fields: (Array.isArray(t.fields) ? t.fields : [])
                .filter(f => isPlainObject(f) && typeof f.id === 'string' && typeof f.key === 'string'),
            // A stage table's retired columns (retainRetired). Ignored otherwise.
            retired: (Array.isArray(t.retired_fields) ? t.retired_fields : [])
                .filter(r => isPlainObject(r) && typeof r.id === 'string'),
        }));
    return { tables };
}

module.exports = { isPhysical, coerceModelShape };
