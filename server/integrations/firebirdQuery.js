// @typecheck strict
/**
 * Pure helpers for the Firebird integration: the SQL guard, identifier
 * handling, the metadata statements, type names and value serialisation.
 * Nothing here touches the network or the driver.
 */
const { DEFAULT_LIMIT, MAX_OUTPUT_CHARS, MAX_TEXT_CHARS, getMaxRows } = require('./firebirdToolDefs');

const MAX_SQL_CHARS = 20000;
const IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_$]{0,62}$/;

const DENIED_KEYWORDS = [
    'INSERT', 'UPDATE', 'DELETE', 'MERGE', 'EXECUTE', 'ALTER', 'CREATE', 'DROP', 'GRANT', 'REVOKE',
    'RECREATE', 'COMMIT', 'ROLLBACK', 'TRUNCATE',
];
const DENIED_RE = new RegExp(`\\b(?:${DENIED_KEYWORDS.join('|')})\\b|\\bSET\\s+TRANSACTION\\b`, 'i');

// ─── SQL guard ─────────────────────────────────────────────────

/**
 * End index (exclusive) of a quoted run that starts at `start`; a doubled quote is an escaped quote.
 * @param {string} sql
 * @param {number} start
 */
function quotedEnd(sql, start) {
    const quote = sql[start];
    let i = start + 1;
    while (i < sql.length) {
        if (sql[i] === quote) {
            if (sql[i + 1] === quote) { i += 2; continue; }
            return i + 1;
        }
        i += 1;
    }
    throw new Error('Unterminated quote in the SQL statement.');
}

const Q_CLOSERS = /** @type {Record<string, string>} */ ({ '[': ']', '{': '}', '(': ')', '<': '>' });

/**
 * End index of a Firebird q'<delim>...<delim>' literal, or -1 when `start` does not begin one.
 * @param {string} sql
 * @param {number} start index of the q
 */
function qLiteralEnd(sql, start) {
    // nosemgrep: ajinabraham.njsscan.dos.regex_dos.regex_dos -- tests one character, no backtracking possible
    if (!/[qQ]/.test(sql[start]) || sql[start + 1] !== "'") return -1;
    // nosemgrep: ajinabraham.njsscan.dos.regex_dos.regex_dos -- tests one character, no backtracking possible
    if (start > 0 && /[A-Za-z0-9_$]/.test(sql[start - 1])) return -1;
    const open = sql[start + 2];
    if (open === undefined || /\s/.test(open)) return -1;
    const close = Q_CLOSERS[open] || open;
    const end = sql.indexOf(`${close}'`, start + 3);
    if (end === -1) throw new Error('Unterminated quote in the SQL statement.');
    return end + 2;
}

/**
 * The next lexical unit at `i`: a comment (becomes one space), a literal or quoted identifier
 * (kept in `code`, blanked in `masked`), or a single character.
 * @param {string} sql
 * @param {number} i
 * @returns {{ end: number, code: string, masked: string }}
 */
function nextUnit(sql, i) {
    const c = sql[i];
    if (c === '-' && sql[i + 1] === '-') {
        const nl = sql.indexOf('\n', i);
        return { end: nl === -1 ? sql.length : nl, code: ' ', masked: ' ' };
    }
    if (c === '/' && sql[i + 1] === '*') {
        const close = sql.indexOf('*/', i + 2);
        if (close === -1) throw new Error('Unterminated comment in the SQL statement.');
        return { end: close + 2, code: ' ', masked: ' ' };
    }
    const qEnd = qLiteralEnd(sql, i);
    if (qEnd !== -1) return { end: qEnd, code: sql.slice(i, qEnd), masked: "''" };
    if (c === "'" || c === '"') {
        const end = quotedEnd(sql, i);
        return { end, code: sql.slice(i, end), masked: `${c}${c}` };
    }
    return { end: i + 1, code: c, masked: c };
}

/**
 * Split a statement into `code` (comments removed) and `masked` (comments removed and every string
 * literal or quoted identifier emptied), so keyword and semicolon checks never see literal text.
 * @param {string} sql
 */
