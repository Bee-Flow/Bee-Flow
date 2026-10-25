// @typecheck noImplicitAny
/**
 * @typedef {object} WriteOpts  The options of the record-writing compilers.
 * @property {string | null} [createdBy]
 * @property {string | null} [orgId]
 * @property {string | null} [expectedUpdatedAt]
 * @property {string} [dialect]
 * @property {string} [id]
 * @property {boolean} [allowLockedRows]
 */

/**
 * @typedef {object} OlderThanOpts  The options of compileDeleteOlderThan / compileSelectOlderThan.
 * @property {string} field  Timestamp column; resolved through the table's fields.
 * @property {string} cutoffIso  ISO timestamp; rows older than this match.
 * @property {number} [limit]  compileSelectOlderThan only.
 * @property {string} [dialect]  Defaults to the process dialect.
 * @property {boolean} [allowLockedRows]
 */

/**
 * @typedef {object} OrphanOpts  The options of compileDeleteOrphans.
 * @property {string} relationField  The relation column on the child table.
 * @property {{ key?: string }} parentTableMeta  The parent table's meta.
 * @property {boolean} [sweepNull]  Also sweep NULL relations (default true).
 * @property {string} [dialect]  Defaults to the process dialect.
 * @property {boolean} [allowLockedRows]
 */

module.exports = {};
