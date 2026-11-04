// @typecheck strict
/**
 * The notebook kind of meetingUsage.js: which notebooks hold a copy of a
 * meeting, and whether pre-column sources leave that question open.
 */

const { columnExists } = require('./schemaProbe');

/** @typedef {import('./meetingUsage').MeetingRef} MeetingRef */

/**
 * Notebooks holding a copy of this meeting.
 *
 * `notebook_sources` has no owner column of its own — the notebook is the
 * only ownership anchor, which is why this joins rather than filtering.
 *
 * ── WHY THIS KIND IS SO OFTEN `partial` ─────────────────────────────
 * `POST /notebooks/:id/sources/meeting` records the text and the name
 * `Meeting Note: <title>`, and recorded nothing else: no column said
 * WHICH meeting it came from. `source_ref_id` fixes it (notebookStore adds the
 * column and the route fills it), but the rows written before it cannot be
 * backfilled — a title is not an id, two meetings share one every week, and
 * renaming a meeting rewrites nothing. So:
 *
 *   - column present  → an exact answer for every row that carries a ref;
 *   - any `type='meeting'` row with a NULL ref → the kind is `partial`,
 *     because those rows might be this meeting and there is no way to tell;
 *   - column absent   → every meeting source is such a row: `partial`, no
 *     rows.
 *
 * Matching on the name instead was considered and rejected: it would claim a
 * notebook holds this meeting on the strength of a title two meetings share,
 * and a wrong row in the delete dialog is a person deciding against a real
 * consequence that is not there.
 * @param {MeetingRef | null | undefined} meeting
 * @param {import('./schemaProbe').Queryable} db
 */
async function scanNotebook(meeting, db) {
    const id = meeting?.id != null ? String(meeting.id) : null;
    if (!id) return { rows: [], undecided: true };

    const hasRef = await columnExists('notebook_sources', 'source_ref_id', db);
    if (!hasRef) return { rows: [], undecided: true };

    const r = await db.query(
        `SELECT ns.id AS source_id, ns.name AS source_name, ns.updated_at AS last_at,
                nb.id AS notebook_id, nb.name AS notebook_name, nb.user_id AS owner_id
           FROM notebook_sources ns
           JOIN notebooks nb ON nb.id = ns.notebook_id
          WHERE ns.source_ref_id = $1`,
        [id],
    );
    const rows = (r.rows || []).map((row) => ({
        kind: 'notebook',
        id: row.notebook_id,
        title: row.notebook_name || null,
        role: 'contains',
        siteLabel: row.source_name || undefined,
        lastAt: row.last_at || null,
        ownerId: row.owner_id || null,
    }));

    // The unbackfillable remainder: is ANY pre-column meeting source still
    // around? `LIMIT 1` stops at the first hit, so the common case — an
    // install that still has some — is cheap. The expensive case is the happy
    // one (none left), which reads the table to prove a negative; the column
    // migration should carry a partial index
    // `(source_ref_id) WHERE type = 'meeting' AND source_ref_id IS NULL` so
    // this stays an index probe on a large notebook_sources.
    return { rows, undecided: await hasLegacyMeetingSource(meeting, db) };
}

/**
 * Is a pre-column (ref-less) meeting source left that could be THIS meeting?
 * Scoped to notebooks that could hold it — the owner's, or (where notebooks
 * carry one) the meeting's organisation's: a ref-less row in another tenant
 * must not put this meeting's delete behind the "notebooks not checked"
 * confirmation.
 * @param {MeetingRef | null | undefined} meeting
 * @param {{ query: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }> }} db
 */
async function hasLegacyMeetingSource(meeting, db) {
    const ownerId = meeting?.ownerId || meeting?.userId || null;
    const orgId = meeting?.organizationId || null;
    const scopeParams = [ownerId != null ? String(ownerId) : null];
    let scope = 'nb.user_id::text = $1';
    if (orgId && await columnExists('notebooks', 'organization_id', db)) {
        scopeParams.push(String(orgId));
        scope += ' OR nb.organization_id::text = $2';
    }
    const legacy = await db.query(
        `SELECT 1 FROM notebook_sources ns
           JOIN notebooks nb ON nb.id = ns.notebook_id
          WHERE ns.type = 'meeting' AND ns.source_ref_id IS NULL AND (${scope})
          LIMIT 1`,
        scopeParams,
    );
    return (legacy.rows || []).length > 0;
}

module.exports = { scanNotebook, hasLegacyMeetingSource };
