/**
 * Migration: remove memories written for anonymous visitors.
 *
 * `/agents/memory` carried no auth middleware, and `getEffectiveUserId` mints a
 * `guest_<random>` id rather than returning 401 — so anonymous traffic wrote
 * real rows into `user_memories`. Agent chat (`routes/agents/chat.js`) is
 * unauthenticated by design for the embed widget, so it did the same on every
 * turn a public widget served.
 *
 * Those rows are personal data with no reachable data subject: nobody can
 * exercise access or erasure against a random guest id, and the account they
 * belong to does not exist. Deleting them is the only correct disposition.
 *
 * Order matters. `memory_sources` has no foreign key to `user_memories`
 * (see memoryStore.initDB), so deleting the memories first would orphan its
 * rows permanently — and those hold a raw copy of the user's message text.
 *
 * Idempotent: 0 rows on every run after the first. Registered in the boot
 * ladder (boot/bootMigrations.js LOOSE_MIGRATIONS), so it runs on every
 * install without an operator having to know it exists.
 */

const { getOne, run } = require('../db');

async function up() {
    // `ESCAPE '\'` makes the underscore a literal rather than a wildcard.
    const LIKE = String.raw`guest\_%`;

    // Census before destruction — this is the only record that these rows
    // existed, and the count is what tells an operator whether their install
    // was affected at all.
    let before;
    try {
        before = await getOne(
            `SELECT COUNT(*)::int AS n FROM user_memories WHERE user_id LIKE $1 ESCAPE '\\'`,
            [LIKE],
        );
    } catch (e) {
        // Fresh database: memoryStore creates the table later in boot, and a
        // table that does not exist yet holds no anonymous rows to purge.
        console.log('[migration:memory-guest-purge] user_memories not ready — skipping');
        return;
    }
    const total = before?.n || 0;
    if (total === 0) {
        console.log('[migration:memory-guest-purge] no anonymous memories — nothing to do');
        return;
    }
    console.log(`[migration:memory-guest-purge] found ${total} anonymous memories`);

    const sources = await run(
        `DELETE FROM memory_sources
          WHERE memory_id IN (
              SELECT id FROM user_memories WHERE user_id LIKE $1 ESCAPE '\\'
          )`,
        [LIKE],
    );

    // The NOT EXISTS clause is belt-and-braces: `getEffectiveUserId` never
    // writes guest ids into `users`, so it should always be a no-op — but it
    // costs nothing and makes the DELETE provably safe against a real account
    // whose id happens to begin `guest_`.
    const memories = await run(
        `DELETE FROM user_memories
          WHERE user_id LIKE $1 ESCAPE '\\'
            AND NOT EXISTS (SELECT 1 FROM users u WHERE u.id = user_memories.user_id)`,
        [LIKE],
    );

    console.log(
        `[migration:memory-guest-purge] removed ${memories?.rowCount ?? 0} memories `
        + `and ${sources?.rowCount ?? 0} source rows`,
    );
}

module.exports = { up };
