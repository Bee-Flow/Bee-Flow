// @typecheck strict
/**
 * The 409 gate for DELETE /:id — see the explanation below.
 *
 * Its own module because this is not HTTP but a verdict: what still uses this page, and
 * which sub-question could NOT be answered. The route (./lifecycle.js) only wraps a
 * status around it.
 */

const webpageUsage = require('../../core/webpages/webpageUsage');
const log = require('../../telemetry/log');

/**
 * ── WHAT BREAKS, BEFORE IT BREAKS (W5 part C) ───────────────────────
 *
 * A web page is not a standalone thing. It lies in a Solution that has included it in a
 * screen, an AUTOMATION names it in a `webpage_db_exec` step, an ordinary chat can have
 * it in the side panel, and an agent can open it as a tool. None of those failures NAMES
 * this page at the moment they occur, and none of them can be reverted — so the first
 * DELETE answers with 409 and the list, and only a second one with `?confirm=1` gets
 * past. Literally the two-step of the meeting note (routes/transcriptions/noteActions.js),
 * the knowledge base and the table, with the same `code:'in_use'` + `usage` that
 * shared/DangerZone.jsx reads.
 *
 * `unchecked` COUNTS AS IN USE. "Three things use this page" and "I could not check the
 * agents" both come back as 409 and lead to the same button, but they are not the same
 * verdict: the first is a list, the second is a gap. Whoever merges them tells the reader
 * that a scan succeeded that did not run. Today the agent AND the chat sub-question are in
 * principle unanswerable (see the header of core/webpages/webpageUsage.js), so every page
 * sits behind at least one 409 — that is the honest state, and the escape hatch is a
 * CONFIRMED second call, never a silent retry.
 *
 * And the scan that ITSELF falls over is the most dangerous of the three: it would come
 * back as an empty list, and an empty list is exactly the sentence someone clicks through.
 * That is why a scan that failed here reports ALL kinds as not checked rather than as
 * zero — unknown narrows.
 * @param {{ id: string, name?: string }} wp
 * @param {string} userId
 */
async function describeWebpageDeleteBlock(wp, userId) {

    let scan;
    try {
        scan = await webpageUsage.usageForWebpage(wp);
    } catch (err) {
        // `usageForWebpage` catches each sub-question separately, so arriving here means that
        // nothing was checked. Not "nothing uses this".
        log.warn(`[Webpages] Delete guard scan failed for ${wp?.id}:`, /** @type {Error} */ (err).message);
        return {
            error: 'Could not check what uses this webpage',
            code: 'in_use',
            usage: [],
            unchecked: [...webpageUsage.KINDS],
            sources: Object.fromEntries(webpageUsage.KINDS.map(k => [k, {
                status: 'unavailable', found: null, reason: webpageUsage.REASONS.SCAN_FAILED,
            }])),
            complete: false,
        };
    }

    const { rows, partial, sources, complete } = scan;
    if (rows.length === 0 && partial.length === 0) return null;
    return {
        // Two different sentences for two different facts. The client chooses its own words
        // (DangerZone shows its own heading), but a log line or a curl must not tell the wrong
        // story here.
        error: rows.length > 0
            ? 'This webpage is still in use'
            : 'Could not check what uses this webpage',
        code: 'in_use',
        // Someone else's Solution keeps kind and role and loses its name — the same narrowing as
        // GET /:id/usage, so that the tab and this gate cannot come to differ from each other.
        usage: webpageUsage.redactForeign(rows, userId),
        unchecked: partial,
        sources,
        complete,
    };
}

module.exports = { describeWebpageDeleteBlock };
