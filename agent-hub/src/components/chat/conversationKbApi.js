/**
 * Persisting the knowledge bases attached to a direct conversation.
 *
 * One function, and its whole reason for existing is the return value: it
 * hands back what the SERVER stored, never what we asked it to store.
 *
 * PATCH /api/ai/direct/conversations/:id answers `{ success, knowledgeBaseIds }`
 * with the effective list — deduplicated, trimmed, and re-authorised. Sending
 * three ids can therefore store two, and treating the request as the truth
 * would leave the composer showing a base the next turn will not search. So a
 * success only counts when the body carries a readable array; a 200 we cannot
 * read is reported as a failure, because "it saved, probably" is the one
 * answer the caller must never act on.
 *
 * Every non-200 keeps the caller's selection untouched — the server stores
 * NOTHING on a rejection, so the honest local state is the one from before the
 * click. The reasons are returned as codes rather than sentences: the copy
 * belongs to the composer, next to the rest of its t() calls.
 *
 *   invalid      400 — one or more ids are not available to this user. The
 *                offending ids come back in `invalid`, and nothing was stored.
 *   rejected     400 — the shape was refused (not an array, over the cap, an
 *                entry that is not a non-empty string).
 *   forbidden    403 — a project member on someone else's chat: only the owner
 *                may change what a conversation is grounded on.
 *   gone         404 — the conversation is not visible to this user any more.
 *   unavailable  503 — the column is not migrated on this install yet.
 *   failed       anything else, including a network error and an unreadable
 *                success body.
 */

import { API_BASE, authFetch } from '../../utils/helpers';

/** @typedef {{ok: true, knowledgeBaseIds: string[]}} KbSaveOk */
/** @typedef {{ok: false, reason: string, invalid: string[], status: number}} KbSaveFail */

function fail(reason, status = 0, invalid = []) {
    return { ok: false, reason, invalid, status };
}

const STATUS_REASONS = { 403: 'forbidden', 404: 'gone', 503: 'unavailable' };

/** Which refusal this was — the copy for it belongs to the composer. */
function refusal(status, body) {
    if (STATUS_REASONS[status]) return fail(STATUS_REASONS[status], status);
    if (status !== 400) return fail('failed', status);
    const invalid = Array.isArray(body?.invalid) ? body.invalid.filter(v => typeof v === 'string') : [];
    return fail(invalid.length ? 'invalid' : 'rejected', status, invalid);
}

/**
 * @param {string} conversationId
 * @param {string[]} ids the list to attach; `[]` detaches everything.
 * @returns {Promise<KbSaveOk|KbSaveFail>}
 */
export async function saveAttachedKnowledgeBases(conversationId, ids) {
    if (!conversationId) return fail('failed');
    let res;
    try {
        res = await authFetch(`${API_BASE}/ai/direct/conversations/${conversationId}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ knowledgeBaseIds: Array.isArray(ids) ? ids : [] }),
        });
    } catch {
        return fail('failed');
    }

    const status = typeof res?.status === 'number' ? res.status : 0;
    let body = null;
    try { body = await res.json(); } catch { body = null; }

    if (!res?.ok) return refusal(status, body);

    // A 200 whose body we cannot read tells us the write happened and NOT what
    // it wrote. Reporting that as success would put the request back on screen
    // as if it were the stored answer — the exact substitution this module is
    // here to prevent.
    if (!Array.isArray(body?.knowledgeBaseIds)) return fail('failed', status);

    return { ok: true, knowledgeBaseIds: body.knowledgeBaseIds.filter(v => typeof v === 'string' && v) };
}
