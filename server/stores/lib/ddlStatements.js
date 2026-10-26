// @typecheck strict
/**
 * stores/lib/ddlStatements.js — what the schema ledger (ddlLedger.js) reads
 * from a statement's text: its key, whether it is schema and nothing else, and
 * which relations it names. Pure, no database.
 */

'use strict';

const crypto = require('node:crypto');

/** @param {string} sql */
function statementKey(sql) {
    return crypto.createHash('sha256').update(sql).digest('hex');
}

/** The statement without its leading whitespace and comments. */
/** @param {string} sql */
function _head(sql) {
    let s = sql;
    for (;;) {
        const t = s.replace(/^\s+/, '');
        if (t.startsWith('--')) { const nl = t.indexOf('\n'); s = nl < 0 ? '' : t.slice(nl + 1); continue; }
        if (t.startsWith('/*')) { const end = t.indexOf('*/'); s = end < 0 ? '' : t.slice(end + 2); continue; }
        return t;
    }
}

const SCHEMA_HEAD = /^(?:CREATE|ALTER|DROP|COMMENT\s+ON|DO)\b/i;
const TEMP_TABLE = /^CREATE\s+(?:(?:GLOBAL|LOCAL)\s+)?(?:TEMP|TEMPORARY)\b/i;
const DATA_STATEMENT = /\b(?:INSERT\s+INTO|UPDATE\s+(?:ONLY\s+)?[\w."$]+(?:\s+(?:AS\s+)?\w+)?\s+SET|DELETE\s+FROM|TRUNCATE|MERGE\s+INTO|COPY\s)/i;

/**
 * True for a statement the ledger may skip once it succeeded: schema only.
 * @param {unknown} sql
 */
function isSchemaOnly(sql) {
    if (typeof sql !== 'string') return false;
    const head = _head(sql);
    return SCHEMA_HEAD.test(head) && !TEMP_TABLE.test(head) && !DATA_STATEMENT.test(sql);
}

const IDENT = '(?:"[^"]+"|[A-Za-z_][\\w$]*)(?:\\.(?:"[^"]+"|[A-Za-z_][\\w$]*))?';
const KIND = '(?:UNLOGGED\\s+)?(?:TABLE|INDEX|SEQUENCE|VIEW|MATERIALIZED\\s+VIEW)';
// Every relation a statement creates, changes, drops or renames to: tables,
// indexes, sequences and views, which is what to_regclass can answer for.
const RELATION_REFS = [
    new RegExp(`\\b(?:CREATE(?:\\s+OR\\s+REPLACE)?|ALTER|DROP)\\s+${KIND}\\s+(?:CONCURRENTLY\\s+)?(?:IF\\s+(?:NOT\\s+)?EXISTS\\s+)?(?:ONLY\\s+)?(${IDENT})`, 'gi'),
    new RegExp(`\\bCREATE\\s+UNIQUE\\s+INDEX\\s+(?:CONCURRENTLY\\s+)?(?:IF\\s+NOT\\s+EXISTS\\s+)?(${IDENT})`, 'gi'),
    new RegExp(`\\bINDEX\\s+(?:CONCURRENTLY\\s+)?(?:IF\\s+NOT\\s+EXISTS\\s+)?(?:${IDENT}\\s+)?ON\\s+(?:ONLY\\s+)?(${IDENT})`, 'gi'),
    new RegExp(`\\bRENAME\\s+TO\\s+(${IDENT})`, 'gi'),
];
const NOT_A_NAME = new Set(['if', 'only', 'on', 'exists', 'not', 'concurrently', 'using']);

/**
 * The relations these statements create, change, drop or rename to, as
 * written (to_regclass reads them). The ledger records the OID of each (null
 * for one that is gone), so a table that was dropped, recreated or restored,
 * or a retired index that came back, makes the whole unit run again.
 * @param {Iterable<string>} statements
 * @returns {string[]}
 */
function relationsIn(statements) {
    const out = new Set();
    for (const sql of statements) {
        for (const re of RELATION_REFS) {
            re.lastIndex = 0;
            for (const m of sql.matchAll(re)) {
                const name = m[1];
                if (!NOT_A_NAME.has(name.toLowerCase())) out.add(name);
            }
        }
    }
    return [...out].sort();
}

module.exports = { statementKey, isSchemaOnly, relationsIn };
