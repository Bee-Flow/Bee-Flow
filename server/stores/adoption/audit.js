// @typecheck strict
/**
 * The access-audit row of a name reveal in the Adoption report, written so a
 * failure is a failure.
 *
 * userStore.logAccessAudit is best-effort by design: it logs and swallows a
 * failed write, so the caller cannot tell a recorded read from an unrecorded
 * one. A reveal of who uses AI how much is lawful only with the record (Art.
 * 5(2) accountability, A.8.15), so the route needs the write to THROW when it
 * did not happen and answers 503 then (the dsr.subject_viewed precedent). The
 * row is the same row in the same table (access_audit_log, the columns of
 * stores/user/audit.js), so every reader of the access audit sees it.
 *
 * The payload is an explicit allow-list: the period, the group id and the page
 * size. Never a name, an e-mail address or a user id of the people shown.
 */

'use strict';

const crypto = require('node:crypto');

const REVEAL_ACTION = 'usage_adoption_people_revealed';

/**
 * @typedef {{ startDate: string, endDate: string, group: string | null, limit: number }} RevealDetails
 */

/**
 * @param {{ run: (sql: string, params: unknown[]) => Promise<unknown> }} db
 * @param {{ orgId: string, actorId: string, details: RevealDetails }} reveal
 */
async function recordReveal(db, { orgId, actorId, details }) {
    const payload = {
        startDate: String(details.startDate),
        endDate: String(details.endDate),
        group: details.group ? String(details.group) : null,
        limit: Number(details.limit) || 0,
    };
    await db.run(
        `INSERT INTO access_audit_log (id, action, target_type, target_id, organization_id, changed_by, old_values, new_values)
         VALUES ($1, $2, 'organization', $3, $3, $4, NULL, $5)`,
        [crypto.randomUUID(), REVEAL_ACTION, orgId, actorId, JSON.stringify(payload)],
    );
}

module.exports = { recordReveal, REVEAL_ACTION };
