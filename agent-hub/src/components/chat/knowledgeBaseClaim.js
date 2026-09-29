/**
 * What the composer is ALLOWED to say about the knowledge bases behind the
 * next answer (C3) — the same rule as composerClaims.js, one subject further.
 *
 * The pill answers a question the user cannot check for themselves: "where
 * will this answer come from?". That makes every wrong shape of it worse than
 * no pill at all:
 *
 *   A pill saying NOTHING attached when the list simply never loaded is a
 *   claim we cannot substantiate. `/api/kb` is lazy; before it answers — and
 *   after it fails — we do not know whether this chat reaches nothing or
 *   reaches five bases. `resolveKbClaim` returns null there and the composer
 *   renders no pill, so the absence of a statement is the statement.
 *
 *   A pill counting an id the server did not return is the same lie with a
 *   number on it. Access is re-evaluated on EVERY read server-side
 *   (kbVisibility + `usage_contexts ∋ 'direct_chat'`); a stored id whose base
 *   was deleted, unshared, or taken out of chat still sits in the column and
 *   still arrives in whatever the client last held. The claim therefore counts
 *   the INTERSECTION of the selection with the list the server just handed us,
 *   never the selection on its own.
 *
 * Both rules collapse to one sentence: the server filters, this module
 * subtracts, and the UI adds nothing.
 *
 * Deliberately free of copy — it returns rows and ids, never a sentence, so
 * the composer keeps the t() calls and this stays a pure, translatable-by-
 * construction decision.
 */

/**
 * May this knowledge base be offered in a chat? `usage_contexts` is jsonb on
 * the row and arrives as an array (or, on some read paths, the raw string).
 * A value that was never expressed means EVERYWHERE — never nowhere: reading
 * a missing column as "nowhere" would empty this picker on every install
 * predating it.
 */
export function usableInChat(kb) {
    const raw = kb?.usage_contexts ?? kb?.usageContexts;
    if (raw === null || raw === undefined) return true;
    let list = raw;
    if (typeof raw === 'string') {
        try { list = JSON.parse(raw); } catch { return true; }
    }
    if (!Array.isArray(list)) return true;
    return list.includes('direct_chat');
}

/**
 * The list the direct-chat picker may be handed, or null when there is no
 * list to hand it.
 *
 * `listKnown` is the whole point. `/api/kb` is fetched lazily and can come
 * back 401 or 500, and the caller's array is `[]` in both of those cases as
 * well as when the user genuinely has none — so the array alone cannot answer
 * "did anyone ask?". Passing `[]` for a failed fetch is what puts an
 * authoritative-looking "no knowledge bases" under a chat that is in fact
 * grounded on three of them.
 *
 * The chat-usability filter runs here rather than in the fetch because that
 * ONE list also feeds the Knowledge store, a management screen that has to
 * show everything the person manages, chat-usable or not.
 */
export function directChatKbList(kbs, listKnown) {
    if (!listKnown) return null;
    return (Array.isArray(kbs) ? kbs : []).filter(usableInChat);
}

/**
 * May this account attach knowledge bases to a chat itself?
 *
 * A product gate, not an access check — the server re-authorises every id on
 * every read and every turn regardless of what this says. It decides who gets
 * the PICKER, which is why it is a poor gate for the pill itself: a
 * conversation that already carries bases searches them for whoever opens it,
 * so hiding the statement along with the control would make the grounding
 * invisible rather than absent. It lives here, next to the claim it qualifies,
 * so the two halves of that distinction cannot drift apart.
 */
export function chatKnowledgeBasesAllowed(user) {
    if (!user) return false;
    if (user.isAdmin) return true;
    if (Array.isArray(user.permissions) && user.permissions.includes('all')) return true;
    return Array.isArray(user.betaFeatures) && user.betaFeatures.includes('knowledge_bases_beta');
}

/**
 * The server's cap on how many bases one conversation may carry. PATCH
 * refuses a longer list outright and stores nothing, so the composer stops
 * one short of asking rather than showing a rejection it could predict.
 */
export const MAX_ATTACHED_KBS = 50;

/**
 * @param {object} args
 * @param {Array|null|undefined} args.availableKBs the rows GET /api/kb
 *   returned. Anything that is not an array means UNKNOWN — not empty.
 * @param {Array|null|undefined} args.selectedKBIds ids this chat holds.
 * @returns {{options: object[], attached: object[], attachedIds: string[]}|null}
 *   null = say nothing at all. `options` is what the picker may offer,
 *   `attached` the rows that are really behind the next answer, in list order.
 */
export function resolveKbClaim({ availableKBs, selectedKBIds } = {}) {
    if (!Array.isArray(availableKBs)) return null;
    const options = availableKBs.filter(kb => kb && typeof kb.id === 'string' && kb.id && usableInChat(kb));
    const wanted = new Set(Array.isArray(selectedKBIds) ? selectedKBIds : []);
    const attached = options.filter(kb => wanted.has(kb.id));
    return { options, attached, attachedIds: attached.map(kb => kb.id) };
}

/**
 * The names to put in the pill's title, dropping anything unnamed — a base
 * whose name we do not have is shown as nothing rather than as its id, which
 * would read like a name to everyone who has not seen a uuid before.
 */
export function attachedNames(claim) {
    if (!claim) return [];
    return claim.attached
        .map(kb => (typeof kb.name === 'string' ? kb.name.trim() : ''))
        .filter(Boolean);
}

/**
 * The list a toggle produces, built from what the SERVER last confirmed
 * (`attachedIds`) rather than from the raw selection.
 *
 * This is what keeps a dead id from wedging the picker: an id whose base is
 * gone stays in the client's selection until something replaces it, and
 * re-sending it makes the server reject the whole PATCH (400, nothing stored)
 * on every subsequent change. Starting from the confirmed subset drops it on
 * the first edit, which is also the only honest list to send — it is exactly
 * the set the user can see ticked.
 */
export function toggledIds(claim, id) {
    const base = claim ? claim.attachedIds : [];
    return base.includes(id) ? base.filter(x => x !== id) : [...base, id];
}
