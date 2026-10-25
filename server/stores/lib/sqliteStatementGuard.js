// @typecheck
'use strict';

/**
 * Statement check for page databases (webpage data.db, App Studio app db).
 *
 * A page database is one file. The statements an author or a page may run are
 * limited to data and schema work inside that file; anything that names another
 * file, changes connection state or reads server-side configuration is refused
 * before it reaches SQLite. better-sqlite3 exposes no authorizer and no
 * per-connection limit setter, so the check works on the statement text: a
 * small tokenizer (comments, string literals and quoted identifiers are
 * understood, so text inside them never counts) and an allow-list of statement
 * kinds.
 */

const NOT_ALLOWED_MESSAGE = 'This statement is not allowed in a page database';

/** First keyword(s) a statement may start with. */
const ALLOWED_FIRST = new Set([
    'select', 'with', 'values', 'insert', 'update', 'delete', 'replace',
    'create', 'drop', 'alter', 'reindex', 'analyze',
    'begin', 'commit', 'end', 'rollback', 'savepoint', 'release',
    'pragma',
]);

/** Read-only PRAGMAs (also reachable as the pragma_<name> table-valued functions). */
const ALLOWED_PRAGMAS = new Set([
    'table_info', 'table_xinfo', 'index_list', 'index_info', 'index_xinfo', 'foreign_key_list',
]);

/** Keywords and functions that are refused wherever they appear. */
const DENIED_WORDS = new Set(['attach', 'detach', 'vacuum', 'load_extension', 'fts3_tokenizer']);

/** What may follow CREATE. */
const CREATE_KINDS = new Set(['table', 'index', 'view', 'trigger', 'virtual', 'unique']);

function refuse() {
    throw new Error(NOT_ALLOWED_MESSAGE);
}

/**
 * Split SQL text into statements of tokens. Word tokens are lower-cased;
 * quoted identifiers become { quoted: name }; punctuation is a one-char string.
 * String literals are dropped (their content is data, not syntax).
 * @param {string} sql
 * @returns {Array<Array<string | { quoted: string }>>}
 */
function tokenize(sql) {
    /** @type {Array<Array<string | { quoted: string }>>} */
    const statements = [];
    /** @type {Array<string | { quoted: string }>} */
    let cur = [];
    let caseDepth = 0;
    let inTrigger = false;
    let triggerClosed = false;
    const n = sql.length;
    let i = 0;
    const endStatement = () => {
        if (cur.length) statements.push(cur);
        cur = [];
        caseDepth = 0;
        inTrigger = false;
        triggerClosed = false;
    };
    while (i < n) {
        const c = sql[i];
        if (c === '-' && sql[i + 1] === '-') {
            while (i < n && sql[i] !== '\n') i++;
        } else if (c === '/' && sql[i + 1] === '*') {
            const end = sql.indexOf('*/', i + 2);
            if (end === -1) refuse(); // unterminated: fail closed
            i = end + 2;
        } else if (c === "'") {
            i++;
            while (i < n) {
                if (sql[i] === "'") {
                    if (sql[i + 1] === "'") { i += 2; continue; }
                    break;
                }
                i++;
            }
            if (i >= n) refuse(); // unterminated string: fail closed
            i++;
            cur.push("'");
        } else if (c === '"' || c === '`' || c === '[') {
            const close = c === '[' ? ']' : c;
            let name = '';
            i++;
            while (i < n) {
                if (sql[i] === close) {
                    if (close !== ']' && sql[i + 1] === close) { name += close; i += 2; continue; }
                    break;
                }
                name += sql[i++];
            }
            if (i >= n) refuse(); // unterminated identifier: fail closed
            i++;
            cur.push({ quoted: name.toLowerCase() });
        } else if (c === ';') {
            if (inTrigger && !triggerClosed) {
                cur.push(';');
            } else {
                endStatement();
            }
            i++;
        } else if (/[A-Za-z_\u0080-￿]/.test(c)) {
            let j = i + 1;
            while (j < n && /[A-Za-z0-9_$\u0080-￿]/.test(sql[j])) j++;
            const word = sql.slice(i, j).toLowerCase();
            i = j;
            cur.push(word);
            if (word === 'trigger' && startsTriggerDefinition(cur)) inTrigger = true;
            if (inTrigger) {
                if (word === 'case') caseDepth++;
                else if (word === 'end') {
                    if (caseDepth > 0) caseDepth--;
                    else triggerClosed = true;
                }
            }
        } else if (/\s/.test(c)) {
            i++;
        } else {
            cur.push(c);
            i++;
        }
    }
    endStatement();
    return statements;
}

/**
 * True when the word just pushed is the TRIGGER keyword of `CREATE [TEMP|TEMPORARY] TRIGGER`.
 * Anywhere else (a column, alias or index called trigger) it is a name, and `;` keeps ending the
 * statement, so every following statement still meets the allow-lists.
 * @param {Array<string | { quoted: string }>} cur
 */
function startsTriggerDefinition(cur) {
    if (cur[0] !== 'create') return false;
    if (cur.length === 2) return true;
    return cur.length === 3 && (cur[1] === 'temp' || cur[1] === 'temporary');
}

/**
 * @param {string | { quoted: string; }} tok
 */
function identName(tok) {
    return typeof tok === 'string' ? tok : tok.quoted;
}

/** @param {Array<string | { quoted: string }>} tokens */
function checkStatement(tokens) {
    let k = 0;
    while (tokens[k] === '(') k++;
    const first = tokens[k];
    if (typeof first !== 'string' || !ALLOWED_FIRST.has(first)) refuse();

    if (first === 'create') {
        let j = k + 1;
        if (tokens[j] === 'temp' || tokens[j] === 'temporary') j++;
        if (typeof tokens[j] !== 'string' || !CREATE_KINDS.has(/** @type {string} */ (tokens[j]))) refuse();
    }

    if (first === 'pragma') {
        // PRAGMA <name>[(arg)] only: no schema prefix, no assignment form.
        const name = tokens[k + 1];
        if (typeof name !== 'string' || !ALLOWED_PRAGMAS.has(name)) refuse();
        const rest = tokens.slice(k + 2);
        if (rest.length && rest[0] !== '(') refuse();
        if (rest.includes('=')) refuse();
    }

    for (const tok of tokens) {
        const name = identName(tok);
        if (typeof tok === 'string' && DENIED_WORDS.has(tok)) refuse();
        // Table-valued PRAGMA functions follow the same allow-list.
        if (name.startsWith('pragma_') && !ALLOWED_PRAGMAS.has(name.slice(7))) refuse();
        // A quoted identifier can still name a function: "load_extension"(...).
        if (typeof tok !== 'string' && (name === 'load_extension' || name === 'fts3_tokenizer')) refuse();
    }
}

/**
 * Throw when the text holds anything but allowed statements. Every
 * `;`-separated statement is checked.
 * @param {string} sql
 */
function assertPageStatement(sql) {
    const statements = tokenize(String(sql));
    if (statements.length === 0) refuse();
    for (const s of statements) checkStatement(s);
}

module.exports = { assertPageStatement, NOT_ALLOWED_MESSAGE, ALLOWED_PRAGMAS };
