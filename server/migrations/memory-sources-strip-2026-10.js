/**
 * Migration: drop the plaintext copy of chat messages from memory_sources.
 *
 * `memory_sources.message_content` held the raw user message a memory was
 * extracted from. Nothing ever read it, and it sat unencrypted next to
 * otherwise protected data. The store no longer writes it; this clears what
 * earlier versions left behind. The column itself stays in the schema for now
 * (the row still links a memory to its conversation).
 *
 * Idempotent: 0 rows after the first run. Registered in the boot ladder
 * (boot/bootMigrations.js LOOSE_MIGRATIONS).
 */

/** `deps.run` is the injection seam for tests; the boot ladder calls `up()`. */
async function up(deps = {}) {
    const run = deps.run || require('../db').run;
    let res;
    try {
        res = await run(`UPDATE memory_sources SET message_content = NULL WHERE message_content IS NOT NULL`);
    } catch (e) {
        // Fresh database: memoryStore creates the table later in boot.
        console.log('[migration:memory-sources-strip] memory_sources not ready — skipping');
        return;
    }
    console.log(`[migration:memory-sources-strip] cleared ${res?.rowCount ?? 0} stored messages`);
}

module.exports = { up };
