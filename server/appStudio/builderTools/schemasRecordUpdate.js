// @typecheck strict
'use strict';
// app_update_records, kept out of schemasPart2.js (file-size ceiling). Spliced in right after part 2
// by schemas.js.

const { FILTER_OPS } = require('../dataModel');
const { MAX_UPDATE_RECORDS, MAX_FILTER_UPDATE_ROWS, DEFAULT_FILTER_UPDATE_ROWS } = require('./schemaFragments');

/** @type {Array<{ type: string, function: { name: string, description: string, parameters: object } }>} */
const TOOL_SCHEMAS_RECORD_UPDATE = [
    {
        type: 'function',
        function: {
            name: 'app_update_records',
            description: `Change EXISTING rows of one of the app's own tables, with the same validation, row-level rules and quotas as an update made from the running app (as your role in the app, not as an all-powerful owner: a row your role may not update is refused for that row). Two forms. (1) By id: \`updates\` = [{ id, values }], 1-${MAX_UPDATE_RECORDS} rows; each row gets its own result { id, ok } or { id, ok:false, error } and one bad row never blocks the others. \`values\` is { fieldKey: newValue } and only the keys you pass change. (2) By filter: \`filter\` = [{field, op, value?}] (ops ${FILTER_OPS.join(', ')}; an unknown field is refused) plus \`values\`, \`max\` (1-${MAX_FILTER_UPDATE_ROWS}, default ${DEFAULT_FILTER_UPDATE_ROWS}) and \`dry_run\` (default TRUE: only reports how many rows match and the first ids, nothing is written; pass dry_run:false to apply to at most \`max\` rows, one by one). A LINKED table is refused. Use app_seed_records to ADD rows and app_query_data to find ids.`,
            parameters: {
                type: 'object',
                properties: {
                    tableId: { type: 'string', description: 'The table id (tbl_…).' },
                    updates: {
                        type: 'array',
                        minItems: 1,
                        maxItems: MAX_UPDATE_RECORDS,
                        description: `By-id form, 1-${MAX_UPDATE_RECORDS} entries: [{ id: "rec_…", values: { status: "done" } }].`,
                        items: {
                            type: 'object',
                            properties: {
                                id: { type: 'string', description: 'The record id (rec_…).' },
                                values: { type: 'object', description: '{ fieldKey: newValue }, only the fields to change.' },
                            },
                            required: ['id', 'values'],
                        },
                    },
                    filter: { type: 'array', description: `Filter form: which rows to change, [{field, op, value?}] with ops ${FILTER_OPS.join(', ')}; an entry {any:[clauses]} matches when one of its clauses does. Required and non-empty (an empty filter would match every row).`, items: { type: 'object' } },
                    values: { type: 'object', description: 'Filter form: { fieldKey: newValue } applied to every matching row.' },
                    max: { type: 'integer', minimum: 1, maximum: MAX_FILTER_UPDATE_ROWS, description: `Filter form: most rows to change in this call (default ${DEFAULT_FILTER_UPDATE_ROWS}).` },
                    dry_run: { type: 'boolean', description: 'Filter form: default true = report only, write nothing. Pass false to apply.' },
                },
                required: ['tableId'],
            },
        },
    },
];

module.exports = { TOOL_SCHEMAS_RECORD_UPDATE };
