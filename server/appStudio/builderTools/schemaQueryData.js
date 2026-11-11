// @typecheck strict
'use strict';
// The app_query_data tool schema, in its own file because its read options keep growing;
// schemasPart2.js puts it in its place in the array, so the order and the bytes are unchanged.

// A description names the base words only, so a word added later (vocabularySince.js) moves no pinned text.
const { BASE_FILTER_OPS: FILTER_OPS } = require('../../core/dataEngine/dataModel/vocabularySince');
const { MAX_QUERY_LIMIT } = require('./queryDataArgs');

const APP_QUERY_DATA_SCHEMA = {
    type: 'function',
    function: {
        name: 'app_query_data',
        description: 'Read rows from the app\'s data (owner-scoped, never mutates) — verify seeds landed, inspect real values, or check what a dataset returns. Pass tableId for raw rows (with optional filter/sort) OR datasetId for a saved aggregation, not both. More rows than one page: the answer has more:true and a nextCursor to pass back.',
        parameters: {
            type: 'object',
            properties: {
                tableId: { type: 'string', description: 'Table id (tbl_…) to list rows from.' },
                datasetId: { type: 'string', description: 'Saved dataset id to run instead of a raw table read.' },
                params: { type: 'object', description: 'Literal values for the parameters a dataset declares (datasetId only), e.g. { region: "north" }.' },
                filter: {
                    type: 'array',
                    description: `Optional literal filters: [{field, op, value?}] with ops ${FILTER_OPS.join(', ')}; an entry {any:[clauses]} matches when one of its clauses does.`,
                    items: { type: 'object' },
                },
                match: { type: 'string', enum: ['all', 'any'], description: 'Optional (tableId only): how the filters join. "all" (default) needs every filter; "any" returns a row when ONE matches. An eq clause may carry ci:true to ignore upper/lower case.' },
                search: {
                    type: 'object',
                    description: 'Optional (tableId only): { value: <text>, fields: [<field keys>] } finds rows where ANY of the fields contains the text; it ANDs with filter.',
                    properties: { value: { type: 'string' }, fields: { type: 'array', items: { type: 'string' } } },
                },
                sort: { type: 'object', description: 'Optional { field, dir: "asc"|"desc" } (tableId only).' },
                orderBy: { type: 'array', items: { type: 'object' }, description: 'Optional [{ field, dir }] on up to 3 columns, instead of sort (tableId only).' },
                expand: { type: 'array', items: { type: 'object' }, description: 'Optional (tableId only): take the related row of a relation field along, [{ field: <relation field>, pick?: [<fields of the related table>], as? }]. It lands under <field>_record (or as), read under that table\'s row rules.' },
                fields: { type: 'array', items: { type: 'string' }, description: 'Optional (tableId only): return only these field keys (and id).' },
                limit: { type: 'number', description: `Max rows per call (default 5, max ${MAX_QUERY_LIMIT}; a larger value is clamped and the answer says limitClamped and requestedLimit). Page on with cursor.` },
                cursor: { type: 'string', description: 'The nextCursor of the previous answer, to read the next page.' },
                total: { type: 'boolean', description: 'tableId only: true adds totalRows, how many rows the whole read matches (filter and row rules applied, not just this page).' },
            },
        },
    },
};

module.exports = { APP_QUERY_DATA_SCHEMA };
