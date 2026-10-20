/**
 * Paginated Gmail history walk shared by the gmail pollers (mail.new,
 * label.added) in ./gmail.js.
 *
 * A single history.list page is not "everything since the cursor": Gmail
 * splits the history into pages (`nextPageToken`), and the response's
 * `historyId` is the NEWEST id regardless of how much of it was returned.
 * Reading one page and then moving the cursor to that `historyId` silently
 * drops every record on the later pages. This walk follows `nextPageToken`
 * and, when it stops early on a per-tick cap, reports the id of the LAST
 * record it drained so the caller advances the cursor only that far and the
 * next tick resumes right after it (steady progress, no re-dispatch).
 */

const MAX_GMAIL_HISTORY_PAGES = 10;

/**
 * @param {any} gmail  googleapis gmail client (users.history.list)
 * @param {object} opts
 * @param {string} opts.startHistoryId  the subscription's cursor
 * @param {string[]} opts.historyTypes  e.g. ['messageAdded'] or ['labelAdded']
 * @param {(record: any) => number} opts.onRecord  called once per history
 *        record in order; returns how many distinct events the caller holds
 *        so far (checked against maxEvents after each record).
 * @param {number} opts.maxEvents  stop once onRecord reports this many
 * @param {number} [opts.maxPages]
 * @returns {Promise<{ nextCursor: string|null, capped: boolean, latestHistoryId: string|null, lastProcessedHistoryId: string|null }>}
 */
async function walkGmailHistory(gmail, { startHistoryId, historyTypes, onRecord, maxEvents, maxPages = MAX_GMAIL_HISTORY_PAGES }) {
    let pageToken;
    let latestHistoryId = null;        // newest historyId Gmail reported
    let lastProcessedHistoryId = null; // historyId of the last record we drained
    let pages = 0;
    let capped = false;
    outer:
    do {
        const r = await gmail.users.history.list({
            userId: 'me',
            startHistoryId,
            historyTypes,
            pageToken,
        });
        if (r.data.historyId) latestHistoryId = r.data.historyId;
        for (const h of (r.data.history || [])) {
            const count = onRecord(h);
            if (h.id) lastProcessedHistoryId = h.id;
            if (count >= maxEvents) { capped = true; break outer; }
        }
        pageToken = r.data.nextPageToken || undefined;
        pages++;
        if (pages >= maxPages && pageToken) { capped = true; break; }
    } while (pageToken);

    // Advance the cursor: to the last record we drained when capped (so the
    // next tick resumes right after it), else to the newest historyId (fully
    // caught up).
    const nextCursor = capped ? (lastProcessedHistoryId || latestHistoryId) : latestHistoryId;
    return { nextCursor, capped, latestHistoryId, lastProcessedHistoryId };
}

module.exports = { walkGmailHistory, MAX_GMAIL_HISTORY_PAGES };
