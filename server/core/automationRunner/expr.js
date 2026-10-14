/**
 * The restricted expression engine, for the automation runner.
 *
 * A thin CommonJS re-export of the shared, isomorphic engine in
 * `server/shared/expr/` (the same engine App Studio and the frontend use; see
 * `server/automation/expr.js`, which loads it the same way). Loading it here
 * via require(ESM) (Node >= 22.12) keeps the runner in `core/` from depending
 * on the `automation/` feature folder for the expression engine. Both modules
 * resolve to the same cached module namespace, so every function reference is
 * identical whichever path a caller takes.
 */

module.exports = require('../../shared/expr/index.mjs');
