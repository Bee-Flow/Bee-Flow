// @typecheck strict
/**
 * The options of the record-writing compilers.
 * @typedef {{
 *   createdBy?: string | null,
 *   orgId?: string | null,
 *   expectedUpdatedAt?: string | null,
 *   dialect?: string,
 *   id?: string,
 *   allowLockedRows?: boolean,
 * }} WriteOpts
 */

/**
 * The options of compileDeleteOlderThan / compileSelectOlderThan. `field`: Timestamp column; resolved
 * through the table's fields. `cutoffIso`: ISO timestamp; rows older than this match. `limit`:
 * compileSelectOlderThan only. `dialect`: Defaults to the process dialect.
 * @typedef {{
 *   field: string,
 *   cutoffIso: string,
 *   limit?: number,
 *   dialect?: string,
 *   allowLockedRows?: boolean,
 * }} OlderThanOpts
 */

/**
 * The options of compileDeleteOrphans. `relationField`: The relation column on the child table.
 * `parentTableMeta`: The parent table's meta. `sweepNull`: Also sweep NULL relations (default true).
 * `dialect`: Defaults to the process dialect.
 * @typedef {{
 *   relationField: string,
 *   parentTableMeta: { key?: string },
 *   sweepNull?: boolean,
 *   dialect?: string,
 *   allowLockedRows?: boolean,
 * }} OrphanOpts
 */

module.exports = {};
