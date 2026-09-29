/**
 * Who may do what with one routine (Studio → Automations handoff 5, sharing
 * and roles).
 *
 * Until now every automation route asked one question, `a.userId === me`, and
 * answered 403 to everybody else. A routine can now be shared with a person or
 * an organisation group in one of three roles, and this module is the ONE place
 * that turns "this caller, this routine" into a role:
 *
 *   owner  the person the routine belongs to. Steps run as them.
 *   edit   change steps and settings, activate, publish, pause. Not delete,
 *          not change who it is shared with, not hand it to someone else.
 *   view   read the steps and every run, read-only.
 *   run    start it (manual run, Test, an app button later) and see ONLY the
 *          runs they started themselves.
 *
 * Org admins holding `manage_automations` in the routine's organisation keep
 * full (owner-level) access; the answer says so (`via: 'admin'`).
 *
 * THREE RULES, each one a mistake that is easy to make:
 *
 *  1. THE OWNER PATH COSTS NOTHING. `a.userId === me` answers before any
 *     lookup, so the common case (your own routine) is exactly as cheap as the
 *     check it replaces, and a route test that never shares anything never
 *     reaches a store.
 *
 *  2. A SHARE NEVER CROSSES AN ORGANISATION. The caller's organisation is read
 *     fresh from `users` (never the session, which a moved user still carries)
 *     and must be the routine's (its stored organisation, else its owner's). A
 *     share row that names a person who has since left grants them nothing.
 *
 *  3. FAIL CLOSED. A lookup that throws is "no role", logged, never a guess.
 *
 * A lapsed `automation_sharing` licence does NOT revoke existing shares: the
 * licence gates making or widening a share (routes/automation/sharing.js),
 * the same drain exemption datatables use, so a licence lapse never locks a
 * colleague out of a routine they run every morning.
 *
 * Dependencies are injected (makeAutomationAccess) so tests hand in their own
 * store and user lookups; the module requires nothing at load time.
 */

'use strict';

const log = require('../telemetry/log');

const ROLES = Object.freeze(['run', 'view', 'edit']);
const RANK = Object.freeze({ run: 1, view: 2, edit: 3, owner: 4 });
const NEEDS = Object.freeze(['run', 'view', 'edit', 'owner']);

/** Does `role` include what `need` asks for? Unknown either way is no. */
function roleSatisfies(role, need) {
    if (!role || !need) return false;
    const have = RANK[role];
    const want = RANK[need];
    return typeof have === 'number' && typeof want === 'number' && have >= want;
}

/** The strongest of a list of share roles, or null. */
function strongestRole(roles) {
    let best = null;
    for (const r of roles || []) {
        if (!RANK[r]) continue;
        if (!best || RANK[r] > RANK[best]) best = r;
    }
    return best;
}

/** `users.groups` arrives as an array or as JSON text, depending on the reader. */
function groupsOf(user) {
    const g = user?.groups;
    if (Array.isArray(g)) return g.filter(x => typeof x === 'string');
    if (typeof g === 'string') {
        try {
            const parsed = JSON.parse(g || '[]');
            return Array.isArray(parsed) ? parsed.filter(x => typeof x === 'string') : [];
        } catch { return []; }
    }
    return [];
}

const NONE = Object.freeze({ role: null, via: null });

/**
 * @param {{
 *   store?: { listSharesForAutomation: (id: string) => Promise<Array<{principalType: string, principalId: string, role: string}>> },
 *   getUser?: (id: string) => Promise<any>,
 *   hasPermission?: (userId: string, permission: string, session?: any) => Promise<boolean>,
 * }} [overrides]
 */
