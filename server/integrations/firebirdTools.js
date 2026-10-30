// @typecheck strict
/**
 * Firebird Tools — read-only access to a Firebird database.
 *
 * Typical use: Syntess Atrium, which runs on Firebird. The user brings their own
 * connection (server, database, account), same model as AFAS and vPlan. Every
 * statement runs in a READ ONLY transaction (firebirdClient.js); on top of that
 * firebird_query refuses anything but a single SELECT/WITH statement
 * (firebirdQuery.guardSql). The tool set has no write operation by design
 * (firebirdTools.test.js asserts that).
 *
 * The host is user-supplied, but private and LAN addresses are allowed on
 * purpose: the Bee Flow server runs inside the customer's network next to the
 * database. FIREBIRD_ALLOWED_HOSTS (comma list, empty = any) restricts it.
 * The password never appears in a result, an error or a log line.
 */
const configStore = require('../stores/configStore');
const log = require('../telemetry/log');
const { FIREBIRD_TOOLS, FIREBIRD_TOOL_NAMES, DEFAULT_LIMIT, getMaxRows, getStatementTimeoutMs } = require('./firebirdToolDefs');
const query = require('./firebirdQuery');
const { runQuery } = require('./firebirdClient');

const HOST_RE = /^[A-Za-z0-9.-]{1,253}$|^\[[0-9A-Fa-f:]{2,45}\]$/;
const PORT_RE = /^([1-9]\d{0,4})$/;
const DATABASE_RE = /^[^\r\n\0]{1,512}$/;
const USER_RE = /^[^\r\n\0:@/\\\s]{1,63}$/;
const PASSWORD_RE = /^[^\r\n\0]{1,255}$/;
const CHARSET_RE = /^[A-Za-z0-9_]{1,31}$/;

const DEFAULT_PORT = 3050;
const DEFAULT_CHARSET = 'UTF8';
const MAX_PARAMS = 100;
const NOT_CONFIGURED = 'Firebird database not configured. Add the server, database and account in Settings → Connections.';

/** @typedef {import('./firebirdClient').FirebirdCreds} FirebirdCreds */

/**
 * The tool arguments as the model sends them.
 * @typedef {{ search?: unknown, limit?: unknown, table?: unknown, sql?: unknown, params?: unknown }} FirebirdArgs
 */

// ─── Credentials ───────────────────────────────────────────────

/**
 * @param {string} userId
 * @param {string} key
 */
async function secret(userId, key) {
    const value = await configStore.getSecret(`firebird_${key}_user_${userId}`);
    return value === null || value === undefined ? '' : String(value).trim();
}

/**
 * The stored connection of a user, or null when a required part is missing.
 * Values are NOT validated here; assertValidCredentials does that before use.
 * @param {string} userId
 * @returns {Promise<{ host: string, port: string, database: string, user: string, password: string, charset: string } | null>}
 */
async function getFirebirdCredentials(userId) {
    const host = await secret(userId, 'host');
    const database = await secret(userId, 'database');
    const user = await secret(userId, 'user');
    const password = await secret(userId, 'password');
    if (!host || !database || !user || !password) return null;
    return { host, port: await secret(userId, 'port'), database, user, password, charset: await secret(userId, 'charset') };
}

/**
 * Hosts the operator allows (FIREBIRD_ALLOWED_HOSTS), lower-cased; empty means any.
 * @returns {string[]}
 */
function allowedHosts() {
    return (process.env.FIREBIRD_ALLOWED_HOSTS || '').split(',').map(h => h.trim().toLowerCase()).filter(Boolean);
}

/**
 * @param {string} host
 */
function assertAllowedHost(host) {
    if (!HOST_RE.test(host)) throw new Error('The Firebird server name has an invalid format (host name or IP address only, no scheme or path).');
    const allowed = allowedHosts();
    if (allowed.length && !allowed.includes(host.toLowerCase())) throw new Error('This Firebird server is not in the list of allowed hosts.');
}

/**
 * Validate raw connection values and return the normalised connection. Throws an Error naming the bad field.
 * @param {{ host?: unknown, port?: unknown, database?: unknown, user?: unknown, password?: unknown, charset?: unknown }} raw
 * @returns {FirebirdCreds}
 */
function assertValidCredentials(raw) {
    const host = String(raw.host ?? '').trim();
    const portText = String(raw.port ?? '').trim() || String(DEFAULT_PORT);
    const database = String(raw.database ?? '').trim();
    const user = String(raw.user ?? '').trim();
    const password = String(raw.password ?? '');
    const charset = String(raw.charset ?? '').trim() || DEFAULT_CHARSET;
    assertAllowedHost(host);
    const port = Number(portText);
    if (!PORT_RE.test(portText) || port > 65535) throw new Error('The Firebird port must be a number between 1 and 65535.');
    /** @type {[RegExp, string, string][]} */
    const checks = [
        [DATABASE_RE, database, 'database name or path'],
        [USER_RE, user, 'user name'],
        [PASSWORD_RE, password, 'password'],
        [CHARSET_RE, charset, 'character set'],
    ];
    for (const [re, value, label] of checks) {
        if (!re.test(value)) throw new Error(`The Firebird ${label} has an invalid format.`);
    }
    return { host, port, database, user, password, charset };
}

