/**
 * Migration: undo a wrong `origin = 'explicit'` from an earlier build's backfill.
 *
 * That backfill marked every legacy row with no evidence quote and no subject
 * as written by the user. Rows the old extractor wrote without either got the
 * label too, so the quality pass (which never touches explicit rows) left them
 * active. Only the extractor ever writes a memory_sources row, so an explicit
 * row WITH a source came out of a chat: it is inferred.
 *
 * Idempotent: 0 rows after the first run. Registered in boot/bootMigrations.js
 * LOOSE_MIGRATIONS.
 */

async function up(deps = {}) {
    const run = deps.run || require('../db').run;
    let res;
    try {
        res = await run(`
            UPDATE user_memories m SET origin = 'inferred'
             WHERE m.origin = 'explicit'
               AND EXISTS (SELECT 1 FROM memory_sources s WHERE s.memory_id = m.id)
        `);
    } catch (e) {
        // Fresh database: the table or the column does not exist yet, so nothing was mislabelled.
        console.log('[migration:memory-origin-repair] user_memories.origin not ready — skipping');
        return;
    }
    console.log(`[migration:memory-origin-repair] relabelled ${res?.rowCount ?? 0} memories as inferred`);
}

module.exports = { up };
