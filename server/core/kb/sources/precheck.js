// @typecheck strict
/**
 * The optional `precheck` of a source adapter: "has anything changed since the
 * last complete pass?", asked BEFORE enumerate.
 *
 * A folder in a cloud storage is polled every few minutes. Listing it (and a
 * deep tree is one request per folder) to learn that nothing happened is the
 * waste a precheck removes: the adapter compares a cheap cursor (a folder
 * etag, a delta link, a change page token) and the engine ends the pass with
 * no work when it has not moved.
 *
 * Two rules keep this from ever hiding a change:
 *
 *   - ANY error in a precheck means "changed". A check that cannot run is not
 *     evidence that nothing happened; the full pass is the answer.
 *   - The cursor the precheck returns is stored only after a pass that
 *     finished every document (not cancelled, not truncated, none failed).
 *     Storing it earlier would mark files we never read as seen.
 */

/**
 * @param {import('./index').SourceAdapter} adapter
 * @param {import('./index').KbSource} source
 * @param {import('./index').SyncCtx} ctx
 * @param {import('./index').SyncDeps} deps
 * @returns {Promise<{ changed: boolean, cursor: string | null }>}
 */
async function runPrecheck(adapter, source, ctx, deps) {
    if (typeof adapter.precheck !== 'function') return { changed: true, cursor: null };
    try {
        const verdict = await adapter.precheck(source, ctx, deps);
        const cursor = verdict && verdict.cursor != null && verdict.cursor !== '' ? String(verdict.cursor) : null;
        return { changed: !verdict || verdict.changed !== false, cursor };
    } catch (e) {
        ctx.log(`source ${source.id}: precheck failed, running the full pass: ${/** @type {Error} */ (e).message}`);
        return { changed: true, cursor: null };
    }
}

/**
 * Store the cursor of a pass, when that pass covered everything.
 * @param {import('./index').KbSource} source
 * @param {string | null} cursor
 * @param {{ cancelled: boolean, truncated: boolean, failed: number }} counts
 * @param {import('./index').SyncCtx} ctx
 * @param {import('./index').SyncDeps} deps
 */
async function saveCursor(source, cursor, counts, ctx, deps) {
    if (cursor === null || counts.cancelled || counts.truncated || counts.failed > 0 || ctx.partial) return;
    // A test double of the store may not carry it; the real one always does.
    if (typeof deps.kbSourcesStore.setSyncCursor !== 'function') return;
    try {
        await deps.kbSourcesStore.setSyncCursor(source.id, cursor);
    } catch (e) {
        // The next pass simply runs in full again; nothing is lost.
        ctx.log(`could not record the change cursor for source ${source.id}: ${/** @type {Error} */ (e).message}`);
    }
}

module.exports = { runPrecheck, saveCursor };