// ─── Result shaping ────────────────────────────────────────────

/**
 * Apply the output budget to a query result and build the envelope the tools return.
 * @param {import('./firebirdClient').QueryResult} result
 */
function shapeRows(result) {
    const { rows, truncated: overBudget } = query.truncateRows(result.rows);
    const truncated = result.truncated || overBudget;
    /** @type {{ data: unknown[], count: number, truncated: boolean, message?: string }} */
    const out = { data: rows, count: rows.length, truncated };
    if (overBudget) {
        out.message = `Response too large: showing ${rows.length} of ${result.rows.length} fetched rows. Select fewer columns or add a WHERE clause.`;
    } else if (truncated) {
        out.message = 'More rows are available than were returned. Narrow the query or raise limit.';
    }
    return out;
}

/** @param {unknown} value */
function optionalText(value) {
    const t = query.text(value);
    return t === null ? undefined : t;
}

// ─── Tools ─────────────────────────────────────────────────────

/** @param {FirebirdCreds} creds */
async function whoami(creds) {
    const { rows } = await runQuery(creds, query.SYSTEM_INFO_SQL, [], { limit: 1 });
    const row = rows[0] || {};
    return {
        server_version: query.text(row.SERVER_VERSION),
        database: creds.database,
        user: creds.user,
        charset: creds.charset,
        table_count: Number(row.TABLE_COUNT) || 0,
    };
}

/**
 * @param {FirebirdCreds} creds
 * @param {FirebirdArgs} args
 */
async function listTables(creds, args) {
    const search = optionalText(args.search);
    if (search !== undefined && search.length > 63) throw new Error('search is too long (max 63 characters).');
    const sql = query.listTablesSql(search !== undefined);
    const result = await runQuery(creds, sql, search !== undefined ? [search.toUpperCase()] : [], { limit: query.clampLimit(args.limit) });
    const data = result.rows.map((r) => {
        /** @type {{ name: unknown, kind: unknown, description?: string }} */
        const table = { name: r.NAME, kind: r.KIND };
        const description = query.text(r.DESCRIPTION);
        if (description) table.description = description;
        return table;
    });
    return shapeRows({ ...result, rows: data });
}

/**
 * @param {import('./firebirdClient').QueryResult} columns
 * @param {Set<string>} primaryKey
 */
function mapColumns(columns, primaryKey) {
    return columns.rows.map((c) => {
        const name = String(c.NAME);
        /** @type {{ name: string, type: string, nullable: boolean, primary_key: boolean, default?: string, description?: string }} */
        const column = {
            name,
            type: query.typeName(c),
            nullable: !c.NULL_FLAG,
            primary_key: primaryKey.has(name),
        };
        const def = query.text(c.DEFAULT_SOURCE);
        if (def) column.default = def.replace(/^DEFAULT\s+/i, '');
        const description = query.text(c.DESCRIPTION);
        if (description) column.description = description;
        return column;
    });
}

/**
 * One entry per constraint, its columns in order.
 * @param {Record<string, unknown>[]} rows
 */
function groupForeignKeys(rows) {
    /** @type {Map<string, { columns: string[], references_table: string, references_columns: string[] }>} */
    const byName = new Map();
    for (const r of rows) {
        const key = String(r.CONSTRAINT_NAME);
        const fk = byName.get(key) || { columns: [], references_table: String(r.REF_TABLE), references_columns: [] };
        fk.columns.push(String(r.COLUMN_NAME));
        fk.references_columns.push(String(r.REF_COLUMN));
        byName.set(key, fk);
    }
    return [...byName.values()];
}

/**
 * @param {FirebirdCreds} creds
 * @param {FirebirdArgs} args
 */
async function describeTable(creds, args) {
    const table = query.parseIdentifier(args.table);
    const columns = await runQuery(creds, query.COLUMNS_SQL, [table], { limit: Infinity });
    if (columns.rows.length === 0) throw new Error(`Table or view "${table}" not found. Use firebird_list_tables to see the names.`);
    const pk = await runQuery(creds, query.PRIMARY_KEY_SQL, [table], { limit: Infinity });
    const fks = await runQuery(creds, query.FOREIGN_KEYS_SQL, [table], { limit: Infinity });
    const primaryKey = pk.rows.map(r => String(r.COLUMN_NAME));
    return {
        table,
        columns: mapColumns(columns, new Set(primaryKey)),
        primary_key: primaryKey,
        foreign_keys: groupForeignKeys(fks.rows),
    };
}

