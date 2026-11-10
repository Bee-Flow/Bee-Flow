// @typecheck noImplicitAny
/**
 * Support auto-assignment — round-robin assignment of escalated threads to
 * staff who hold the `admin_support` permission.
 *
 * Eligibility for a thread's org:
 *   • platform admins (role === 'admin') are always eligible;
 *   • org-scoped support staff are eligible only for their own org's threads.
 * Anonymous/marketing threads (no org) are assignable to super-admins only.
 *
 * The round-robin cursor lives in support_assignment_state and is advanced
 * atomically (SELECT … FOR UPDATE) so concurrent escalations don't collide.
 */

const userStore = require('../stores/userStore');
const supportStore = require('../stores/supportStore');
const { getUserPermissions } = require('../auth/permissions');

// Short cache of eligible-staff lists per org — escalations can burst.
const _cache = new Map(); // orgKey → { ids, ts }
const CACHE_TTL_MS = 60_000;

const { hasSupportPerms: _hasSupport } = require('../support/staffAccess');
const { bestEffort, fallback } = require('../utils/bestEffort');

/**
 * Is this account eligible for a thread of `orgId`? Platform admins always;
 * org staff only for their own org and only with the admin_support permission
 * (the 'all' wildcard alone is not staff). For a tenant support inbox
 * (`tenantInbox`) the rule is the inbox gate's own: an org member holding
 * `support_inbox` or `all`.
 * @param {{ id: string, role?: string, organizationId?: string, disabled?: boolean, suspended?: boolean }} u
 * @param {string} orgId
 * @param {(userId: string, session: null) => Promise<string[] | Set<string>>} permsOf
 * @param {boolean} [tenantInbox]
 * @returns {Promise<boolean>}
 */
async function _isEligibleStaff(u, orgId, permsOf, tenantInbox = false) {
    if (u.disabled || u.suspended) return false;
    if (u.role === 'admin') return true;
    // Org-scoped staff only handle their own org's threads.
    if (!orgId || u.organizationId !== orgId) return false;
    try {
        const perms = await permsOf(u.id, null);
        if (!tenantInbox) return _hasSupport(perms);
        const list = Array.isArray(perms) ? perms : [...perms];
        return list.includes('support_inbox') || list.includes('all');
    } catch (err) { fallback('services/supportAutoAssigner:permissions', err); /* no support permission: skipped */ return false; }
}

/**
 * @param {string | null} orgId
 * @param {{ tenantInbox?: boolean }} [opts] tenantInbox: eligibility for a tenant support inbox
 * @returns {Promise<string[]>}
 */
async function _eligibleStaffForOrg(orgId, { tenantInbox = false } = {}) {
    const key = (orgId || '__global__') + (tenantInbox ? ':tenant' : '');
    const cached = _cache.get(key);
    if (cached && Date.now() - cached.ts < CACHE_TTL_MS) return cached.ids;

    const users = await userStore.getAllUsers();
    const ids = [];
    for (const u of users || []) {
        if (await _isEligibleStaff(u, /** @type {string} */ (orgId), getUserPermissions, tenantInbox)) ids.push(u.id);
    }
    // Stable order so the round-robin cursor is meaningful across calls.
    ids.sort();
    _cache.set(key, { ids, ts: Date.now() });
    return ids;
}

/**
 * @param {string} userId
 * @returns {Promise<string[]>}
 */
async function _userGroups(userId) {
    try {
        const u = await userStore.getUser(userId);
        if (!u) return [];
        if (Array.isArray(u.groups)) return u.groups;
        if (typeof u.groups === 'string') { try { return JSON.parse(u.groups || '[]'); } catch { return []; } }
    } catch (err) { bestEffort('services/supportAutoAssigner:_userGroups', err); /* ignore */ }
    return [];
}

/**
 * Return the next staff user id to assign for an org, advancing the cursor.
 * Returns null when no eligible staff exist.
 *
 * When the inbox is group-restricted (`sharedGroups` non-empty), candidates are
 * narrowed to members of those groups so a ticket is never auto-assigned to
 * someone who would then be denied access to it. Falls back to all eligible
 * staff if no group member is support-capable (a stranded ticket is worse than a
 * slightly out-of-policy assignment).
 *
 * @param {string | null} orgId
 * @param {{ sharedGroups?: string[], tenantInbox?: boolean }} [opts]
 */
async function pickNextAssignee(orgId, { sharedGroups = [], tenantInbox = false } = {}) {
    let candidates = await _eligibleStaffForOrg(orgId || null, { tenantInbox });
    if (!candidates.length) return null;
    if (Array.isArray(sharedGroups) && sharedGroups.length) {
        const inGroup = [];
        for (const id of candidates) {
            const g = await _userGroups(id);
            if (g.some(x => sharedGroups.includes(x))) inGroup.push(id);
        }
        if (inGroup.length) candidates = inGroup;
    }
    return supportStore.getAndAdvanceRoundRobin(orgId || null, candidates);
}

module.exports = { pickNextAssignee, _eligibleStaffForOrg, _isEligibleStaff };
