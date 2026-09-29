/**
 * Restricted expression evaluator for automation conditions.
 *
 * The implementation now lives in the SHARED, isomorphic module
 * `shared/expr/` so the automation runtime (server) and App Studio (client
 * live-preview + server validation/enforcement) evaluate expressions with
 * BYTE-IDENTICAL semantics — a golden corpus (shared/expr/corpus.mjs) pins
 * both runtimes. This file is a thin CommonJS re-export so every existing
 * caller — bind.js, automationRunner/engine.js, tests — keeps working
 * unchanged (`const { evaluate, parseExpr, EXPR_FUNCTION_NAMES } = require('./expr')`).
 *
 * Requires Node ≥22.12 for require(ESM) — pinned in server/package.json engines.
 * The shared module adds an extended, pure/deterministic function whitelist
 * (numeric/string/array/date/null helpers) available to conditions too, plus
 * `compile()` (referenced roots for validation without executing) and
 * `tryEvaluate()` (never-throws, for App Studio runtime formulas).
 *
 * The engine lives at server/shared/expr/ — INSIDE the server package tree so
 * it is always present in the server Docker image (build context is ./server;
 * a repo-root shared/ dir would NOT be copied in). The frontend keeps a
 * byte-identical copy at agent-hub/src/shared/expr/ (in its own build context);
 * a sync test (agent-hub .../state/sharedExpr.sync.test.js) fails if they drift.
 */

module.exports = require('../shared/expr/index.mjs');