function scanSql(sql) {
    let code = '';
    let masked = '';
    let i = 0;
    while (i < sql.length) {
        const unit = nextUnit(sql, i);
        code += unit.code;
        masked += unit.masked;
        i = unit.end;
    }
    return { code, masked };
}

/**
 * Validate a statement for firebird_query and return it cleaned (comments and the trailing
 * semicolon removed). Throws an Error with a message for the model when it is refused.
 * Defence in depth: the transaction is read-only as well.
 * @param {unknown} rawSql
 */
function guardSql(rawSql) {
    if (typeof rawSql !== 'string' || !rawSql.trim()) throw new Error('sql is required.');
    if (rawSql.length > MAX_SQL_CHARS) throw new Error(`The SQL statement is too long (max ${MAX_SQL_CHARS} characters).`);
    const { code, masked } = scanSql(rawSql);
    const maskedBody = masked.replace(/[\s;]+$/, '').trim();
    if (!maskedBody) throw new Error('sql is required.');
    if (maskedBody.includes(';')) throw new Error('Only one SQL statement is allowed per call.');
    if (!/^(?:SELECT|WITH)\b/i.test(maskedBody)) throw new Error('Only SELECT statements (optionally starting with WITH) are allowed.');
    const denied = DENIED_RE.exec(maskedBody);
    if (denied) throw new Error(`This integration is read-only; "${denied[0].toUpperCase()}" is not allowed.`);
    return code.replace(/[\s;]+$/, '').trim();
}

// ─── Identifiers ───────────────────────────────────────────────

/**
 * Validate a table name. Returns the name as stored in the Firebird catalog: unquoted names are
 * upper-cased, a name wrapped in double quotes keeps its case.
 * @param {unknown} raw
 */
function parseIdentifier(raw) {
    const text = typeof raw === 'string' ? raw.trim() : '';
    const quoted = /^"(.*)"$/.exec(text);
    const name = quoted ? quoted[1] : text;
    if (!IDENTIFIER_RE.test(name)) {
        throw new Error('Invalid table name. Use letters, digits, underscore or $, starting with a letter or underscore (max 63 characters).');
    }
    return quoted ? name : name.toUpperCase();
}

/**
 * A table name as a double-quoted SQL identifier.
 * @param {unknown} raw
 */
function quoteIdentifier(raw) {
    return `"${parseIdentifier(raw)}"`;
}

// ─── Limits ────────────────────────────────────────────────────

/**
 * Row limit for a call: the default when absent, at least 1, at most FIREBIRD_MAX_ROWS (0 = unlimited).
 * @param {unknown} raw
 */
function clampLimit(raw) {
    const max = getMaxRows();
    const n = Number.parseInt(String(raw), 10);
    const wanted = Number.isFinite(n) ? Math.max(n, 1) : DEFAULT_LIMIT;
    return Math.min(wanted, max);
}

// ─── Metadata statements ───────────────────────────────────────

const SYSTEM_INFO_SQL = "SELECT RDB$GET_CONTEXT('SYSTEM', 'ENGINE_VERSION') AS SERVER_VERSION, "
    + '(SELECT COUNT(*) FROM RDB$RELATIONS WHERE COALESCE(RDB$SYSTEM_FLAG, 0) = 0) AS TABLE_COUNT '
    + 'FROM RDB$DATABASE';

/**
 * Tables and views, optionally filtered by a name search (passed as the one parameter).
 * @param {boolean} withSearch
 */
function listTablesSql(withSearch) {
    return 'SELECT TRIM(R.RDB$RELATION_NAME) AS NAME, '
        + "CASE WHEN R.RDB$VIEW_BLR IS NULL THEN 'table' ELSE 'view' END AS KIND, "
        + 'R.RDB$DESCRIPTION AS DESCRIPTION '
        + 'FROM RDB$RELATIONS R WHERE COALESCE(R.RDB$SYSTEM_FLAG, 0) = 0'
        + (withSearch ? ' AND UPPER(R.RDB$RELATION_NAME) CONTAINING ?' : '')
        + ' ORDER BY R.RDB$RELATION_NAME';
}

