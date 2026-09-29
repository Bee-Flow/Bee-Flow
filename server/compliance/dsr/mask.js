/**
 * DSR masking helpers (BFSF-441: personal data leaves Bee Flow only by e-mail
 * to the data subject).
 *
 * The register list, the deadline feed, evidence rows, notifications and the
 * dossier export all show the subject's address MASKED. Rows are rebuilt from
 * an explicit allow-list of columns — never by deleting `subject_email` from a
 * row, so a column added next year does not leak by default.
 */

/**
 * `jan.jansen@example.org` → `j***@example.org`. Keeps the first character of
 * the local part and the full domain (enough to recognise a request in a list,
 * not enough to identify the person). Non-strings and addresses without `@`
 * mask to `***`.
 */
function maskEmail(email) {
    if (typeof email !== 'string') return '***';
    const trimmed = email.trim();
    const at = trimmed.lastIndexOf('@');
    if (at <= 0 || at === trimmed.length - 1) return '***';
    const local = trimmed.slice(0, at);
    const domain = trimmed.slice(at + 1);
    return `${local[0]}***@${domain}`;
}

/**
 * Columns a list / detail view may carry — the DPO working the request inside
 * the app. `subject_email` is deliberately absent; the free-text columns are
 * here because the DPO has to read what the subject asked for.
 */
const PUBLIC_COLUMNS = Object.freeze([
    'id', 'organization_id', 'request_type', 'status', 'notes', 'result_summary',
    'created_at', 'fulfilled_at', 'fulfilled_by',
    'channel', 'identity_status', 'identity_verified_at', 'created_by',
    'started_at', 'started_by',
    'extended_until', 'extension_reason', 'extended_by', 'extended_at',
    'due_at', 'timeline', 'subject_user_id',
]);

/**
 * Columns the DOSSIER may carry — a file that leaves the app, under a claim
 * that it holds no personal data of the subject.
 *
 * Its own literal list, NOT `PUBLIC_COLUMNS` minus a few: a column added to
 * the in-app view next year must not reach a downloaded file by default, and
 * the two lists answer different questions.
 *
 * Every free-text column is absent. `notes` is typed by the data subject on
 * the public form ("Ik ben Jan Jansen, Kerkstraat 1…"), `result_summary` and
 * `extension_reason` by an admin who is describing that same person — each is
 * a place where a name or an address lands in prose, which no key-level
 * filter can catch. `dossierRequest` reports their LENGTH instead, the way
 * the evidence chain already does (`summary_length`).
 */
const DOSSIER_COLUMNS = Object.freeze([
    'id', 'organization_id', 'request_type', 'status',
    'created_at', 'fulfilled_at', 'fulfilled_by',
    'channel', 'identity_status', 'identity_verified_at', 'created_by',
    'started_at', 'started_by',
    'extended_until', 'extended_by', 'extended_at',
    'due_at', 'subject_user_id',
]);

/** The free-text columns, reported as lengths where the text may not go. */
const FREE_TEXT_COLUMNS = Object.freeze(['notes', 'result_summary', 'extension_reason']);

/**
 * Pick the allow-listed columns of a dsr_requests row and add
 * `subject_email_masked`. Missing columns stay missing (never invented).
 * @param {object} row
 * @param {{extra?: string[], columns?: readonly string[]}} [opts] extra
 *   allow-listed keys (e.g. `days_left`); `columns` picks the destination's
 *   allow-list (default: the in-app one).
 */
function maskRequest(row, { extra = [], columns = PUBLIC_COLUMNS } = {}) {
    if (!row || typeof row !== 'object') return null;
    const out = {};
    for (const col of [...columns, ...extra]) {
        if (col === 'subject_email') continue;
        if (Object.prototype.hasOwnProperty.call(row, col)) out[col] = row[col];
    }
    out.subject_email_masked = maskEmail(row.subject_email);
    return out;
}

/**
 * The request as the downloadable dossier carries it: `DOSSIER_COLUMNS` plus
 * `<field>_length` for every free-text column that has text in it. No prose
 * of any kind, so "this file contains no personal data of the subject" holds.
 */
function dossierRequest(row, { extra = [] } = {}) {
    if (!row || typeof row !== 'object') return null;
    const out = maskRequest(row, { extra, columns: DOSSIER_COLUMNS });
    for (const col of FREE_TEXT_COLUMNS) {
        if (typeof row[col] === 'string') out[`${col}_length`] = row[col].length;
    }
    return out;
}

/**
 * Timeline events may carry free text typed by an admin; the `by` field is a
 * user id (not an address). Kept as-is, but the shape is re-built from an
 * allow-list too so a future `email` field on an event cannot leak.
 */
const EVENT_KEYS = Object.freeze(['at', 'by', 'kind', 'text', 'channel', 'method', 'until', 'status', 'reason']);

/**
 * The same trail for the DOSSIER: no `text`, no `reason`. Those carry the
 * extension reason, the result summary and an admin's note verbatim — the
 * same prose `DOSSIER_COLUMNS` refuses, so dropping it from the row and
 * leaving it in the trail would only move the leak one key across.
 */
const DOSSIER_EVENT_KEYS = Object.freeze(['at', 'by', 'kind', 'channel', 'method', 'until', 'status']);

function _pickEvents(timeline, keys, withLengths) {
    if (!Array.isArray(timeline)) return [];
    return timeline.map(ev => {
        if (!ev || typeof ev !== 'object') return null;
        const out = {};
        for (const k of keys) {
            if (Object.prototype.hasOwnProperty.call(ev, k)) out[k] = ev[k];
        }
        if (withLengths && typeof ev.text === 'string') out.text_length = ev.text.length;
        return out;
    }).filter(Boolean);
}

function maskTimeline(timeline) {
    return _pickEvents(timeline, EVENT_KEYS, false);
}

/** The trail as the downloadable dossier carries it: shape, not prose. */
function dossierTimeline(timeline) {
    return _pickEvents(timeline, DOSSIER_EVENT_KEYS, true);
}

module.exports = {
    maskEmail, maskRequest, dossierRequest, maskTimeline, dossierTimeline,
    PUBLIC_COLUMNS, DOSSIER_COLUMNS, FREE_TEXT_COLUMNS, EVENT_KEYS, DOSSIER_EVENT_KEYS,
};
