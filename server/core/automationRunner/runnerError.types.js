// @typecheck
/**
 * Shared shapes for the automation runner.
 *
 * @typedef {Error & {
 *   errorClass?: string,
 *   toolError?: boolean,
 *   foreachHandled?: boolean,
 *   foreachResults?: unknown[],
 * }} RunnerError  An Error tagged with the stable class the run history groups on.
 */

module.exports = {};
