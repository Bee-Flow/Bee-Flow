// @typecheck
/**
 * "May THIS person see what this knowledge base holds?" — asked at retrieval,
 * not only at the picker.
 *
 * ── THE HOLE THIS CLOSES ────────────────────────────────────────────
 * A knowledge base id is stored on an agent, an AI step, a project. From then
 * on the retrieval layer trusts it: `localKBIngest` does no tenant filtering
 * of its own — its access boundary IS the id list, on the documented
 * assumption that whoever passed the ids authorised them. `execAi` does check.
 * Agent chat, `quickKBSearch`, the `kb_search` tool and project KBs did not.
 *
 * So a knowledge base shared with the Sales group, attached to an agent that
 * the whole organisation may talk to, answered questions for people outside
 * Sales — with citations. The picker had been honest and the runtime had not.
 *
 * ── FILTERED AT THE CALL SITES, NOT INSIDE THE SEARCH ───────────────
 * `quickKBSearch` stays unfiltered on purpose. It is documented as taking an
 * already-authorised list, and `execAi` filters before calling it; putting a
 * filter inside as well would filter twice — once against the requester and
 * once against whoever the second call site thinks the requester is — and the
 * second answer would silently win. One filter, at each door, with a NAMED
 * asker.
 *
 * ── WHO THE ASKER IS, PER SURFACE ───────────────────────────────────
 * This is the whole design, and it is not uniform:
 *
 *   agent chat / direct chat / kb_search / project KBs → the person asking
 *   an app's AI block                                  → the VIEWER, not the
 *                                                        app's owner
 *   an embed with no session                           → the agent's owner,
 *                                                        but only org-wide
 *                                                        PUBLISHED bases
 *   the support responder                              → an explicit grant,
 *                                                        narrowed by the same
 *                                                        public rule as an
 *                                                        embed — the reply is
 *                                                        e-mailed to a customer
 *   an editor's "Test as · group X" preview            → NOBODY: a member of
 *                                                        that one group, owning
 *                                                        nothing, INTERSECTED
 *                                                        with what the editor
 *                                                        may read anyway
 *
 * The embed case is the sharp one. An anonymous visitor has no identity to
 * evaluate, so the alternative to "the owner, narrowed" is "the owner" — which
 * would let a draft or a group-restricted base answer the public internet.
 *
 * ── ORG-ADMIN BYPASS DOES NOT APPLY HERE ────────────────────────────
 * `canUserAccessKB` lets an org admin READ any base in their org, which is
 * right for a management screen. It is wrong for retrieval: an admin asking an
 * agent a question is asking as themselves, and an answer assembled from a
 * base they only have administrative reach into is a leak with an audit trail
 * that says "the agent said it".
 *
 * ── ORG IDS ARE ALWAYS A SET ────────────────────────────────────────
 * `canUserAccessKB` treats `orgIds === null` as super-admin, returning true
 * for everything. Passing a null through from a resolver that failed would
 * silently disable this filter, so every path here coerces to a Set — an
 * EMPTY Set for "no orgs", never null.
 */

const kbStore = require('../../stores/knowledgeBases');
const log = require('../../telemetry/log');

/**
 * Optional one-release grace mode. `KB_VISIBILITY_ENFORCE=warn` computes the
 * filter and logs what it WOULD have dropped without dropping it, so an
 * operator can see the blast radius on their own data before it bites.
 * Anything else — including unset — enforces.
 */
function warnOnly() {
    return process.env.KB_VISIBILITY_ENFORCE === 'warn';
}

/** Why a base was dropped, for the log line. Never surfaced to the asker. */
function reasonFor(kb, userId, orgIds) {
    if (!kb) return 'unknown';
    if (!kb.organization_id) return 'personal';
    if (orgIds instanceof Set && !orgIds.has(kb.organization_id)) return 'other_org';
    if (!kb.is_published) return 'draft';
    return 'group';
}

/**
 * Narrow a stored list of knowledge-base ids to the ones this person may
 * actually read.
 *
 * @param {string[]} kbIds
 * @param {object} p
 * @param {string|null} p.userId      the ASKER — never the object's owner
 *                                    unless the surface says so
 * @param {Set<string>} p.orgIds      always a Set; empty, never null
 * @param {string[]} [p.userGroups]
 * @param {string} [p.context]        for the log line ('agent_chat', 'kb_search', …)
 * @param {string} [p.agentId]
 * @param {object} [p.deps]
 * @returns {Promise<string[]>} the ids that survive, in the order given
 */
