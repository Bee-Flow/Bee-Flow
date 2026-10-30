// @typecheck strict
/**
 * Tool definitions and limits for the read-only Firebird database integration
 * (typical use: Syntess Atrium, which runs on Firebird). The tool set contains
 * no write operation by design; firebirdTools.test.js asserts that.
 */

const DEFAULT_LIMIT = 100;
const DEFAULT_MAX_ROWS = 1000;
const DEFAULT_STATEMENT_TIMEOUT_MS = 20000;
const CONNECT_TIMEOUT_MS = 10000;
const MAX_OUTPUT_CHARS = 30000;
const MAX_TEXT_CHARS = 2000;

/**
 * A non-negative integer from the environment; unset or malformed gives the fallback.
 * Read at call time so a test (or an operator) can change it without a reload.
 * @param {string} name
 * @param {number} fallback
 */
function envInt(name, fallback) {
    const raw = process.env[name];
    if (raw === undefined || raw === '') return fallback;
    const n = Number.parseInt(raw, 10);
    return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/** Row cap per call. Infinity when FIREBIRD_MAX_ROWS is 0 (unlimited). */
function getMaxRows() {
    const n = envInt('FIREBIRD_MAX_ROWS', DEFAULT_MAX_ROWS);
    return n === 0 ? Infinity : n;
}

/** Statement timeout in ms; 0 means no timeout. */
function getStatementTimeoutMs() {
    return envInt('FIREBIRD_STATEMENT_TIMEOUT_MS', DEFAULT_STATEMENT_TIMEOUT_MS);
}

/**
 * @param {string} name
 * @param {string} description
 * @param {Record<string, unknown>} parameters
 */
function fn(name, description, parameters) {
    return { type: 'function', function: { name, description, parameters } };
}

const TABLE_PARAM = {
    type: 'string',
    description: 'Table or view name as returned by firebird_list_tables (letters, digits, underscore, $). Unquoted names are matched upper-case; wrap a name in double quotes to keep its exact case.',
};

const LIMIT_PARAM = {
    type: 'integer',
    description: `Maximum number of rows (default ${DEFAULT_LIMIT}, capped by the server setting FIREBIRD_MAX_ROWS)`,
};

const FIREBIRD_TOOLS = [
    fn(
        'firebird_whoami',
        'Check the Firebird database connection and show the server version, database, account, character set and the number of user tables. Read-only. Use this first to confirm the connection works (typical use: Syntess Atrium).',
        { type: 'object', properties: {}, required: [] },
    ),
    fn(
        'firebird_list_tables',
        'List the tables and views of the Firebird database (system tables excluded), with their description when the schema has one. Use the optional search text to find a table by part of its name. Read-only.',
        {
            type: 'object',
            properties: {
                search: { type: 'string', description: 'Optional: only tables or views whose name contains this text (case-insensitive)' },
                limit: LIMIT_PARAM,
            },
            required: [],
        },
    ),
    fn(
        'firebird_describe_table',
        'Describe one Firebird table or view: every column with its type, nullability, default and description, plus the primary key and the foreign keys to other tables. Use this before writing a firebird_query statement. Read-only.',
        { type: 'object', properties: { table: TABLE_PARAM }, required: ['table'] },
    ),
    fn(
        'firebird_sample_rows',
        'Return the first rows of one Firebird table or view, to see what the data looks like. Text BLOBs are capped and binary BLOBs are summarised. Read-only.',
        { type: 'object', properties: { table: TABLE_PARAM, limit: LIMIT_PARAM }, required: ['table'] },
    ),
    fn(
        'firebird_query',
        'Run one read-only SQL statement (SELECT or WITH ... SELECT, Firebird dialect 3) against the Firebird database and return the rows. Only a single statement is accepted; anything that writes or changes the schema is rejected. Use Firebird syntax: FIRST n / ROWS n instead of LIMIT, || for concatenation. Pass values as ? placeholders with the params array instead of pasting them into the SQL.',
        {
            type: 'object',
            properties: {
                sql: { type: 'string', description: 'One SELECT (or WITH ... SELECT) statement. A single trailing semicolon is allowed.' },
                params: {
                    type: 'array',
                    description: 'Optional values for the ? placeholders, in order',
                    items: { type: ['string', 'number', 'boolean', 'null'] },
                },
                limit: LIMIT_PARAM,
            },
            required: ['sql'],
        },
    ),
];

const FIREBIRD_TOOL_NAMES = new Set(FIREBIRD_TOOLS.map(t => t.function.name));

module.exports = {
    DEFAULT_LIMIT,
    CONNECT_TIMEOUT_MS,
    MAX_OUTPUT_CHARS,
    MAX_TEXT_CHARS,
    FIREBIRD_TOOLS,
    FIREBIRD_TOOL_NAMES,
    getMaxRows,
    getStatementTimeoutMs,
};
