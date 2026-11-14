// @typecheck strict
/**
 * A pinned clock for a PGlite: `NOW()` answers the moment the test chose, so a
 * predicate such as `deadline_at < NOW()` can be measured one second either
 * side of its edge, on the store's own SQL.
 *
 *   const clock = await pinPgliteNow(pg, '2026-09-11T12:00:00Z');
 *   await clock.set(new Date('2026-09-11T13:00:00Z'));   // move it
 *   await clock.release();                               // the real clock again
 *
 * How: a `public.now()` that reads a session setting, and a search_path that
 * puts `public` before `pg_catalog`, so the unqualified `now()` a statement or
 * a column default calls resolves to it. PGlite is one session, so the pin
 * holds for every statement the test sends. `CURRENT_TIMESTAMP` is a keyword,
 * not a function call, and keeps the real clock.
 */

'use strict';

/** @typedef {{ exec: (sql: string) => Promise<unknown>, query: (sql: string, params?: unknown[]) => Promise<unknown> }} ClockDb */

/**
 * @param {ClockDb} pg
 * @param {Date | string} at
 */
async function pinPgliteNow(pg, at) {
    await pg.exec(`
        CREATE OR REPLACE FUNCTION public.now() RETURNS timestamptz LANGUAGE sql STABLE
        AS $$ SELECT current_setting('beeflow_test.now')::timestamptz $$;
        SET search_path = public, pg_catalog;
    `);
    /** @param {Date | string} when */
    const set = async (when) => {
        await pg.query(`SELECT set_config('beeflow_test.now', $1, false)`, [new Date(when).toISOString()]);
    };
    await set(at);
    return {
        set,
        // The function stays: a column default created while the pin held
        // refers to it.
        async release() {
            await pg.exec('RESET search_path');
        },
    };
}

module.exports = { pinPgliteNow };
