// @typecheck
/**
 * "Which of these knowledge bases may this person actually search, here?"
 *
 * Two questions have to be answered before a base is allowed to contribute a
 * single chunk, and they are NOT the same question:
 *
 *   1. MAY THEY READ IT      → core/kb/kbVisibility.filterKbIdsForUser
 *                              (the access model: owner / org / published /
 *                              shared_groups, with the org-admin bypass
 *                              deliberately OFF at retrieval)
 *   2. MAY IT BE USED HERE   → core/kb/usageContexts.kbUsableIn
 *                              (the owner's surface setting — not a
 *                              permission, and a missing value means
 *                              EVERYWHERE, never nowhere)
 *
 * Both already existed and both were already spelled out inline in
 * routes/ai/directChat/promptAssembly.js. This module is that pair, named
 * once, so the picker's answer, the stored-list answer and the retrieval
 * answer cannot drift apart — a chat that shows "1 knowledge base" while the
 * turn silently searched none is the same class of lie as a shield badge that
 * is not backed by a shield status.
 *
 * ── IT ONLY EVER NARROWS ─────────────────────────────────────────────
 * Every failure mode resolves to a SMALLER set:
 *   - an id that will not resolve            → dropped
 *   - a getKB that throws                    → dropped
 *   - the whole check throwing               → EMPTY, not the input
 *   - a non-array / empty input              → EMPTY
 * There is no path through here that returns an id the caller did not pass
 * in, and no path that returns the input unexamined. "The check could not be
 * run" is not a grant.
 *
 * ── ORG IDS ARE ALWAYS A SET ─────────────────────────────────────────
 * `canUserAccessKB` reads `orgIds === null` as SUPER ADMIN and returns true
 * for everything, so a resolver that failed and handed back null would switch
 * the filter off. Coerced here, exactly as kbVisibility does, and for the same
 * reason.
 */

const { filterKbIdsForUser } = require('./kbVisibility');
const { kbUsableIn } = require('./usageContexts');
const { normaliseKbIds, MAX_ATTACHED_KB_IDS } = require('./kbIdList');
const kbStore = require('../../stores/knowledgeBases');
const log = require('../../telemetry/log');

/**
 * The ids that survive BOTH questions, in the order given.
 *
 * @param {string[]} kbIds            what the client named, or what was stored
 * @param {object} p
 * @param {string|null} p.userId      the ASKER — never an object's owner
 * @param {Set<string>|string[]|null} p.orgIds  coerced to a Set; empty, never null
 * @param {string[]} [p.userGroups]
 * @param {string} [p.surface]        'direct_chat' | 'agent' | 'ai_step' | 'webpage'
 * @param {string} [p.context]        for the drop log; defaults to the surface
 * @param {object} [p.deps]           { kbStore, filterKbIdsForUser } — tests only
 * @param {string} [p.agentId]
 * @returns {Promise<string[]>}
 */
async function resolveUsableKbIds(kbIds, {
    userId = null, orgIds = null, userGroups = [], surface = 'direct_chat', context = null, agentId = null, deps = {},
} = /** @type {any} */ ({})) {
    const ids = normaliseKbIds(kbIds);
    if (ids.length === 0) return [];

    const store = deps.kbStore || kbStore;
    const filter = deps.filterKbIdsForUser || filterKbIdsForUser;
    const logContext = context || surface;

    try {
        const readable = await filter(ids, {
            userId,
            // Never null — see the header.
            orgIds: orgIds instanceof Set ? orgIds : new Set(Array.isArray(orgIds) ? orgIds : []),
            userGroups: Array.isArray(userGroups) ? userGroups : [],
            context: logContext,
            agentId,
            deps,
        });

        const usable = [];
        for (const id of Array.isArray(readable) ? readable : []) {
            let kb = null;
            try { kb = await store.getKB(id); } catch (_) { kb = null; }
            // A base that will not load is dropped, not assumed usable: its
            // usage_contexts are exactly what we cannot read right now.
            if (kb && kbUsableIn(kb, surface)) usable.push(id);
        }
        return usable;
    } catch (err) {
        // The check could not be run. That is not permission to search
        // anything — the whole selection collapses to nothing, loudly.
        log.error('[KBSelection] check failed — treating as NO knowledge bases:', JSON.stringify({
            context: logContext, userId: userId || null, requested: ids.length, error: err && err.message,
        }));
        return [];
    }
}

// Re-exported so callers that need both the policy and the list shape have one
// import; the list helpers themselves live in the dependency-free kbIdList.js.
module.exports = { resolveUsableKbIds, normaliseKbIds, MAX_ATTACHED_KB_IDS };