// One parameter: the relation name.
const COLUMNS_SQL = 'SELECT TRIM(RF.RDB$FIELD_NAME) AS NAME, F.RDB$FIELD_TYPE AS FIELD_TYPE, '
    + 'F.RDB$FIELD_SUB_TYPE AS SUB_TYPE, F.RDB$FIELD_SCALE AS SCALE, F.RDB$FIELD_PRECISION AS PRECISION, '
    + 'F.RDB$CHARACTER_LENGTH AS CHAR_LENGTH, F.RDB$FIELD_LENGTH AS FIELD_LENGTH, '
    + 'RF.RDB$NULL_FLAG AS NULL_FLAG, RF.RDB$DESCRIPTION AS DESCRIPTION, '
    + 'COALESCE(RF.RDB$DEFAULT_SOURCE, F.RDB$DEFAULT_SOURCE) AS DEFAULT_SOURCE '
    + 'FROM RDB$RELATION_FIELDS RF JOIN RDB$FIELDS F ON F.RDB$FIELD_NAME = RF.RDB$FIELD_SOURCE '
    + 'WHERE RF.RDB$RELATION_NAME = ? ORDER BY RF.RDB$FIELD_POSITION';

// One parameter: the relation name.
const PRIMARY_KEY_SQL = 'SELECT TRIM(S.RDB$FIELD_NAME) AS COLUMN_NAME '
    + 'FROM RDB$RELATION_CONSTRAINTS C JOIN RDB$INDEX_SEGMENTS S ON S.RDB$INDEX_NAME = C.RDB$INDEX_NAME '
    + "WHERE C.RDB$RELATION_NAME = ? AND C.RDB$CONSTRAINT_TYPE = 'PRIMARY KEY' ORDER BY S.RDB$FIELD_POSITION";

// One parameter: the relation name.
const FOREIGN_KEYS_SQL = 'SELECT TRIM(C.RDB$CONSTRAINT_NAME) AS CONSTRAINT_NAME, TRIM(S.RDB$FIELD_NAME) AS COLUMN_NAME, '
    + 'TRIM(PC.RDB$RELATION_NAME) AS REF_TABLE, TRIM(PS.RDB$FIELD_NAME) AS REF_COLUMN '
    + 'FROM RDB$RELATION_CONSTRAINTS C '
    + 'JOIN RDB$REF_CONSTRAINTS RC ON RC.RDB$CONSTRAINT_NAME = C.RDB$CONSTRAINT_NAME '
    + 'JOIN RDB$INDEX_SEGMENTS S ON S.RDB$INDEX_NAME = C.RDB$INDEX_NAME '
    + 'JOIN RDB$RELATION_CONSTRAINTS PC ON PC.RDB$CONSTRAINT_NAME = RC.RDB$CONST_NAME_UQ '
    + 'JOIN RDB$INDEX_SEGMENTS PS ON PS.RDB$INDEX_NAME = PC.RDB$INDEX_NAME AND PS.RDB$FIELD_POSITION = S.RDB$FIELD_POSITION '
    + "WHERE C.RDB$RELATION_NAME = ? AND C.RDB$CONSTRAINT_TYPE = 'FOREIGN KEY' "
    + 'ORDER BY C.RDB$CONSTRAINT_NAME, S.RDB$FIELD_POSITION';

// ─── Type names ────────────────────────────────────────────────

/** @type {Record<number, string>} */
const SIMPLE_TYPES = {
    7: 'SMALLINT', 8: 'INTEGER', 10: 'FLOAT', 12: 'DATE', 13: 'TIME', 16: 'BIGINT', 23: 'BOOLEAN',
    24: 'DECFLOAT(16)', 25: 'DECFLOAT(34)', 26: 'INT128', 27: 'DOUBLE PRECISION', 35: 'TIMESTAMP',
    28: 'TIME WITH TIME ZONE', 29: 'TIMESTAMP WITH TIME ZONE',
};
const EXACT_NUMERIC = new Set([7, 8, 16, 26]);

/**
 * @typedef {{ FIELD_TYPE?: unknown, SUB_TYPE?: unknown, SCALE?: unknown, PRECISION?: unknown,
 *   CHAR_LENGTH?: unknown, FIELD_LENGTH?: unknown }} FieldRow
 */

const DEFAULT_PRECISION = /** @type {Record<number, number>} */ ({ 7: 4, 8: 9, 16: 18, 26: 38 });

