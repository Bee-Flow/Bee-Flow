/**
 * Migration: give every already-published webpage the snapshot its audience
 * reads (W2 publish lifecycle).
 *
 * Until `webpages.published_version_id` existed, "Publish" set a visibility
 * flag and nothing else, so an org reader was served the OWNER'S LIVE ROW —
 * the last keystroke, published or not. The column fixes that going forward;
 * this migration fixes the pages that were published before it.
 *
 * Three steps, in this order, because each depends on the one before:
 *
 *   1. The columns themselves (`published_version_id` on webpages, `source`
 *      on webpage_versions). Idempotent and identical to the ladder in
 *      stores/webpage/schema.js — this product has NO migration ledger, so
 *      every replica replays both on every boot and they must agree.
 *   2. A snapshot for every PUBLISHED page that has no `webpage_versions`
 *      row at all. The 5-minute auto-version debounce means a page can be
 *      published without ever having been snapshotted, and step 3 cannot
 *      point at a version that does not exist.
 *   3. The pointer, idempotent: `WHERE published_version_id IS NULL` only, so
 *      re-running never moves a pointer an owner has since re-published, and
 *      the newest snapshot is chosen (`ORDER BY created_at DESC, id` — the
 *      same tiebreaker the prune uses, because created_at is transaction time
 *      and ties are otherwise ordered arbitrarily).
 *
 * SCOPE IS DELIBERATELY `is_published = TRUE`. A draft has no audience, so it
 * needs no pinned snapshot, and step 2 copies object-storage blobs per page —
 * running that over every draft in the fleet would be a lot of work to
 * produce rows nobody reads.
 *
 * NOT NULL is never forced on the pointer: NULL means "nothing pinned", which
 * stores/webpage/access.resolveReadVersion reads as its (documented, logged)
 * fall-back — not as version zero.
 */

const { exec, run, getAll, getOne } = require('../db');

async function up() {
    // ORDER, not decoration: at boot this ladder is kicked off with
    // setImmediate (boot/startupTasks.js) and is NOT sequenced after the store
    // inits, so the tables it edits may not exist yet on a fresh install.
    // Awaiting the store's own readiness makes that impossible — and a store
    // whose schema failed surfaces here as a failed migration rather than as a
    // confusing "relation does not exist".
    const webpageStore = require('../stores/webpageStore');
    await webpageStore.ready;

    // Belt: a light build without the webpages module has no table to migrate,
    // and that is not an error — there is simply nothing published to pin.
    const present = await getOne(`SELECT to_regclass('public.webpages') AS t`);
    if (!present || !present.t) {
        console.log('[Migration] webpage-published-version-2026-09 skipped (no webpages table)');
        return { created: 0, pinned: 0, skipped: true };
    }

    // 1. Columns — same statements as stores/webpage/schema.js.
    await exec(`ALTER TABLE webpages ADD COLUMN IF NOT EXISTS published_version_id TEXT`);
    await exec(`ALTER TABLE webpage_versions ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'manual'`);

    // 2. Published pages with no snapshot at all get one. Required by the store
    //    (it copies the RustFS objects), so this is a real snapshot and not an
    //    empty row pointing at nothing.
    const orphans = await getAll(
        `SELECT w.id, w.user_id
           FROM webpages w
          WHERE w.is_published = TRUE
            AND w.published_version_id IS NULL
            AND NOT EXISTS (SELECT 1 FROM webpage_versions v WHERE v.webpage_id = w.id)`
    );
    let created = 0;
    if (orphans.length > 0) {
        for (const row of orphans) {
            try {
                await webpageStore.createVersion(row.user_id, row.id, 'Published', null, 'published');
                created++;
            } catch (e) {
                // One unreachable blob must not stop the rest: the page keeps a
                // NULL pointer and the read path logs its fall-back per read,
                // which is louder than a half-finished migration would be.
                console.warn(`[Migration] webpage-published-version: snapshot for ${row.id} failed: ${e.message}`);
            }
        }
    }

    // 3. The pointer. EXISTS guards the subselect so a page whose snapshot
    //    failed in step 2 keeps NULL instead of being set to NULL again.
    const { rowCount } = await run(
        `UPDATE webpages w
            SET published_version_id = (
                SELECT v.id FROM webpage_versions v
                 WHERE v.webpage_id = w.id
                 ORDER BY v.created_at DESC, v.id
                 LIMIT 1
            )
          WHERE w.is_published = TRUE
            AND w.published_version_id IS NULL
            AND EXISTS (SELECT 1 FROM webpage_versions v2 WHERE v2.webpage_id = w.id)`
    );

    console.log(`[Migration] webpage-published-version-2026-09 applied (${created} snapshot(s) created, ${rowCount || 0} pointer(s) set)`);
    return { created, pinned: rowCount || 0 };
}

module.exports = { up };
