// @typecheck strict
/**
 * The autonumber field type (marked in vocabularySince.js): a whole number the SERVER
 * assigns per table, 1, 2, 3 … in creation order. Two statements, the same SQL in both dialects:
 *
 *   autonumberValueSql     the value an INSERT writes (queryCompilerWrite.compileInsert)
 *   autonumberBackfillDdl  the numbering of the rows that were there when the column was added
 *                          (migrationPlan step 4, right after its ADD COLUMN)
 *
 * The column is INTEGER / BIGINT (ddl.js) with a unique index: canonicalize and the validator keep
 * an autonumber `unique`, so the index refuses a duplicate should two Postgres transactions ever
 * reach the same number at once. A table without an autonumber field never meets this file.
 */

'use strict';

const { qi } = require('./ddl');

/**
 * One more than the highest number the table holds. Part of the statement (not a bound value), so
 * it is read inside the write itself.
 * @param {string} tableKey
 * @param {string} fieldKey
 */
function autonumberValueSql(tableKey, fieldKey) {
    return `(SELECT COALESCE(MAX(${qi(fieldKey)}), 0) + 1 FROM ${qi(tableKey)})`;
}

/**
 * Numbers the rows an autonumber column was just added to (ADD COLUMN leaves them NULL), in the
 * order they were created, counting on from the highest number already there. Only NULL rows are
 * touched, so a replayed plan (tolerantDdl) changes nothing. UPDATE … FROM with a window function:
 * SQLite (3.33+) and Postgres both read the FROM side before writing (fieldTypesV3 tests, both engines).
 * @param {string} tableKey
 * @param {string} fieldKey
 */
function autonumberBackfillDdl(tableKey, fieldKey) {
    const t = qi(tableKey);
    const c = qi(fieldKey);
    return `UPDATE ${t} SET ${c} = s.rn FROM (SELECT ${qi('id')} AS rid, `
        + `ROW_NUMBER() OVER (ORDER BY ${qi('created_at')}, ${qi('id')}) + (SELECT COALESCE(MAX(${c}), 0) FROM ${t}) AS rn `
        + `FROM ${t} WHERE ${c} IS NULL) AS s WHERE ${t}.${qi('id')} = s.rid AND ${t}.${c} IS NULL`;
}

module.exports = { autonumberValueSql, autonumberBackfillDdl };
