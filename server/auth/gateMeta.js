// @typecheck
/**
 * Gate tagging — makes an authorization middleware say what it enforces.
 *
 * The problem: `requirePermission('manage_users')` (permissions.js:609) returns
 * a bare anonymous async arrow. Walking Express's router stack recovers the
 * FUNCTION but not the permission id it closed over, so a route table reads
 * `USE:anonymous` and tells you nothing — see the frozen baseline in
 * routes/automation.routetable.test.js, which literally records those as
 * "USE:anonymous". Across the app there are ~479 such anonymous chain slots.
 *
 * The fix: tag the returned closure with what it requires. The tag is a
 * `Symbol.for` property defined non-enumerable, so it is invisible to
 * JSON.stringify, Object.keys, spread and every existing consumer — a gate's
 * runtime behaviour is untouched. Nothing reads these tags at request time;
 * they exist so `auth/routeWalk.cli.js` can build an honest route→requirement
 * table and `auth/accessRegistry.drift.test.js` can hold it to the real stack.
 *
 * Axes (they AND together at runtime — see auth/effectiveAccess.js):
 *   auth       — a valid session for an existing, active user
 *   rbac       — a SYSTEM_PERMISSIONS id
 *   scope      — org membership / org-admin over some parameter
 *   license    — a licence tier or feature
 *   capability — an entitlement (plan ceiling ∩ org/group grant)
 *   orgStatus  — the org must not be suspended/archived
 */

const GATE = Symbol.for('bf.gate');

/**
 * Attach gate metadata to a middleware. Returns the same function, so this
 * wraps a `return fn` with no other change:
 *
 *   return tagGate(async (req, res, next) => { ... }, { axis: 'rbac', anyOf: [id, 'all'] });
 */
function tagGate(fn, meta) {
    if (typeof fn !== 'function') return fn;
    Object.defineProperty(fn, GATE, {
        value: Object.freeze({ ...meta }),
        enumerable: false,
        configurable: true,
        writable: false,
    });
    return fn;
}

/** The gate metadata on a middleware, or null if it carries none. */
function readGate(fn) {
    return (fn && fn[GATE]) || null;
}

/**
 * For mount sites that defer the factory call to request time:
 *
 *   app.use('/x', (req, res, next) => require('./y').requireCapability('z')(req, res, next))
 *
 * Tagging the factory does not help there — the arrow at the mount site is what
 * the walk sees, and it carries no tag. `lazyGate` keeps the deferral (which
 * exists to dodge a require cycle) while making the mount self-describing:
 *
 *   app.use('/x', lazyGate(() => require('./y').requireCapability('z'), { axis: 'capability', id: 'z' }))
 */
function lazyGate(thunk, meta) {
    const mw = (req, res, next) => thunk()(req, res, next);
    return tagGate(mw, meta);
}

module.exports = { GATE, tagGate, readGate, lazyGate };
