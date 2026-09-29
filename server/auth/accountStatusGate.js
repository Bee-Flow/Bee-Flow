// @typecheck
/**
 * "May this account start a session at all?" — one answer, for every way in.
 *
 * WHY THIS FILE EXISTS
 * The status column already decided who may sign in, but only one of the four
 * login-completion paths ever asked. `login/finalizeLogin.js` (password, and
 * MFA through it) blocked `unverified`, `waitlist` and `pending`. The OPAQUE
 * finish, the OAuth/SSO callback and the Nextcloud legacy callback each built
 * a session without reading `status` at all — and none of the four blocked
 * `suspended`, on any path.
 *
 * So suspending an account did not end its access. An admin could set
 * `status='suspended'` from the user screen, watch the row change, and the
 * person could still sign in. `auth/admin/orgAdminGuards.js` even stated the
 * opposite in a comment ("suspended accounts are refused too"), which is the
 * worst kind of wrong: it reads like the check exists and stops the next
 * person from looking for it.
 *
 * The fix is one predicate in one file, because four copies of an
 * access-control rule is how three of them end up out of date.
 *
 * ── WHY `suspended` HAS NO EXEMPTION ─────────────────────────────────
 * The other blocked statuses carry exemptions: an org founder skips approval
 * (`canSkipApproval`), and some admins skip email verification. Those exist
 * because waitlist/pending/unverified are states on the way IN — they gate a
 * person who is not set up yet, and the founder of an org has nobody above
 * them to do the approving.
 *
 * `suspended` is the opposite: it is a state applied ON PURPOSE to someone who
 * already had access, by someone who decided they should stop having it. An
 * exemption there would mean "you can suspend anyone except the people most
 * worth suspending". So this gate takes no isAdmin, no isOwner, and no
 * override argument — there is nothing to pass that could weaken it.
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
 * Statuses that must never reach a session, whoever the caller is.
 *
 * A Set rather than a comparison so a second value (say `deactivated`, or
 * `offboarded`) is one line and lands on all four paths at once.
 */
const HARD_BLOCKED_STATUSES = new Set(['suspended']);

/**
 * Does this stored user row hold a status that forbids signing in?
 *
 * Takes the ROW, not the status string, so a caller cannot accidentally pass
 * the session user (which does not carry `status` on every path) and get a
 * cheerful `false`. A row without a status predates the column and is active —
 * the same reading `orgAdminGuards.isActiveUserStatus` uses.
 *
 * @param {object|null|undefined} storedUser row from userStore
 * @returns {boolean} true when the account must be refused
 */
function isLoginBlockedAccount(storedUser) {
    if (!storedUser || typeof storedUser !== 'object') return false;
    return HARD_BLOCKED_STATUSES.has(storedUser.status);
}

/**
 * The single refusal shape, so the four paths cannot answer differently.
 *
 * Deliberately the SAME body as a wrong password ("Invalid credentials", 401).
 * A distinct "your account is suspended" message would confirm to anyone
 * holding a working password that the account exists and was singled out; the
 * person themselves learns it from whoever suspended them, not from a login
 * form. No session is written, and nothing is preserved from the pre-auth
 * session.
 */
const REFUSAL = Object.freeze({ status: 401, body: Object.freeze({ error: 'Invalid credentials' }) });

module.exports = { HARD_BLOCKED_STATUSES, isLoginBlockedAccount, REFUSAL };
