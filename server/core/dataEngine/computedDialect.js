/**
 * Author-written SQL is the least portable surface in the product.
 *
 * A stored computed field carries a raw expression that goes straight into
 * `GENERATED ALWAYS AS (<expr>) STORED`. Everything else in the data model is
 * generated from typed metadata and can simply be emitted per dialect — this
 * one string cannot, so the known SQLite idioms are translated on the way to
 * Postgres and anything else is passed through untouched.
 *
 * WHY THIS MODULE EXISTS AT ALL: the translation used to live only inside
 * scripts/migrateStudioAppsToPg.js. Migrated apps were therefore correct while
 * a FRESH INSTALL of the same template on the Postgres engine emitted
 * `char(59)` into PG DDL and failed at CREATE TABLE. One function, two callers
 * (dataModel's DDL emission and the migrator), so the paths cannot drift again.
 *
 * Templates keep authoring the SQLite/portable form: it is the dialect the
 * expression guard, the docs and every existing definition already speak, and
 * translating one way is testable in a way "author per dialect" never is.
 */

'use strict';

/**
 * Rewrite the SQLite-flavoured idioms in a computed expression to Postgres.
 * Portable SQL (COALESCE, CASE, ||, arithmetic, length, lower, …) is returned
 * unchanged, which is the overwhelmingly common case.
 */
function translateComputedExpr(expr) {
    if (typeof expr !== 'string' || !expr) return expr;
    let out = expr;

    // char(59) → chr(59): SQLite's char() is Postgres's chr(). The lookbehind
    // keeps `CAST(x AS char(10))` — where char is a TYPE, not a function —
    // out of it; rewriting that to chr(10) would be a silent corruption.
    out = out.replace(/(?<!\bAS\s{1,20})\bchar\s*\(\s*(\d+)\s*\)/gi, (_m, code) => `chr(${code})`);

    // The REAL-trimming idiom rtrim(rtrim(CAST(x AS TEXT),'0'),'.') exists
    // because SQLite renders 20 as '20.0'. Postgres NUMERIC renders '20', and
    // that same rtrim would turn it into '2' — so it must become trim_scale().
    out = out.replace(
        /rtrim\s*\(\s*rtrim\s*\(\s*CAST\s*\(\s*([A-Za-z_][A-Za-z0-9_]*)\s+AS\s+TEXT\s*\)\s*,\s*'0'\s*\)\s*,\s*'\.'\s*\)/gi,
        (_m, col) => `trim_scale("${col}")::text`,
    );

    return out;
}

/** Translate for the named dialect; 'sqlite' is the identity. */
function computedExprFor(expr, dialect) {
    return dialect === 'pg' ? translateComputedExpr(expr) : expr;
}

module.exports = { translateComputedExpr, computedExprFor };
