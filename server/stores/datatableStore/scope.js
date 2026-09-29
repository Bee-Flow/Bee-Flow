// @typecheck
'use strict';

/**
 * The tenancy address.
 *
 * Every row this store owns carries `(scope_kind, scope_id)`: `('org', <orgId>)`
 * for a table the organisation owns, `('user', <userId>)` for a personal one.
 * This module is that vocabulary and nothing else — the two kinds, how to build
 * an address, how to refuse a malformed one, and the org id a scope implies.
 * It touches no database, so every other module here may depend on it.
 */

/** The two tenancy kinds. Anything else is a caller bug, not a new feature. */
const SCOPE_KINDS = Object.freeze(['org', 'user']);

/** A table the ORGANISATION owns. */
function orgScope(organizationId) {
    return { kind: 'org', id: organizationId };
}

/**
 * A PERSONAL table: one account, nobody else, not even an org admin. The
 * privacy rule is enforced in auth/datatableAccess.gradeForPrincipal — this is
 * only the address.
 */
function userScope(userId) {
    return { kind: 'user', id: userId };
}

/**
 * Refuse a malformed scope loudly. A missing or half-built scope must never
 * reach a WHERE clause: `scope_id = undefined` binds as NULL, matches nothing,
 * and reads as "this tenant has no tables" rather than as the bug it is.
 */
function assertScope(scope, who) {
    if (!scope || !SCOPE_KINDS.includes(scope.kind) || !scope.id) {
        throw new Error(`${who} requires a {kind:'org'|'user', id} scope`);
    }
    return scope;
}

/** The org id a scope implies — NULL for a personal table, and never guessed. */
function orgIdOf(scope) {
    return scope.kind === 'org' ? scope.id : null;
}

module.exports = {
    SCOPE_KINDS,
    orgScope,
    userScope,
    assertScope,
    orgIdOf,
};
