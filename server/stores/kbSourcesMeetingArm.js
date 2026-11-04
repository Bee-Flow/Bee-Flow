// @typecheck strict
/**
 * Arming the `meeting_tag` knowledge sources (stores/kbSources.js): a meeting
 * that arrived under a tag, or one that left it, makes the sources watching
 * that tag due for a pass.
 *
 * Arming sets `next_refresh_at = now()` so the refresh job picks them up on its
 * next tick — rather than refreshing inline. A meeting finishing must not
 * make the ingest that saved it wait on an embedding pass, and the job
 * already has the lock, the concurrency limit and the time budget that
 * keep a burst of meetings from becoming a burst of embedding calls.
 *
 * A source that is refreshing right now is armed too. Its pass may already
 * have enumerated the tagged meetings, so this meeting would be missing
 * from it; the arm moves next_refresh_at past the claim's
 * last_refresh_started_at, and finish() keeps that due time rather than
 * writing the next scheduled one. The claim itself is not touched (status
 * stays 'refreshing'), so the running pass is never claimed twice.
 */

/**
 * @param {{ initDB: () => Promise<unknown>, run: (sql: string, params?: unknown[]) => Promise<{ rowCount?: number | null } | null | undefined> }} store
 */
function meetingArms({ initDB, run }) {
    /**
     * @param {string[]} tags
     * @param {boolean} everyMode  false: only `after_meeting` sources
     */
    async function arm(tags, everyMode) {
        await initDB();
        const list = Array.isArray(tags) ? tags.filter(t => typeof t === 'string' && t.trim()) : [];
        if (list.length === 0) return 0;
        // `config->>'tag'` rather than a containment operator: a meeting_tag
        // source watches exactly one tag, stored as a scalar.
        const r = await run(
            `UPDATE kb_sources
                SET next_refresh_at = now(), updated_at = now()
              WHERE kind = 'meeting_tag'
                ${everyMode ? '' : "AND refresh_mode = 'after_meeting'"}
                AND config->>'tag' = ANY($1::text[])`,
            [list],
        );
        return r?.rowCount || 0;
    }
    return {
        /**
         * Arm every `meeting_tag` source watching one of these tags, after a
         * meeting arrived under them. Only sources in `after_meeting` mode. A
         * source somebody deliberately set to `manual` said "I will press the
         * button", and `schedule` said "nightly is fine" — overriding either
         * because a meeting happened would ignore what they asked for.
         * @param {string[]} tags
         * @returns {Promise<number>} how many sources were armed
         */
        armMeetingSources: (tags) => arm(tags, false),
        /**
         * Arm every meeting_tag source watching one of `tags` because a meeting
         * LEFT it: a tag was removed, the note was deleted or erased, or fewer
         * people may read it now. Every refresh mode: a removal is not a refresh
         * the owner can decline. A `manual` or `schedule` source that kept the
         * summary would go on answering from a meeting its owner may not read.
         * @param {string[]} tags
         * @returns {Promise<number>} how many sources were armed
         */
        armMeetingSourcesForRemoval: (tags) => arm(tags, true),
    };
}

module.exports = { meetingArms };
