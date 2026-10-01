/**
 * Binding resolver for automation step inputs.
 *
 * Each step input is one of:
 *   { kind: 'literal',  value: <any> }
 *   { kind: 'ref',      path:  'steps.s1.output.items[0].subject' }
 *   { kind: 'template', value: 'Found {{steps.s1.output.count}} invoices' }
 *   { kind: 'expr',     value: 'steps.s1.output.amount > 1000 ? "high" : "low"' }
 *
 * The implementation lives in the SHARED, isomorphic module `shared/mapping/`
 * (legacy.mjs: the path grammar and walker; resolve.mjs: the four kinds), so
 * the runtime and the builder previews on the web and the phone resolve a
 * path identically. A golden corpus (shared/mapping/corpus.mjs), recorded
 * from this file before the code moved, pins all three. This file is a thin
 * CommonJS facade with the same exports as before, so every caller keeps
 * `const { resolveInputs, interpolateTemplate, ... } = require('./bind')`.
 *
 * It adds the two server-only pieces the shared module cannot import: the
 * expression engine (./expr, for `expr` bindings) and the debug log on a
 * template path that resolves to undefined (`AUTOMATION_DEBUG_BINDINGS=1`).
 *
 * Requires Node >= 22.12 for require(ESM), like automation/expr.js.
 */

const { evaluate } = require('./expr');
const log = require('../telemetry/log');
const mapping = require('../shared/mapping/index.mjs');

const { resolveValue, resolveDeep, resolveInputs, interpolateTemplate } = mapping.createLegacyResolver({
    evaluate,
    onUnresolved(path) {
        if (process.env.AUTOMATION_DEBUG_BINDINGS) {
            log.warn(`[bind] template path "${path}" resolved to undefined`);
        }
    },
});

module.exports = {
    resolveValue,
    resolveDeep,
    resolveInputs,
    walkPath: mapping.walkPath,
    walkRelativePath: mapping.walkRelativePath,
    interpolateTemplate,
    cloneLiteral: mapping.cloneLiteral,
};