async function filterKbIdsForUser(kbIds, {
    userId, orgIds, userGroups = [], context = 'retrieval', agentId = null, deps = {},
} = /** @type {any} */ ({})) {
    const ids = Array.isArray(kbIds) ? kbIds.filter(id => typeof id === 'string' && id) : [];
    if (ids.length === 0) return [];

    const store = deps.kbStore || kbStore;
    // Never null: a null here means "super admin" to canUserAccessKB and would
    // turn this filter off entirely.
    const orgSet = orgIds instanceof Set ? orgIds : new Set(Array.isArray(orgIds) ? orgIds : []);
    const groups = Array.isArray(userGroups) ? userGroups : [];

    const kept = [];
    const dropped = [];
    for (const id of ids) {
        let kb = null;
        try { kb = await store.getKB(id); } catch (_) { kb = null; }
        // An id that cannot be resolved is dropped. It is deleted, or it was
        // never real; either way it cannot be authorised, and letting it
        // through re-creates the trust-the-client hole this exists to close.
        const ok = !!kb && store.canUserAccessKB(kb, userId, orgSet, groups, { isOrgAdmin: false });
        if (ok) kept.push(id);
        else dropped.push({ id, reason: reasonFor(kb, userId, orgSet) });
    }

    if (dropped.length) {
        for (const d of dropped) {
            log.warn('[KBVisibility] dropped', JSON.stringify({
                context, agentId, kbId: d.id, userId: userId || null, reason: d.reason,
                enforced: !warnOnly(),
            }));
        }
        // The asker is never told. "You are not allowed to see that knowledge
        // base" in a chat reply tells them a base exists, what it is roughly
        // about, and that somebody they know has it — from a question they
        // asked about something else entirely.
        if (warnOnly()) return ids;
    }
    return kept;
}

/**
 * What may be quoted to somebody with no account: an embedded agent's
 * visitor, or a customer receiving a support reply by e-mail.
 *
 * There is no session, so there is no identity to evaluate. The alternative to
 * a rule is "whatever the owner may read", which would let a draft or a
 * group-restricted base answer the public internet. So the rule is: bases the
 * organisation PUBLISHED to itself, plus system reference text. A draft is
 * unfinished and a group-restricted base was restricted on purpose; neither
 * was ever meant to face the public.
 *
 * `requireOrgMatch` is the one part that can be switched off, and only by
 * naming it. Some callers genuinely have no organisation to compare against —
 * the legacy single-tenant support inbox is configured from a global config
 * key and has no inbox row — and for them the org test has nothing to test.
 * Every OTHER rule still applies, which is the difference between this and
 * passing the list through. It defaults to on, and a caller that turns it off
 * has to say so at the call site where somebody will read it.
 *
 * @param {string[]} kbIds
 * @param {object} p
 * @param {Set<string>} p.orgIds            always a Set; empty, never null
 * @param {boolean} [p.requireOrgMatch=true]
 * @param {string} [p.agentId]
 * @param {string} [p.context]
 * @param {object} [p.deps]
 */
async function filterKbIdsForPublicAnswer(kbIds, {
    orgIds, requireOrgMatch = true, agentId = null, context = 'public', deps = {},
} = /** @type {any} */ ({})) {
    const ids = Array.isArray(kbIds) ? kbIds.filter(id => typeof id === 'string' && id) : [];
    if (ids.length === 0) return [];
    const store = deps.kbStore || kbStore;
    const orgSet = orgIds instanceof Set ? orgIds : new Set(Array.isArray(orgIds) ? orgIds : []);

    const drop = (kbId, reason) => log.warn('[KBVisibility] public dropped', JSON.stringify({ context, agentId, kbId, reason }));

    const kept = [];
    for (const id of ids) {
        let kb = null;
        try { kb = await store.getKB(id); } catch (_) { kb = null; }
        if (!kb) { drop(id, 'unknown'); continue; }
        // System bases hold public reference text and are readable by anyone.
        if (kb.source_kind === 'system_managed') { kept.push(id); continue; }
        // A personal base is never public, with or without an org to compare.
        if (!kb.organization_id) { drop(id, 'personal'); continue; }
        if (requireOrgMatch && !orgSet.has(kb.organization_id)) { drop(id, 'other_org'); continue; }
        if (!kb.is_published) { drop(id, 'draft'); continue; }
        if (sharedGroupsOf(kb).length > 0) { drop(id, 'group_restricted'); continue; }
        kept.push(id);
    }
    return kept;
}

