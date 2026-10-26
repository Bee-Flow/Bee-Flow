// @typecheck strict
/**
 * Who is asking, in the shape `kbVisibility.filterKbIdsForUser` needs.
 *
 * The retrieval surfaces run OUTSIDE a request — inside a stream, a tool
 * round, a background responder — so `auth.resolveUserOrgIds`, which is
 * request-shaped, is not available. Every one of them needs the same two
 * facts about the same person, and each resolving them its own way is how
 * one of them ends up passing `null` for orgIds, which
 * `canUserAccessKB` reads as super-admin.
 *
 * So: one resolver, always a Set, and a failure that NARROWS.
 */

const log = require('../../telemetry/log');

/**
 * `{ orgIds: Set, userGroups: string[] }` for a user id. Never throws.
 * @param {string | null | undefined} userId
 */
async function askerContext(userId) {
    if (!userId) return { orgIds: new Set(), userGroups: [] };
    let orgIds = new Set();
    let userGroups = [];
    try {
        const { resolveUserGroups } = require('../../auth/audience');
        const g = await resolveUserGroups(userId);
        userGroups = Array.isArray(g) ? g : [];
    } catch (_) {
        userGroups = [];
    }
    try {
        const userStore = require('../../stores/userStore');
        const user = await userStore.getUser(userId);
        const ids = [];
        if (user?.organizationId) ids.push(user.organizationId);
        /**
         * ── ONE ORG RESOLUTION, TWO SIDES OF THE SAME QUESTION ─────────
         * Here stood `user.organizationIds`, a field that does not exist anywhere in
         * stores/ (`getUser` is `SELECT *` on users; the columns are organizationId and
         * groups), so that branch always yielded nothing. The READ path that lets the user
         * open the note or the knowledge base at all is `auth.resolveUserOrgIds`, and that
         * DOES add every org that follows from the GROUPS of the user.
         *
         * As long as the two diverged, this side refused legitimate writers: someone with
         * `users.organizationId = ''` who reached org X only via a group could open a published
         * meeting of org X, but got a `transcription_not_visible` on "file this line", a 400 on
         * a meeting that was on his screen at that moment. Narrowing, so no leak, but a broken
         * function for a real population.
         *
         * Deliberately NOT a copy of `resolveUserOrgIds`: that gives `null` for a super-admin
         * ("no filter"), and `null` reads `canUserAccessKB` as full access. Here it stays
         * always a Set, so a super-admin on this path just gets his own orgs, and that is the
         * side that narrows.
         */
        let groupIds = userGroups;
        if (!groupIds.length) {
            if (Array.isArray(user?.groups)) groupIds = user.groups;
            else if (typeof user?.groups === 'string') {
                try { groupIds = JSON.parse(user.groups || '[]'); } catch (_) { groupIds = []; }
            }
        }
        /**
         * ── THE GROUP EXPANSION HAS ITS OWN SAFETY NET ────────────────
         * This lookup is ADDITIVE: it adds orgs that the user reaches via a group. If it
         * fails, the correct outcome is "the orgs I know for certain", not "no org at all".
         *
         * Without this separate catch the whole resolution fell back to an empty Set as soon as
         * `getAllGroups` failed, including the `organizationId` that had already been read from the
         * user just fine. That cost a logged-in org member his own organisation's knowledge bases
         * because of a database hiccup in a lookup that had nothing to do with it, and it is exactly
         * how this change, on arrival, turned two tests in the visibility layer red: a stub without
         * `getAllGroups`.
         *
         * Narrowing remains the rule: the outer catch below still does that for a failed USER read,
         * where we really know nothing. The difference is that a partial failure now costs a part.
         */
        if (Array.isArray(groupIds) && groupIds.length) {
            try {
                const allGroups = typeof userStore.getAllGroups === 'function'
                    ? await userStore.getAllGroups()
                    : [];
                for (const gid of groupIds) {
                    const group = (allGroups || []).find((g) => g.id === gid);
                    if (group?.organizationId) ids.push(group.organizationId);
                }
            } catch (e) {
                log.warn('[askerContext] kon de groepen niet uitbreiden naar organisaties:', e.message);
            }
        }
        orgIds = new Set(ids.filter(Boolean));
    } catch (_) {
        // A failed resolve must narrow, never widen: an empty Set drops
        // everything org-scoped, which is the safe direction.
        orgIds = new Set();
    }
    return { orgIds, userGroups };
}

module.exports = { askerContext };