/**
 * @param {FirebirdCreds} creds
 * @param {FirebirdArgs} args
 */
async function sampleRows(creds, args) {
    const quoted = query.quoteIdentifier(args.table);
    const limit = query.clampLimit(args.limit);
    const first = Number.isFinite(limit) ? `FIRST ${limit + 1} ` : '';
    return shapeRows(await runQuery(creds, `SELECT ${first}* FROM ${quoted}`, [], { limit }));
}

/**
 * @param {unknown} raw
 * @returns {(string | number | boolean | null)[]}
 */
function validateParams(raw) {
    if (raw === undefined || raw === null) return [];
    if (!Array.isArray(raw)) throw new Error('params must be an array.');
    if (raw.length > MAX_PARAMS) throw new Error(`Too many params (max ${MAX_PARAMS}).`);
    for (const p of raw) {
        const ok = p === null || ['string', 'number', 'boolean'].includes(typeof p);
        if (!ok) throw new Error('params may only contain strings, numbers, booleans and null.');
    }
    return raw;
}

/**
 * @param {FirebirdCreds} creds
 * @param {FirebirdArgs} args
 */
async function runSelect(creds, args) {
    const sql = query.guardSql(args.sql);
    const params = validateParams(args.params);
    const result = await runQuery(creds, sql, params, { limit: query.clampLimit(args.limit) });
    return { ...shapeRows(result), columns: result.columns };
}

/**
 * @param {string} toolName
 * @param {FirebirdArgs} args
 * @param {FirebirdCreds} creds
 */
async function runFirebirdTool(toolName, args, creds) {
    switch (toolName) {
        case 'firebird_whoami': return whoami(creds);
        case 'firebird_list_tables': return listTables(creds, args);
        case 'firebird_describe_table': return describeTable(creds, args);
        case 'firebird_sample_rows': return sampleRows(creds, args);
        case 'firebird_query': return runSelect(creds, args);
        default: throw new Error(`Unknown Firebird tool: ${toolName}`);
    }
}

/**
 * @param {string} toolName
 */
function isFirebirdTool(toolName) {
    return FIREBIRD_TOOL_NAMES.has(toolName);
}

/**
 * @param {string} toolName
 * @param {FirebirdArgs | undefined} args
 * @param {string} userId
 * @returns {Promise<Record<string, unknown>>}
 */
async function executeFirebirdTool(toolName, args, userId) {
    if (!userId) return { error: 'User context required for Firebird.' };
    if (!isFirebirdTool(toolName)) return { error: `Unknown Firebird tool: ${toolName}` };

    const stored = await getFirebirdCredentials(userId);
    if (!stored) return { error: NOT_CONFIGURED };

    try {
        const creds = assertValidCredentials(stored);
        log.info(`[Firebird] ${toolName}`);
        return await runFirebirdTool(toolName, args || {}, creds);
    } catch (err) {
        const message = /** @type {Error} */ (err).message;
        log.warn(`[Firebird] ${toolName} failed: ${message}`);
        return { error: `Firebird: ${message}` };
    }
}

/**
 * Try a connection (stored or not yet saved) for the settings test button.
 * @param {{ host?: unknown, port?: unknown, database?: unknown, user?: unknown, password?: unknown, charset?: unknown }} rawCreds
 * @returns {Promise<{ ok: boolean, server_version?: string | null, table_count?: number, error?: string }>}
 */
async function testFirebirdConnection(rawCreds) {
    try {
        const creds = assertValidCredentials(rawCreds || {});
        const info = await whoami(creds);
        return { ok: true, server_version: info.server_version, table_count: info.table_count };
    } catch (err) {
        return { ok: false, error: /** @type {Error} */ (err).message };
    }
}

module.exports = {
    FIREBIRD_TOOLS,
    FIREBIRD_TOOL_NAMES,
    executeFirebirdTool,
    isFirebirdTool,
    testFirebirdConnection,
    getFirebirdCredentials,
    HOST_RE,
    PORT_RE,
    DATABASE_RE,
    USER_RE,
    PASSWORD_RE,
    CHARSET_RE,
    // Pure helpers exported for unit tests.
    assertValidCredentials,
    guardSql: query.guardSql,
    parseIdentifier: query.parseIdentifier,
    quoteIdentifier: query.quoteIdentifier,
    clampLimit: query.clampLimit,
    typeName: query.typeName,
    serialiseValue: query.serialiseValue,
    truncateRows: query.truncateRows,
    DEFAULT_LIMIT,
    getMaxRows,
    getStatementTimeoutMs,
};
