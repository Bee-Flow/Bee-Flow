// @typecheck
/**
 * establishSession — the single way an unauthenticated session becomes
 * authenticated. Rotates the session id (session-fixation defense: an
 * attacker who planted a pre-auth cookie must not end up sharing the
 * authenticated session), carries whitelisted pre-auth keys across the
 * rotation, writes the canonical authenticated shape, and persists — all
 * before the caller responds.
 *
 * Order inside: snapshot(preserve) → regenerate() → re-apply snapshot →
 * canonical {isAuthenticated: true, user, isAdmin} → extra → save().
 * Canonical writes happen AFTER the snapshot re-apply so a preserved key can
 * never mask them. Throws the raw store error on regenerate/save failure —
 * response policy (log-and-continue vs 500) stays at the call site.
 *
 * The OAuth callbacks depend on `preserve`: oauthPopup/oauthPickupId and the
 * provider token material are written to the session BEFORE authentication
 * and read AFTER it (popup/iframe pickup flow, utils/sessionToken.js). A
 * regenerate without preserving them silently dead-ends the embedded-iframe
 * login. See the per-site preserve lists at the call sites.
 *
 * `user` is stored as given — call sites intentionally use different shapes
 * (full user row, OCS object, minimal signup shape); do not normalize here.
 *
 * AUDITING (ISO A.8.15). Every established session writes one login_succeeded
 * row, from HERE rather than from the nine call sites. This function is the
 * definition of "an unauthenticated session became authenticated", so hooking
 * it means a login path added next year is audited before anyone remembers to
 * ask — and the worst a forgetful call site can produce is a row that says
 * `method: 'unknown'`, never silence. Pass `audit: { method, ... }` to say
 * which door was used. The write is best-effort and cannot throw; see
 * auth/loginAudit.js.
 */

/**
 * @param {import('express').Request} req
 * @param {object} opts
 * @param {object}   opts.user      Stored verbatim on req.session.user (required).
 * @param {boolean}  [opts.isAdmin] req.session.isAdmin (default false).
 * @param {string[]} [opts.preserve] Pre-auth session keys copied across the
 *                                   regeneration (only keys that are defined
 *                                   on the old session are re-applied).
 * @param {object}   [opts.extra]   Site-specific keys written verbatim after
 *                                   the canonical shape (explicit null is
 *                                   written, not skipped).
 * @param {object}   [opts.audit]   {method, organizationId, details} for the
 *                                  login_succeeded audit row. Omitted still
 *                                  writes a row, tagged method 'unknown'.
 */
async function establishSession(req, { user, isAdmin = false, preserve = [], extra = {}, audit = {} } = /** @type {any} */ ({})) {
    const old = req.session;
    if (!old || typeof old.regenerate !== 'function' || typeof old.save !== 'function') {
        throw new Error('establishSession requires req.session with regenerate()/save()');
    }
    const snapshot = {};
    for (const key of preserve) {
        if (old[key] !== undefined) snapshot[key] = old[key];
    }
    await new Promise((resolve, reject) => old.regenerate((err) => (err ? reject(err) : resolve())));
    // regenerate() replaced req.session with a fresh object — only touch
    // req.session from here on.
    Object.assign(req.session, snapshot);
    req.session.isAuthenticated = true;
    req.session.user = user;
    req.session.isAdmin = isAdmin;
    for (const [k, v] of Object.entries(extra)) req.session[k] = v;
    await new Promise((resolve, reject) => req.session.save((err) => (err ? reject(err) : resolve())));

    // After the save, never before: a session that failed to persist was not
    // established, and an audit trail that records sessions which never existed
    // is worse than one with a gap. Lazy-required to keep this module free of
    // the store's load order.
    await require('./loginAudit').auditLoginSuccess(req, {
        user,
        method: audit.method || 'unknown',
        organizationId: audit.organizationId || null,
        details: { isAdmin, ...(audit.details || {}) },
    });
}

/**
 * suppressSessionPersistence — make this request's session in-memory only.
 *
 * For header-authenticated request chains (connector JWT, x-session-token
 * bridge) the client re-authenticates on EVERY request and the connector
 * strips cookies in both directions, so a persisted session row can never
 * be read back: each save() is a write-only INSERT into user_sessions
 * (~15 per embedded page load) plus a regenerate round-trip. Downstream
 * middleware still sees a fully populated req.session for the lifetime of
 * the request; express-session's end-of-response save and touch become
 * callback-invoking no-ops.
 *
 * Never call this for cookie-session flows — those genuinely need the row.
 */
function suppressSessionPersistence(req) {
    const session = req?.session;
    if (!session) return;
    session.save = (cb) => { if (typeof cb === 'function') cb(); return session; };
    session.regenerate = (cb) => { if (typeof cb === 'function') cb(); return session; };
    session.touch = () => session;
}

module.exports = { establishSession, suppressSessionPersistence };
