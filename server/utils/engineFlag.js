// @typecheck
/**
 * App Studio v3 — DATA ENGINE dialect flag.
 *
 * One tiny module, required by queryCompiler / rlsGateway / dataModel (for
 * their SQL dialect) and by stores/studioAppDbStore (to pick the physical
 * engine). It deliberately requires NOTHING, so it can never participate in a
 * dependency cycle.
 *
 * The flag is process-wide: STUDIO_APP_ENGINE selects which engine serves
 * per-app records for this replica — 'sqlite' (the blob engine, default) or
 * 'pg' (per-app Postgres schema inside beeflow_core). It is NOT per-app
 * routing: the per-app safety interlock is studio_apps.engine, which the
 * selected engine checks before touching an app's data.
 *
 * The env var is read on every call (not snapshotted) so tests can flip the
 * dialect via _setForTests without re-requiring half the app; production code
 * sets STUDIO_APP_ENGINE once at boot and never changes it while running.
 */

'use strict';

let testOverride = null;

/** The active SQL dialect: 'sqlite' (default) or 'pg'. */
function getDialect() {
    if (testOverride) return testOverride;
    return process.env.STUDIO_APP_ENGINE === 'pg' ? 'pg' : 'sqlite';
}

/** Convenience: is the Postgres engine/dialect selected? */
function isPg() {
    return getDialect() === 'pg';
}

/**
 * The dialect for ONE compile, resolved from an explicit caller option first.
 *
 * getDialect() answers "which engine does THIS REPLICA serve App Studio apps
 * from" — a process-global that defaults to 'sqlite'. That is the right answer
 * only for a caller whose storage IS the one STUDIO_APP_ENGINE selects.
 *
 * Automation datatables always live in Postgres (the sqlite blob engine is
 * single-replica and poisons its handle when a second replica writes), so on a
 * default self-host the global says 'sqlite' while the storage is Postgres.
 * Compiling under the wrong dialect is not a crash — it is silently wrong SQL:
 * LIKE instead of ILIKE (matches fewer rows, no error), `0` instead of FALSE
 * for an empty IN, strftime() instead of to_char(), and a CREATE TABLE that
 * succeeds with a TEXT timestamp column.
 *
 * So every entry point resolves through here, and a caller that knows its own
 * storage states it. Passing nothing preserves today's behaviour exactly.
 */
function resolveDialect(opts) {
    const d = opts && opts.dialect;
    if (d === 'pg' || d === 'sqlite') return d;
    if (d !== undefined && d !== null) {
        throw new Error(`resolveDialect: dialect must be 'pg', 'sqlite' or absent — got ${d}`);
    }
    return getDialect();
}

/**
 * Test-only override. Pass 'pg' / 'sqlite' to force a dialect, or null /
 * undefined to fall back to the environment variable.
 */
function _setForTests(v) {
    if (v !== null && v !== undefined && v !== 'pg' && v !== 'sqlite') {
        throw new Error(`_setForTests accepts 'pg', 'sqlite' or null — got ${v}`);
    }
    testOverride = v || null;
}

module.exports = { getDialect, isPg, resolveDialect, _setForTests };