/**
 * An identity that owns nothing. Used only by `filterKbIdsForGroupMember`.
 *
 * `canUserAccessKB` short-circuits on `kb.tenant_id === userId`, and that
 * bypass is the whole reason a hypothetical member needs an identity of its
 * own: the person running a "Test as \u00b7 group X" preview usually OWNS some of
 * the bases they are asking about, and answering "yes, group X sees it"
 * because *they* do is the reassuring lie the simulation exists to prevent.
 *
 * It is a SYMBOL, and that is the point. A string sentinel is only safe as
 * long as no row happens to hold it, and `null`/`undefined` are actively
 * dangerous — a row with no `tenant_id` would then be "owned" by nobody, which
 * is exactly who is asking. A symbol is not equal to any value a database row
 * can carry, so the bypass cannot fire whatever the column contains.
 */
const GROUP_MEMBER = Symbol('kb-visibility:group-member');

/**
 * What a MEMBER OF ONE GROUP would be allowed to read — nobody in particular,
 * with no ownership and no administrative reach.
 *
 * This is the "Test as \u00b7 group Sales" half of the agent editor's preview
 * (A1c). It answers a hypothetical, so it deliberately evaluates the same
 * `canUserAccessKB` rule as everything else in this file — a second copy of
 * the publish/org/shared_groups logic would drift, and a simulation that
 * drifted towards "yes" is worse than no simulation.
 *
 * TWO things it is not:
 *   • It is not an authorisation. The caller intersects the result with what
 *     the REAL asker may read (see `agentRuntime/testAs.visibleKbIdsFor`), so
 *     naming a group can never widen anybody's reach. Used on its own it
 *     would be exactly that — do not.
 *   • It is not a person. The asker is the symbol above, so the owner bypass
 *     cannot fire — not for a row the person testing owns, not for a row whose
 *     `tenant_id` is null, and not for one that arrives without the column.
 *
 * @param {string[]} kbIds
 * @param {object} p
 * @param {Set<string>} p.orgIds  the orgs the simulated member belongs to;
 *                                always a Set, empty rather than null
 * @param {string} p.groupId
 * @param {string} [p.agentId]
 * @param {string} [p.context]
 * @param {object} [p.deps]
 */
async function filterKbIdsForGroupMember(kbIds, {
    orgIds, groupId, agentId = null, context = 'test_as', deps = {},
} = /** @type {any} */ ({})) {
    const ids = Array.isArray(kbIds) ? kbIds.filter(id => typeof id === 'string' && id) : [];
    // No group is not "every group": it is a simulation nobody can evaluate.
    if (ids.length === 0 || typeof groupId !== 'string' || !groupId) return [];
    const store = deps.kbStore || kbStore;
    const orgSet = orgIds instanceof Set ? orgIds : new Set(Array.isArray(orgIds) ? orgIds : []);

    const kept = [];
    for (const id of ids) {
        let kb = null;
        try { kb = await store.getKB(id); } catch (_) { kb = null; }
        if (!kb) continue;
        if (store.canUserAccessKB(kb, GROUP_MEMBER, orgSet, [groupId], { isOrgAdmin: false })) {
            kept.push(id);
        } else {
            log.warn('[KBVisibility] test-as dropped', JSON.stringify({
                context, agentId, kbId: id, groupId, reason: reasonFor(kb, null, orgSet),
            }));
        }
    }
    return kept;
}

/**
 * The embed case, evaluated as the agent's OWNER — they chose these bases —
 * narrowed to what may face the public internet.
 * @param kbIds
 * @param {{ ownerUserId?: string, ownerOrgIds?: Set<string>, agentId?: string|null, deps?: object }} [opts]
 */
async function filterKbIdsForEmbed(kbIds, { ownerUserId: _ownerUserId, ownerOrgIds, agentId = null, deps = {} } = {}) {
    return filterKbIdsForPublicAnswer(kbIds, {
        orgIds: ownerOrgIds, agentId, context: 'embed', deps,
    });
}

/** `shared_groups` is TEXT holding JSON on this table, not a jsonb column. */
function sharedGroupsOf(kb) {
    try {
        const g = JSON.parse(kb?.shared_groups || '[]');
        return Array.isArray(g) ? g : [];
    } catch {
        return [];
    }
}

module.exports = {
    filterKbIdsForUser, filterKbIdsForEmbed, filterKbIdsForPublicAnswer,
    filterKbIdsForGroupMember, GROUP_MEMBER,
    sharedGroupsOf, warnOnly, reasonFor,
};
