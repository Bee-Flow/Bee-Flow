// @typecheck
'use strict';

/**
 * Is this the error of a table or column that is not there (yet)?
 *
 * For the optional-schema reads: a feature whose table a fresh or older install
 * does not have simply has nothing to show. Use it so only that error is
 * swallowed and everything else (a lock timeout, a dropped connection, a typo
 * in the SQL) still surfaces:
 *
 *     try { rows = await db.query('SELECT ... FROM optional_table'); }
 *     catch (e) { if (!isMissingTable(e)) throw e; }
 *
 * Postgres says `42P01` (undefined_table) or `42703` (undefined_column); the
 * message forms cover a driver or an embedded engine that drops the SQLSTATE.
 */

const MISSING_TABLE_CODES = new Set(['42P01', '42703']);
const MISSING_TABLE_MESSAGE = /\b(?:relation|table|column) "?[\w.$-]+"? (?:of relation "?[\w.$-]+"? )?does not exist\b|\bno such (?:table|column)\b/i;

/**
 * @param {unknown} err
 * @returns {boolean}
 */
function isMissingTable(err) {
    if (!err || typeof err !== 'object') return false;
    const e = /** @type {{ code?: unknown, message?: unknown }} */ (err);
    if (typeof e.code === 'string' && MISSING_TABLE_CODES.has(e.code)) return true;
    return typeof e.message === 'string' && MISSING_TABLE_MESSAGE.test(e.message);
}

module.exports = { isMissingTable, MISSING_TABLE_CODES };
