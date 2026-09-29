/**
 * History merge helpers for conversation edit/retry.
 *
 * Shared by direct chat and the agent runtime: both receive a slim client
 * history on edit/retry and both persist a full replace, so both need the
 * rich DB rows grafted back on or the stored sidecars are destroyed.
 *
 * The client sends a slim history on edit/retry (and on surfaces that never
 * synced a conversation id): attachments are reduced to bare metadata and the
 * content is the PII-restored text. The DB rows are the rich source of truth —
 * they carry the attachment sidecars (extractedText / extractionKey /
 * storageKey) that the historyHydrator needs to keep file content visible to
 * the model, plus timestamps and privacy metadata.
 *
 * Aligning the two is not trivial: messages have no shared stable id (DB rows
 * get a server-side uuid, the client generates its own), and content strings
 * differ wherever PII tokenization rewrote the stored copy ([email_1] in the
 * DB vs the restored address on the client). So alignment anchors on exact
 * role+content matches where possible and falls back to role-ordinal pairing
 * in between — safe because the client history is a strict prefix of the DB
 * message sequence in edit/retry flows.
 */
const log = require('../../telemetry/log');

function _isConvMessage(m) {
    return !!m && (m.role === 'user' || m.role === 'assistant');
}

/**
 * Align a slim client history onto rich DB messages.
 *
 * @param {Array} clientHistory - messages as sent by the client (user/assistant, ordered)
 * @param {Array} dbMessages - persisted messages (may include tool/system rows, skipped)
 * @returns {Array<{ client: object, dbMatch: object|null }>} one entry per client message,
 *   in order; dbMatch is null when no plausible counterpart exists (e.g. the
 *   client history is longer than the DB record). Inputs are not mutated.
 */
function alignClientToDb(clientHistory = [], dbMessages = []) {
    const dbConv = (Array.isArray(dbMessages) ? dbMessages : []).filter(_isConvMessage);
    const client = Array.isArray(clientHistory) ? clientHistory : [];
    const matchIdx = new Array(client.length).fill(-1);

    // Pass 1 — anchor on role + exact content (monotonic, no reuse). These
    // survive PII tokenization only when the message contained no PII, which
    // is still the common case and pins the alignment down.
    let cursor = 0;
    for (let i = 0; i < client.length; i++) {
        const c = client[i];
        if (!_isConvMessage(c) || typeof c.content !== 'string') continue;
        for (let j = cursor; j < dbConv.length; j++) {
            if (dbConv[j].role === c.role && dbConv[j].content === c.content) {
                matchIdx[i] = j;
                cursor = j + 1;
                break;
            }
        }
    }

    // Pass 2 — fill the unresolved messages by role-ordinal pairing inside the
    // window between surrounding anchors. Ordinal order is authoritative where
    // content is incomparable (tokenized DB copy vs restored client copy).
    const claimed = new Set(matchIdx.filter(j => j >= 0));
    let prevAnchor = -1;
    for (let i = 0; i < client.length; i++) {
        if (matchIdx[i] >= 0) { prevAnchor = matchIdx[i]; continue; }
        if (!_isConvMessage(client[i])) continue;
        let nextAnchor = dbConv.length;
        for (let k = i + 1; k < client.length; k++) {
            if (matchIdx[k] >= 0) { nextAnchor = matchIdx[k]; break; }
        }
        for (let j = prevAnchor + 1; j < nextAnchor; j++) {
            if (!claimed.has(j) && dbConv[j].role === client[i].role) {
                matchIdx[i] = j;
                claimed.add(j);
                prevAnchor = j;
                break;
            }
        }
    }

    return client.map((c, i) => ({
        client: c,
        dbMatch: matchIdx[i] >= 0 ? dbConv[matchIdx[i]] : null,
    }));
}

/**
 * Graft persisted attachment sidecars onto a slim client history.
 *
 * The DB sidecar is a strict superset of the client's `{ name, type }` copy,
 * so it is adopted wholesale; content stays the client's (their truncation /
 * edit is authoritative). Defensive: when the client's attachment names
 * disagree with the DB row's, the client copy is kept untouched.
 *
 * @returns {Array} a new history array; inputs are not mutated.
 */
function mergeAttachmentSidecars(clientHistory = [], dbMessages = []) {
    return alignClientToDb(clientHistory, dbMessages).map(({ client, dbMatch }) => {
        if (!client || !dbMatch) return client;
        const dbAtts = Array.isArray(dbMatch.attachments) ? dbMatch.attachments : [];
        if (dbAtts.length === 0) return client;
        const clientAtts = Array.isArray(client.attachments) ? client.attachments : [];
        if (clientAtts.length > 0) {
            const names = atts => atts.map(a => a?.name || '').sort().join('|');
            if (names(clientAtts) !== names(dbAtts)) {
                log.warn('[HistoryMerge] Client attachments disagree with DB row — keeping client copy');
                return client;
            }
        }
        return { ...client, attachments: dbAtts };
    });
}

/**
 * Whether OpenAI Responses `previous_response_id` chaining must be disabled
 * for this turn.
 *
 * - Client-supplied history means edit/retry: the provider-side chain would
 *   replay the pre-edit conversation and ignore the truncation.
 * - Attachment context means the model needs the hydrated extractedText
 *   blocks, which a chained request never transmits (it sends only the last
 *   user message) — the file would silently depend on opaque provider state.
 */
function shouldDisableResponsesChaining({ clientHistoryProvided = false, attachmentContext = false } = {}) {
    return !!(clientHistoryProvided || attachmentContext);
}

module.exports = { alignClientToDb, mergeAttachmentSidecars, shouldDisableResponsesChaining };
