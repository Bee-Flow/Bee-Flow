// @typecheck
'use strict';
/**
 * Which organisation is this request acting for, and which may it see.
 *
 * Four answers were in circulation and they disagreed with each other:
 * `resolveUserOrgIds` (the union, super-admin = null), `resolvePrimaryOrgId`
 * (the first of that union), `core/entitlements/limits.resolveOrgId` (the home
 * org only, no group fallback) and a private copy in the AI-config routes that
 * did fall back to a group. Each one did its own database read, so a route that
 * asked twice answered its own question twice, and a route that asked two of
 * them could act in one org while listing another.
 *
 *   const { orgId, orgIds, isSuperAdmin } = await orgScope(req);
 *
 * One read, and the distinctions that used to be spread over four files are
 * written down here as named fields:
 *
 *   orgIds       every org the caller may READ, or `null` for a super-admin —
 *                which every list query already reads as "no filter".
 *   orgId        the tenant being acted IN: the org on the account, else the
 *                first org a group grants. A super-admin gets their own org
 *                here rather than `null`, because they still act somewhere.
 *   homeOrgId    only the org on the account itself, ignoring groups.
 *   identityError  null when everything was really read; otherwise what could
 *                not be. A degraded read narrows every field, so without this a
 *                refusal looks like a policy decision when in fact nobody could
 *                check. Same reasoning as `resolveDatatablePrincipal`.
 *
 * The two older names are derivable, which is what makes their call sites
 * migratable one at a time:
 *   resolvePrimaryOrgId(req)  ==  isSuperAdmin ? null : orgId
 *   limits.resolveOrgId(req)  ==  isSuperAdmin ? null : homeOrgId
 *
 * No `core/http/errors` import on purpose: `auth/` is platform and `core/` is
 * not, and layering.test.js pins that edge count at its current value.
 *
 * A test that doubles the user store for one of the callers below must double
 * it for `'../stores/userStore'` as well — that is the spelling HERE, and a
 * stub keyed on the caller's spelling alone loads the real store in silence.
 */

const userStore = require('../stores/userStore');

// A fresh Set per call, never a shared constant: callers treat the result as
// theirs, and one that narrowed a shared Set would narrow it for everyone.
const anonymous = () => ({
    userId: null, isSuperAdmin: false, orgIds: new Set(),
    orgId: null, homeOrgId: null, identityError: null,
});

function groupIdsOf(user) {
    if (Array.isArray(user?.groups)) return user.groups;
    try { return JSON.parse(user?.groups || '[]'); } catch (_) { return []; }
}

/**
 * Resolve the caller's org scope. Never throws for a policy reason — an
 * anonymous request simply reaches no org.
 *
 * @param {import('express').Request} req
 * @param {{strict?: boolean}} [opts] `strict` rethrows a failed store read
 *   instead of degrading. Opt-in, because every existing caller reads a narrow
 *   answer as an answer; whoever uses the result as a decision key wants it on.
 */
async function orgScope(req, { strict = false } = {}) {
    const cached = req && req._orgScope;
    if (cached) return cached;

    const userId = req?.session?.user?.id || null;
    if (!userId) return anonymous();

    const isSuperAdmin = !!(req?.session?.isAdmin || req?.session?.user?.role === 'admin');

    let user = null;
    let identityError = null;
    try {
        user = await userStore.getUser(userId);
    } catch (e) {
        if (strict) throw e;
        identityError = `the account could not be read (${e && e.message})`;
    }

    // Truthiness, never a null check: createUser writes `organizationId || ''`,
    // so an org-less account holds the EMPTY STRING and would otherwise be
    // handed on as a real tenant key.
    const homeOrgId = user?.organizationId || null;

    const orgIds = new Set();
    if (homeOrgId) orgIds.add(homeOrgId);

    const groupIds = groupIdsOf(user);
    if (groupIds.length > 0) {
        try {
            const allGroups = (await userStore.getAllGroups()) || [];
            // Group order decides which org a member without a home org acts
            // in, so walk the member's list rather than the group table.
            for (const gid of groupIds) {
                const g = allGroups.find((x) => x && x.id === gid);
                if (g?.organizationId) orgIds.add(g.organizationId);
            }
        } catch (e) {
            if (strict) throw e;
            identityError = identityError || `the groups could not be read (${e && e.message})`;
        }
    }

    const scope = {
        userId,
        isSuperAdmin,
        // A super-admin sees everything, so there is no org filter to apply.
        orgIds: isSuperAdmin ? null : orgIds,
        orgId: homeOrgId || (orgIds.values().next().value ?? null),
        homeOrgId,
        identityError,
    };

    // Only a complete read is memoised: caching a degraded one would let the
    // first, lenient caller decide the answer for a later `strict` caller that
    // exists precisely to refuse it.
    if (req && !identityError) { try { req._orgScope = scope; } catch (_) { /* frozen req */ } }
    return scope;
}

/**
 * The same scope, but for a route that cannot do anything without an org.
 *
 * Throws a 403-shaped error the terminal handler turns into a worded response,
 * so the handler below it never has to repeat the "no organisation" branch.
 */
async function requireOrgScope(req, opts) {
    const scope = await orgScope(req, opts);
    if (!scope.orgId) {
        const err = new Error(scope.identityError
            ? 'Your organisation could not be determined. Please retry.'
            : 'This account does not belong to an organisation.');
        err.status = scope.identityError ? 503 : 403;
        err.code = scope.identityError ? 'org_scope_unavailable' : 'org_scope_required';
        err.expose = true;
        throw err;
    }
    return scope;
}

module.exports = { orgScope, requireOrgScope };
