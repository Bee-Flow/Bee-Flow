// @typecheck strict
/**
 * "May this account start a session at all?" — one answer, for every way in.
 *
 * WHY THIS FILE EXISTS
 * The status column decides who may sign in, and every path that completes a
 * sign-in asks the same predicate here: `login/finalizeLogin.js` (password,
 * and MFA through it), the OPAQUE finish and `login/finalizeOpaqueLogin.js`
 * (after a second factor), the OAuth/SSO callback, the Nextcloud legacy
 * callback and the Nextcloud connector's token exchange
 * (`connectorJwtPhases.js`). `permissionsRequireAuth.js` asks it again on
 * every request, so a session that is already running ends on its next
 * request once the account's status forbids one.
 *
 * One predicate in one file: a copy per path is a rule that drifts.
 * `accountStatusGate.paths.test.js` holds the list of paths to the tree.
 *
 * ── THE STATUSES THAT CANNOT SIGN IN ─────────────────────────────────
 *   `suspended`  set by an administrator on the user screen: this person
 *                stops having access.
 *   `inactive`   set by the Nextcloud user sync (services/ncUserGroupSync.js)
 *                when the account is removed from Nextcloud, is disabled
 *                there, or falls outside the organisation's sync selection.
 *                The sync sets it back to `active` when Nextcloud reports the
 *                account as enabled and the selection admits it again, and
 *                the account can then sign in as before; an administrator
 *                can do the same on the user screen.
 *
 * Adding a status is one entry in HARD_BLOCKED_STATUSES below. It then holds
 * on every path above and for running sessions.
 *
 * ── WHY THESE HAVE NO EXEMPTION ──────────────────────────────────────
 * The other blocked statuses carry exemptions: an org founder skips approval
 * (`canSkipApproval`), and some admins skip email verification. Those exist
 * because waitlist/pending/unverified are states on the way IN — they gate a
 * person who is not set up yet, and the founder of an org has nobody above
 * them to do the approving.
 *
 * `suspended` and `inactive` are the opposite: a state applied to someone who
 * already had access, by an administrator or by the directory the
 * organisation chose to follow. An exemption there would mean "access ends
 * for anyone except the accounts with the most of it". So this gate takes no
 * isAdmin, no isOwner, and no override argument — there is nothing to pass
 * that could weaken it.
 *
 * ── WHAT IT DELIBERATELY DOES NOT DO ─────────────────────────────────
 * It does not add unverified/waitlist/pending to the OAuth and OPAQUE paths.
 * Those paths let such an account through today, and finalizeLogin gives it a
 * restricted `pendingApproval` session instead — a real inconsistency, but a
 * behaviour change for SSO-provisioned users that belongs in its own change
 * with its own test. Recorded here so it is not mistaken for an oversight.
 */

'use strict';

/**
 * Statuses that must never reach a session, whoever the caller is (the header
 * says who sets each).
 *
 * A Set rather than a comparison so another value is one line and lands on
 * every path at once.
 */
const HARD_BLOCKED_STATUSES = new Set(['suspended', 'inactive']);

/**
 * Does this stored user row hold a status that forbids signing in?
 *
 * Takes the ROW, not the status string, so a caller cannot accidentally pass
 * the session user (which does not carry `status` on every path) and get a
 * cheerful `false`. A row without a status predates the column and is active —
 * the same reading `orgAdminGuards.isActiveUserStatus` uses.
 *
 * @param {any|null|undefined} storedUser row from userStore
 * @returns {boolean} true when the account must be refused
 */
function isLoginBlockedAccount(storedUser) {
    if (!storedUser || typeof storedUser !== 'object') return false;
    return HARD_BLOCKED_STATUSES.has(storedUser.status);
}

/**
 * Is this account allowed to keep USING an already-issued credential?
 *
 * The login gate above asks "may it start a session"; a static bearer token
 * (the MCP access tokens) never goes through a login, so the same account
 * state has to be asked on every request. Stricter than the login gate on
 * purpose: a credential that works without a login is only honoured for an
 * account that is plainly active. No status (a row from before the column) is
 * active; a missing row is not an account at all.
 *
 * @param {any|null|undefined} storedUser row from userStore
 * @returns {boolean} true when the credential may still be used
 */
function isActiveAccount(storedUser) {
    if (!storedUser || typeof storedUser !== 'object') return false;
    return !storedUser.status || storedUser.status === 'active';
}

/**
 * Is this account still waiting to be let in?
 *
 * A sign-in for such an account gets a session with `pendingApproval` on it
 * (login/finalizeLogin.js) and the client shows the waiting screen. The
 * session alone is not the gate — an org founder is let past approval and
 * never gets the flag — so the question is asked of the stored row, and the
 * flag says whether the sign-in path decided this account is held.
 *
 * @param {any|null|undefined} storedUser row from userStore
 */
function isAwaitingApproval(storedUser) {
    if (!storedUser || typeof storedUser !== 'object') return false;
    return storedUser.status === 'pending' || storedUser.status === 'waitlist';
}

/**
 * Is this account held at the approval step right now? Awaiting approval and
 * not exempt from it: a system admin or an org admin has nobody above them to
 * approve (signupGuards.canSkipApproval, the rule every sign-in path uses).
 * Asked of the stored row on every request, so a sign-in path that forgot the
 * session flag still cannot open the API.
 *
 * @param {any|null|undefined} storedUser row from userStore
 */
function isHeldForApproval(storedUser) {
    if (!isAwaitingApproval(storedUser)) return false;
    return storedUser.role !== 'admin' && storedUser.orgRole !== 'org_admin';
}

/**
 * What a held session may still call: the waiting screen reads who it is,
 * what it may do (nothing yet) and the sign-out. Everything else answers the
 * refusal below until an administrator approves the account.
 */
const PENDING_APPROVAL_ALLOWED_PATHS = Object.freeze(new Set([
    '/auth/user',
    '/auth/my-permissions',
    '/auth/logout',
    '/auth/setup-status',
]));

/** @param {{ originalUrl?: string, url?: string }} req */
function allowedWhilePendingApproval(req) {
    const path = String(req.originalUrl || req.url || '').split('?')[0];
    return PENDING_APPROVAL_ALLOWED_PATHS.has(path);
}

const PENDING_REFUSAL = Object.freeze({
    status: 403,
    body: Object.freeze({ error: 'Account is pending admin approval', code: 'pending_approval' }),
});

/**
 * The single refusal shape, so the paths cannot answer differently, and the
 * same for every blocked status.
 *
 * Deliberately the SAME body as a wrong password ("Invalid credentials", 401).
 * A message that names the status would confirm to anyone holding a working
 * password that the account exists and what state it is in; the person
 * themselves learns it from their administrator, not from a login form. No
 * session is written, and nothing is preserved from the pre-auth session.
 */
const REFUSAL = Object.freeze({ status: 401, body: Object.freeze({ error: 'Invalid credentials' }) });

module.exports = {
    HARD_BLOCKED_STATUSES, isLoginBlockedAccount, isActiveAccount, REFUSAL,
    isAwaitingApproval, isHeldForApproval, PENDING_APPROVAL_ALLOWED_PATHS, allowedWhilePendingApproval, PENDING_REFUSAL,
};
