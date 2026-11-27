// @typecheck strict
/**
 * The support module's part of "who uses this knowledge base?" (core/kb/kbUsage.js asks for
 * it by name): the inboxes that answer from the base or distil tickets into it, the array the
 * scrub removes it from, and the ingest target the scrub clears.
 */

'use strict';

/** @typedef {import('../kbUsage').KbScan} KbScan */
/** @typedef {import('../kbUsage').KbUsageDb} KbUsageDb */

/** @type {Readonly<Record<string, KbScan>>} */
const SCANS = Object.freeze({
    support: {
        table: 'support_inboxes',
        // TWO different dependencies, and both break on a delete:
        //   kb_ids           — the bases the auto-responder answers FROM
        //   kb_ingest_kb_id  — the base resolved tickets are distilled INTO,
        //                      a scalar column, not an array
        // The second is the one that would have been missed: the inbox keeps
        // running and every distilled ticket lands nowhere.
        sql: `SELECT id, display_name AS title, created_by AS owner_id, updated_at AS last_at, 'chat' AS row_role
                FROM support_inboxes WHERE kb_ids @> $1::jsonb
               UNION ALL
              SELECT id, display_name AS title, created_by AS owner_id, updated_at AS last_at, 'ingest_target' AS row_role
                FROM support_inboxes WHERE kb_ingest_kb_id::text = $2::text`,
        params: (kbId) => [JSON.stringify([kbId]), kbId],
        role: 'chat',
    },
});

/** The JSON array column that holds the base ids, for the scrub. */
const ARRAY_SCRUB = Object.freeze({ table: 'support_inboxes', column: 'kb_ids' });

/**
 * The ingest target is a scalar, so it cannot be filtered out of an
 * array — it is cleared, and the ingest switched off with it. Leaving the
 * flag on with a null target would keep the automation running against
 * nothing, which is the silent version of the same breakage.
 * @param {string} kbId
 * @param {KbUsageDb} db
 * @returns {Promise<number>} the inboxes changed
 */
async function scrubIngestTarget(kbId, db) {
    const r = await db.query(
        `UPDATE support_inboxes
            SET kb_ingest_kb_id = NULL, kb_ingest_enabled = false
          WHERE kb_ingest_kb_id::text = $1::text`,
        [kbId],
    );
    return r.rowCount || 0;
}

module.exports = { SCANS, ARRAY_SCRUB, scrubIngestTarget };
