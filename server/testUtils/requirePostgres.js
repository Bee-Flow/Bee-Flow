// @typecheck strict
/**
 * What a database-dependent test does when no Postgres answers.
 *
 * A few tests go through the real db.js pool to a real Postgres
 * (CORE_DATABASE_URL) and skip when nothing is listening, so `npm test` on a
 * machine without a database does not false-fail. ci.yml's `server-postgres`
 * job gives them a Postgres and sets REQUIRE_POSTGRES=1
 * (scripts/run-postgres-tests.mjs): there an unreachable database is a
 * failure, never a skip, or the job would be green having tested nothing.
 *
 *   } catch (e) { skipReason = postgresSkipReason('kbSources.test', e); }
 */

'use strict';

/**
 * The reason to skip with, or a throw when a Postgres is required.
 * @param {string} label the test's name, for the message
 * @param {unknown} err what the connection attempt threw
 * @returns {string}
 */
function postgresSkipReason(label, err) {
    const message = err instanceof Error ? err.message : String(err);
    if (process.env.REQUIRE_POSTGRES === '1') {
        throw new Error(`[${label}] REQUIRE_POSTGRES=1 but Postgres is unavailable: ${message}`, { cause: err });
    }
    return `Postgres unavailable, skipping: ${message}`;
}

module.exports = { postgresSkipReason };
