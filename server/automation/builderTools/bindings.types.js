// @typecheck noImplicitAny
'use strict';

/**
 * What sanitizeForEach (./bindings.js) resolves to: `forEach` is undefined when
 * the step has none, `error` is set when the spec was refused.
 * @typedef {{
 *   forEach?: { overRef: string, itemVar: string, parents?: Array<{ itemVar: string, overRef: string }>, maxIterations?: number, concurrency?: number },
 *   notes?: string[],
 *   error?: string,
 * }} SanitizedForEach
 */

module.exports = {};