/**
 * @param {FieldRow} f
 * @param {number} type
 * @param {number} sub
 */
function exactNumericName(f, type, sub) {
    const precision = Number(f.PRECISION) || DEFAULT_PRECISION[type];
    return `${sub === 2 ? 'DECIMAL' : 'NUMERIC'}(${precision},${Math.abs(Number(f.SCALE) || 0)})`;
}

/** @param {number} sub */
function blobName(sub) {
    if (sub === 1) return 'BLOB TEXT';
    return sub === 0 ? 'BLOB' : `BLOB SUB_TYPE ${sub}`;
}

/**
 * Readable type of a column from the RDB$FIELDS values.
 * @param {FieldRow} f
 */
function typeName(f) {
    const type = Number(f.FIELD_TYPE);
    const sub = Number(f.SUB_TYPE) || 0;
    const scaled = (Number(f.SCALE) || 0) !== 0;
    if (EXACT_NUMERIC.has(type) && (sub > 0 || scaled)) return exactNumericName(f, type, sub);
    if (type === 14 || type === 37) {
        const length = Number(f.CHAR_LENGTH) || Number(f.FIELD_LENGTH) || 0;
        return `${type === 14 ? 'CHAR' : 'VARCHAR'}(${length})`;
    }
    if (type === 261) return blobName(sub);
    return SIMPLE_TYPES[type] || `UNKNOWN(${type})`;
}

// ─── Value serialisation ───────────────────────────────────────

/**
 * Cap a string at MAX_TEXT_CHARS.
 * @param {string} text
 */
function capText(text) {
    return text.length > MAX_TEXT_CHARS ? `${text.slice(0, MAX_TEXT_CHARS)}…` : text;
}

/**
 * One column value as JSON-safe data for the model.
 * @param {unknown} value
 * @returns {unknown}
 */
function serialiseValue(value) {
    if (value === null || value === undefined) return null;
    if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
    if (Buffer.isBuffer(value)) return `<blob ${value.length} bytes>`;
    if (typeof value === 'string') return capText(value.replace(/\s+$/, ''));
    if (typeof value === 'bigint') return Number.isSafeInteger(Number(value)) ? Number(value) : value.toString();
    if (typeof value === 'function') return '<blob>';
    if (typeof value === 'object') return capText(JSON.stringify(value) ?? '');
    return value;
}

/**
 * A result row with trimmed keys (Firebird pads CHAR identifiers) and serialised values.
 * @param {Record<string, unknown>} row
 * @returns {Record<string, unknown>}
 */
function serialiseRow(row) {
    /** @type {Record<string, unknown>} */
    const out = {};
    for (const [key, value] of Object.entries(row)) out[key.trim()] = serialiseValue(value);
    return out;
}

/**
 * Drop trailing rows until the serialised result fits the output budget. Never cuts inside a row.
 * @param {unknown[]} rows
 * @param {number} [maxChars]
 */
function truncateRows(rows, maxChars = MAX_OUTPUT_CHARS) {
    if (!Array.isArray(rows)) return { rows: [], truncated: false };
    let kept = rows;
    let truncated = false;
    while (kept.length > 1 && JSON.stringify(kept).length > maxChars) {
        kept = kept.slice(0, Math.floor(kept.length / 2));
        truncated = true;
    }
    if (kept.length > 0 && JSON.stringify(kept).length > maxChars) {
        kept = [];
        truncated = true;
    }
    return { rows: kept, truncated };
}

/**
 * A metadata value as trimmed text, or null when empty.
 * @param {unknown} value
 */
function text(value) {
    if (value === null || value === undefined) return null;
    const s = String(value).trim();
    return s === '' ? null : s;
}

module.exports = {
    IDENTIFIER_RE,
    MAX_SQL_CHARS,
    guardSql,
    scanSql,
    parseIdentifier,
    quoteIdentifier,
    clampLimit,
    SYSTEM_INFO_SQL,
    listTablesSql,
    COLUMNS_SQL,
    PRIMARY_KEY_SQL,
    FOREIGN_KEYS_SQL,
    typeName,
    serialiseValue,
    serialiseRow,
    truncateRows,
    text,
};
