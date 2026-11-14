// @typecheck strict
/**
 * The small text pieces of a note's export (GET /:id/export in
 * routes/transcriptions/noteActions.js).
 */

/**
 * @param {number} seconds
 */
function formatDuration(seconds) {
    if (!seconds) return '0:00';
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}

/**
 * ` (assignee)` for an export line, or nothing: an action item added from a
 * transcript line has no assignee, and printed "(undefined)".
 * @param {{ assignee?: unknown }} item
 */
function assigneeSuffix(item) {
    return typeof item?.assignee === 'string' && item.assignee.trim() ? ` (${item.assignee.trim()})` : '';
}

module.exports = { formatDuration, assigneeSuffix };