function makeAutomationAccess(overrides = {}) {
    const store = () => overrides.store || require('../stores/automationStore');
    const getUser = overrides.getUser || ((id) => require('../stores/userStore').getUser(id));
    const hasPermission = overrides.hasPermission
        || ((id, perm, session) => require('../auth/permissions').hasPermission(id, perm, session));

    /** The organisation a routine belongs to: its own, else its owner's. */
    async function organisationOf(automation, ownerRow = undefined) {
        if (automation?.organizationId) return automation.organizationId;
        if (!automation?.userId) return null;
        const owner = ownerRow !== undefined ? ownerRow : await getUser(automation.userId).catch(() => null);
        return owner?.organizationId || null;
    }

    /**
     * The caller's role on a routine.
     *
     * @param {object|null} automation  a store row (rowToAutomation shape)
     * @param {string|null} userId
     * @param {{ session?: any }} [opts]
     * @returns {Promise<{ role: 'owner'|'edit'|'view'|'run'|null, via: 'owner'|'admin'|'share'|null }>}
     */
    async function roleFor(automation, userId, { session = null } = {}) {
        if (!automation || !userId) return NONE;
        if (automation.userId === userId) return { role: 'owner', via: 'owner' };
        try {
            const user = await getUser(userId);
            if (!user) return NONE;
            const orgId = await organisationOf(automation);
            if (!orgId || user.organizationId !== orgId) return NONE;
            // Checked, not inferred: the real groups and roles, the same
            // probe the org-wide run log uses (routes/automation/runs.js).
            const admin = await Promise.resolve(hasPermission(userId, 'manage_automations', session)).catch(() => false);
            if (admin) return { role: 'owner', via: 'admin' };
            const shares = await store().listSharesForAutomation(automation.id);
            const groups = new Set(groupsOf(user));
            const role = strongestRole((shares || [])
                .filter(s => (s.principalType === 'user' && s.principalId === userId)
                    || (s.principalType === 'group' && groups.has(s.principalId)))
                .map(s => s.role));
            return role ? { role, via: 'share' } : NONE;
        } catch (e) {
            log.warn(`[automation access] role lookup failed for ${automation.id} / ${userId}: ${e.message}`);
            return NONE;
        }
    }

    /** True when `user` may do what `need` asks on `automation`. */
    async function canAccessAutomation(automation, user, need, opts = {}) {
        const userId = typeof user === 'string' ? user : user?.id;
        const { role } = await roleFor(automation, userId, opts);
        return roleSatisfies(role, need);
    }

    /**
     * Route helper: the caller's access, or `null` after answering 403.
     *
     *   const access = await guard(req, res, a, 'edit'); if (!access) return;
     *
     * Writes the response itself rather than throwing, so handler-level tests
     * that resolve on res.json keep working. The body keeps the old
     * `{ error: 'Forbidden' }` and adds a code and the role that was needed.
     */
    async function guard(req, res, automation, need) {
        const userId = req?.session?.user?.id || null;
        const access = await roleFor(automation, userId, { session: req?.session || null });
        if (roleSatisfies(access.role, need)) return access;
        res.status(403).json({ error: 'Forbidden', code: 'automation_forbidden', need });
        return null;
    }

    /**
     * Route helper for a RUN: the caller's access to the routine behind it, or
     * `null` after answering 403.
     *
     *   'read'  view and up read every run; run-only reads the runs they started
     *   'act'   edit and up act on any run; run-only on the runs they started
     *   'edit'  edit and up only
     *
     * The person the run was made for (its owner at run time) keeps what they
     * always had, without a lookup: that was the whole rule before sharing.
     */
    async function runGuard(req, res, run, need) {
        const me = req.session.user.id;
        if (run.userId === me) return { role: 'owner', via: 'owner' };
        const a = await store().getAutomation(run.automationId).catch(() => null);
        const acc = a ? await roleFor(a, me, { session: req.session }) : NONE;
        const own = acc.role === 'run' && isOwnRun(run, me);
        const ok = need === 'edit' ? roleSatisfies(acc.role, 'edit')
            : need === 'act' ? (roleSatisfies(acc.role, 'edit') || own)
                : mayReadRun(run, acc, me);
        if (ok) return acc;
        res.status(403).json({ error: 'Forbidden', code: 'automation_forbidden', need: need === 'read' ? 'view' : 'edit' });
        return null;
    }

    return { roleFor, canAccessAutomation, guard, runGuard, organisationOf };
}

/**
 * The automation as THIS caller may see it, with their role on it.
 *
 *   myRole     'owner'|'edit'|'view'|'run' ('owner' for an org admin too)
 *   accessVia  'owner'|'admin'|'share'
 *
 * Anyone but the owner loses `builderSession` (the owner's own builder chat).
 * A run-only caller gets the TRIGGERS of the copy their run executes (the
 * live one when there is one: a run-only caller starts live runs) and nothing
 * else of the definition (`definitionRedacted: true`): enough to start it,
 * not the steps they were not given.
 */
function projectForViewer(automation, access) {
    if (!automation) return automation;
    const role = access?.role || null;
    const via = access?.via || null;
    const out = { ...automation, myRole: role, accessVia: via };
    if (via !== 'owner') out.builderSession = null;
    if (role === 'run') {
        const def = require('../core/automationRunner/definitionForRun')
            .definitionForRun(automation, { mode: 'live' }).definition || {};
        out.definition = {
            ...(def.trigger ? { trigger: def.trigger } : {}),
            ...(Array.isArray(def.triggers) ? { triggers: def.triggers } : {}),
        };
        out.definitionRedacted = true;
    }
    return out;
}

/** Did this person start the run (a button, a Test), or submit the form that did? */
function isOwnRun(run, userId) {
    return !!run && !!userId && (run.startedByUserId === userId || run.submittedByUserId === userId);
}

/**
 * May this caller read this run? `view` and up read every run of the routine;
 * `run` reads only their own runs (isOwnRun).
 */
function mayReadRun(run, access, userId) {
    if (!run || !access?.role) return false;
    if (roleSatisfies(access.role, 'view')) return true;
    return access.role === 'run' && isOwnRun(run, userId);
}

const defaultAccess = makeAutomationAccess();

module.exports = {
    ROLES,
    NEEDS,
    RANK,
    roleSatisfies,
    strongestRole,
    groupsOf,
    makeAutomationAccess,
    projectForViewer,
    mayReadRun,
    isOwnRun,
    canAccessAutomation: defaultAccess.canAccessAutomation,
    roleFor: defaultAccess.roleFor,
};
