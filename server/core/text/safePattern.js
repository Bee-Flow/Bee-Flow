// @typecheck strict
'use strict';
/**
 * Reject regex patterns with the classic catastrophic-backtracking shape: a
 * quantifier applied to a group that itself contains a quantifier — (a+)+,
 * (\w*)+$, (a?)+ and friends. Node's regex engine backtracks exponentially on
 * those, and file_intake runs author-saved patterns against sender-controlled
 * filenames on the shared event loop, so one crafted attachment name can
 * stall every tenant on the process.
 *
 * The scanner lives in the shared expression engine (shared/expr/regex.mjs),
 * which checks the patterns of regexMatch / regexReplace with it too.
 */
const { hasNestedQuantifier } = require('../../shared/expr/regex.mjs');

module.exports = { hasNestedQuantifier };
