// @typecheck strict
/**
 * stores/lib/ddlStatements.js — what the schema ledger (ddlLedger.js) reads
 * from a statement's text: its key, whether it is schema and nothing else,
 * whether it only creates what is missing, and which relations it names. Pure,
 * no database.
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

/**
 * The statement text without line and block comments (outside quotes), so
 * a comment cannot make an ALTER look like something else.
 * @param {string} sql
 */
function _stripComments(sql) {
    let out = '';
    for (let i = 0; i < sql.length; i++) {
        const c = sql[i];
        if (c === "'" || c === '"') {
            const end = sql.indexOf(c, i + 1);
            const stop = end < 0 ? sql.length : end + 1;
            out += sql.slice(i, stop);
            i = stop - 1;
        } else if (c === '-' && sql[i + 1] === '-') {
            const nl = sql.indexOf('\n', i);
            i = nl < 0 ? sql.length : nl - 1;
        } else if (c === '/' && sql[i + 1] === '*') {
            const end = sql.indexOf('*/', i + 2);
            i = end < 0 ? sql.length : end + 1;
        } else {
            out += c;
        }
    }
    return out;
}

/**
 * Split on `sep` at the top level only: outside quotes and parentheses.
 * @param {string} text
 * @param {string} sep
 */
function _splitTopLevel(text, sep) {
    /** @type {string[]} */ const parts = [];
    let depth = 0;
    let quote = '';
    let start = 0;
    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (quote) { if (c === quote) quote = ''; continue; }
        if (c === "'" || c === '"') quote = c;
        else if (c === '(') depth++;
        else if (c === ')') depth--;
        else if (c === sep && depth === 0) { parts.push(text.slice(start, i)); start = i + 1; }
    }
    parts.push(text.slice(start));
    return parts.map((x) => x.trim()).filter(Boolean);
}

const CREATE_IF_MISSING = /^CREATE\s+(?:(?:UNLOGGED\s+)?TABLE|(?:UNIQUE\s+)?INDEX(?:\s+CONCURRENTLY)?|SEQUENCE|EXTENSION|SCHEMA)\s+IF\s+NOT\s+EXISTS\s/i;
const ALTER_TABLE_HEAD = /^ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?(?:"[^"]+"|[A-Za-z_][\w$]*)(?:\.(?:"[^"]+"|[A-Za-z_][\w$]*))?\s+/i;
const ADD_COLUMN_IF_MISSING = /^ADD\s+(?:COLUMN\s+)?IF\s+NOT\s+EXISTS\s/i;

/**
 * True only for a statement whose every part creates something WHEN IT IS
 * MISSING and changes nothing that exists: `CREATE TABLE / INDEX / SEQUENCE /
 * EXTENSION / SCHEMA … IF NOT EXISTS`, and `ALTER TABLE` whose every clause is
 * `ADD COLUMN IF NOT EXISTS`. Only these may be skipped once recorded.
 *
 * Everything that makes something SO rather than creating it if missing
 * (CREATE OR REPLACE, SET / DROP DEFAULT, ALTER COLUMN … TYPE, a constraint
 * dropped and added, COMMENT ON, RENAME, DROP …) and every DO block runs on
 * every boot: an older replica during a rolling upgrade may have put its own
 * version back, and a DO block may call anything. A dollar-quoted body is
 * never skipped either.
 * @param {unknown} sql
 */
function isCreateIfMissing(sql) {
    if (!isSchemaOnly(sql) || typeof sql !== 'string' || sql.includes('$')) return false;
    const parts = _splitTopLevel(_stripComments(sql), ';');
    if (parts.length === 0) return false;
    return parts.every((part) => {
        if (CREATE_IF_MISSING.test(part)) return true;
        const head = part.match(ALTER_TABLE_HEAD);
        if (!head) return false;
        const clauses = _splitTopLevel(part.slice(head[0].length), ',');
        return clauses.length > 0 && clauses.every((c) => ADD_COLUMN_IF_MISSING.test(c));
    });
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

module.exports = { statementKey, isSchemaOnly, isCreateIfMissing, relationsIn };
