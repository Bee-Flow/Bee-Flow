// @typecheck
'use strict';
/**
 * The datatable row tools as an MCP client sees them (routes/mcpDatatableTools.js):
 * the five descriptors, the name sets the dispatcher routes on, and the caps
 * read from the environment (0 = unlimited).
 */

const DEFAULT_ROWS_MAX = 100;
const DEFAULT_PAYLOAD_MAX = 1024 * 1024;
const DEFAULT_QUERY_MAX = 200;
const DEFAULT_QUERY_PAGE = 50;
const DEFAULT_ROWS_PER_MINUTE_TOKEN = 1000;
const DEFAULT_ROWS_PER_MINUTE_USER = 3000;
const LIST_MAX_TABLES = 500;
const MAX_ID_CHARS = 64;

/** A non-negative integer from the environment; 0 = unlimited. */
function envCount(name, fallback) {
    const raw = process.env[name];
    if (raw == null || String(raw).trim() === '') return fallback;
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

const caps = () => ({
    rows: envCount('MCP_DATATABLE_ROWS_MAX', DEFAULT_ROWS_MAX),
    payload: envCount('MCP_DATATABLE_PAYLOAD_MAX_BYTES', DEFAULT_PAYLOAD_MAX),
    query: envCount('MCP_DATATABLE_QUERY_MAX', DEFAULT_QUERY_MAX),
    perToken: envCount('MCP_DATATABLE_ROWS_PER_MINUTE_TOKEN', DEFAULT_ROWS_PER_MINUTE_TOKEN),
    perUser: envCount('MCP_DATATABLE_ROWS_PER_MINUTE_USER', DEFAULT_ROWS_PER_MINUTE_USER),
});

// ── Tool descriptors (MCP shape) ────────────────────────────────────────────

const TABLE_ID = { type: 'string', description: 'The datatable (id from datatables_list).' };

/** @type {any[]} */
const DATATABLE_TOOLS = [
    {
        name: 'datatables_list',
        description: 'List the datatables this account may see: id, name, key, description, whether it is an organisation or personal table, your access (viewer, editor or owner), the row count and whether you may write. Start here to find the datatableId.',
        inputSchema: { type: 'object', properties: {} },
        annotations: { title: 'datatables_list', readOnlyHint: true, destructiveHint: false },
    },
    {
        name: 'datatables_get_schema',
        description: 'The columns of one datatable: key, name, type, required, unique and, for list columns, the allowed options. Use the column KEYS in the row tools. Also says whether you may write and whether the rows are locked (a linked or managed table cannot be written over MCP).',
        inputSchema: { type: 'object', properties: { datatableId: TABLE_ID }, required: ['datatableId'] },
        annotations: { title: 'datatables_get_schema', readOnlyHint: true, destructiveHint: false },
    },
    {
        name: 'datatables_query_rows',
        description: 'Read a page of rows. Optional filters [{field, op, value}] (ops: eq neq gt gte lt lte contains notContains startsWith endsWith in notIn between isNull isNotNull), match "all"|"any", sort + dir, q (text search over the text columns), limit and the cursor of the previous page. Only rows you may see come back. The rows leave Bee Flow for this client: ask for what you need.',
        inputSchema: {
            type: 'object',
            properties: {
                datatableId: TABLE_ID,
                filters: { type: 'array', items: { type: 'object' }, description: 'Conditions, at most 20: {field, op, value}.' },
                match: { type: 'string', enum: ['all', 'any'] },
                sort: { type: 'string', description: 'A column key.' },
                dir: { type: 'string', enum: ['asc', 'desc'] },
                q: { type: 'string', description: 'Text to look for in the text columns.' },
                limit: { type: 'integer', description: `Rows per page (default ${DEFAULT_QUERY_PAGE}; the instance may cap it lower).` },
                cursor: { type: 'string', description: 'The nextCursor of the previous page.' },
            },
            required: ['datatableId'],
        },
        annotations: { title: 'datatables_query_rows', readOnlyHint: true, destructiveHint: false },
    },
    {
        name: 'datatables_insert_rows',
        description: 'Add rows to a datatable. `rows` is a list of objects keyed by column key. Every row is checked against the column types (unknown columns, wrong types, missing required values and unknown list options are refused per row) and the answer has one entry per row: {index, ok, id} or {index, ok:false, error}. Needs editor access to the table. Rows per call are capped (see the error text).',
        inputSchema: {
            type: 'object',
            properties: { datatableId: TABLE_ID, rows: { type: 'array', items: { type: 'object' }, description: 'The rows to add: {columnKey: value}.' } },
            required: ['datatableId', 'rows'],
        },
        annotations: { title: 'datatables_insert_rows', readOnlyHint: false, destructiveHint: false },
    },
    {
        name: 'datatables_update_rows',
        description: 'Change rows by id. `updates` is a list of {id, values, expectedUpdatedAt?}: `values` is a patch (only the columns to change); `expectedUpdatedAt` (the updated_at you read) refuses the change when a colleague edited the row since. One result per update: {index, ok, id} or {index, ok:false, error}. Needs editor access; the same per-row checks as datatables_insert_rows.',
        inputSchema: {
            type: 'object',
            properties: {
                datatableId: TABLE_ID,
                updates: {
                    type: 'array',
                    items: {
                        type: 'object',
                        properties: { id: { type: 'string' }, values: { type: 'object' }, expectedUpdatedAt: { type: 'string' } },
                        required: ['id', 'values'],
                    },
                },
            },
            required: ['datatableId', 'updates'],
        },
        annotations: { title: 'datatables_update_rows', readOnlyHint: false, destructiveHint: false },
    },
];

const DATATABLE_TOOL_NAMES = new Set(DATATABLE_TOOLS.map((t) => t.name));
const WRITE_TOOL_NAMES = new Set(DATATABLE_TOOLS.filter((t) => !t.annotations.readOnlyHint).map((t) => t.name));

module.exports = {
    DATATABLE_TOOLS, DATATABLE_TOOL_NAMES, WRITE_TOOL_NAMES, caps, envCount,
    DEFAULT_QUERY_PAGE, LIST_MAX_TABLES, MAX_ID_CHARS,
};
