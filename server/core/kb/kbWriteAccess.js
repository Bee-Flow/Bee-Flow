// @typecheck
/**
 * "May this person WRITE into this knowledge base?" — asked when an automation
 * ingests, not only when somebody clicks.
 *
 * ── THE HOLE THIS CLOSES ────────────────────────────────────────────
 * `executeKbIngestTool` checked one thing: that the knowledge base belonged to
 * the same organisation as the run. Nothing else. So any author of any automation
 * in an organisation could write documents into ANY of that organisation's
 * knowledge bases — including one shared with a group they are not in, and one
 * they have no `manage_knowledge` right over. An automation is a program somebody
 * else may run, so that is a write nobody reviewed reaching a base nobody
 * agreed to.
 *
 * Reading is `core/kb/kbVisibility`; this is the other half, and it is a
 * STRICTER question. Being able to read a base is not permission to put things
 * in it: content in a knowledge base is content an agent will state as fact.
 *
 * ── THE SAME PREDICATE, AT BOTH ENDS ────────────────────────────────
 * Checked when an automation is SAVED and ACTIVATED, so the author is told at the
 * moment they can still do something about it — and again at RUN TIME, keyed
 * on the identity the run actually has. The second is not redundant:
 *
 *   • an automation is saved once and runs for months, and the author's rights
 *     can be taken away in between;
 *   • the base's own sharing can narrow after the link was made;
 *   • the definition is data. An import, a restored version, or an MCP patch
 *     can put an id in it that no save path ever validated.
 *
 * A stored definition is never evidence of authorisation. It is a record of
 * what somebody asked for.
 */

const kbStore = require('../../stores/knowledgeBases');
const log = require('../../telemetry/log');

/** Why a write was refused. For the run log and the save-time finding, never for a prompt. */
const REASONS = Object.freeze({
    UNKNOWN: 'unknown',
    SYSTEM: 'system',
    OTHER_ORG: 'other_org',
    PERSONAL: 'personal',
    NO_MANAGE: 'no_manage',
    // The check could not run. Refuses like the rest — a write is never let
    // through on a question nobody answered — but it is NOT an authorisation
    // verdict, and saying "not available to this automation" about a database
    // blip sends the author to re-check permissions that were never wrong.
    UNAVAILABLE: 'unavailable',
});

/**
 * May `userId` write into this knowledge base?
 *
 * @param {string} kbId
 * @param {object} p
 * @param {string|null} p.userId    the identity the WRITE happens under
 * @param {Set<string>} p.orgIds    always a Set; empty, never null
 * @param {boolean} [p.canManage]   does this person hold `manage_knowledge`?
 * @param {object} [p.deps]
 * @returns {Promise<{ok: boolean, reason?: string, kb?: object}>}
 */
async function canWriteToKb(kbId, { userId, orgIds, canManage = false, deps = {} } = /** @type {any} */ ({})) {
    if (!kbId) return { ok: false, reason: REASONS.UNKNOWN };
    const store = deps.kbStore || kbStore;

    let kb = null;
    try { kb = await store.getKB(kbId); } catch (_) { kb = null; }
    if (!kb) return { ok: false, reason: REASONS.UNKNOWN };

    // A system base is reference text the product ships. Nothing writes into
    // it, including an automation whose author happens to be an administrator.
    if (kb.tenant_id === 'system' || (typeof store.isSystemKB === 'function' && store.isSystemKB(kb))) {
        return { ok: false, reason: REASONS.SYSTEM, kb };
    }

    // Never null: `canUserManageKB` reads a null `orgIds` as super-admin and
    // returns true for everything — the same footgun kbVisibility coerces away.
    const orgSet = orgIds instanceof Set ? orgIds : new Set(Array.isArray(orgIds) ? orgIds : []);

    if (store.canUserManageKB(kb, userId, orgSet, !!canManage)) return { ok: true, kb };

    return {
        ok: false,
        kb,
        reason: !kb.organization_id ? REASONS.PERSONAL
            : !orgSet.has(kb.organization_id) ? REASONS.OTHER_ORG
                : REASONS.NO_MANAGE,
    };
}

/**
 * The same question for an automation's owner, resolving their context for them.
 *
 * An automation runs as its OWNER, not as whoever triggered it — that is the
 * product's rule everywhere else, and a write is the place it matters most: a
 * trigger anyone can fire must not become a way to write as the owner into
 * something the owner could not.
 * @param kbId
 * @param ownerId
 * @param {{ deps?: { askerContext?: Function, hasPermission?: Function, [key: string]: any } }} [opts]
 */
async function canOwnerWriteToKb(kbId, ownerId, { deps = {} } = {}) {
    if (!ownerId) return { ok: false, reason: REASONS.UNKNOWN };
    let orgIds = new Set();
    try {
        const askerContext = deps.askerContext || require('./askerContext').askerContext;
        orgIds = (await askerContext(ownerId)).orgIds;
    } catch (e) {
        // A failed resolve still REFUSES — an empty set is the safe direction
        // for a write — but it is reported as what it is. Silently folding it
        // into `personal`/`other_org` produced "that knowledge base is not
        // available to this automation" for a transient outage, which reads as a
        // permission change and sends somebody to audit sharing that never
        // moved. The datatable sibling makes the same distinction.
        log.warn('[kbWriteAccess] could not resolve the owner context:', e.message);
        return { ok: false, reason: REASONS.UNAVAILABLE };
    }
    let canManage = false;
    try {
        const hasPermission = deps.hasPermission || require('../../auth').hasPermission;
        canManage = await hasPermission(ownerId, 'manage_knowledge');
    } catch (_) {
        canManage = false;
    }
    return canWriteToKb(kbId, { userId: ownerId, orgIds, canManage, deps });
}

/** The sentence a person reads. Never says which base, when the base is not theirs to know about. */
function messageFor(reason, kbName = null) {
    switch (reason) {
        case REASONS.SYSTEM:
            return 'That is a system knowledge base and cannot be written to.';
        case REASONS.NO_MANAGE:
            return `Writing to ${kbName ? `"${kbName}"` : 'this knowledge base'} needs the "manage knowledge" permission.`;
        case REASONS.UNAVAILABLE:
            // Says "try again", not "you may not" — the two send a person to
            // completely different places.
            return 'The permission check could not run just now, so nothing was written. Try again shortly.';
        case REASONS.PERSONAL:
        case REASONS.OTHER_ORG:
        case REASONS.UNKNOWN:
        default:
            // One answer for "no such base" and "not yours": telling them
            // apart is a way to discover which knowledge bases exist.
            return 'That knowledge base is not available to this automation.';
    }
}

module.exports = { canWriteToKb, canOwnerWriteToKb, messageFor, REASONS };
