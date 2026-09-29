const test = require('node:test');
const assert = require('node:assert');

const {
    EDITABLE_PERMISSIONS, isEditablePermission, sanitizePermissions, mergeRolePermissions,
} = require('./orgRolePolicy');

/*
 * The merge rule is the whole correctness question: an organisation gets to
 * reshape the "may this person USE this" half of a role and nothing else, and
 * a role it has said nothing about must resolve byte-identically to the
 * shipped default — otherwise upgrading this build silently redefines every
 * role on every install.
 */

const DEFAULTS = {
    org_admin: ['org_admin', 'manage_users', 'admin_security', 'manage_agents', 'use_notebooks'],
    // page_chat is deliberately NOT editable — it is what proves the merge
    // keeps the half of a role an organisation was never offered.
    member: ['page_chat', 'use_datatables', 'use_approvals', 'use_notebooks'],
    dpo: ['dpo', 'admin_compliance', 'use_forms'],
};

test('the editable set is exactly the use-a-feature permissions', () => {
    // Nothing that raises privileges over the organisation or its tenants may
    // be in here — that is what lets an org admin edit these without the
    // "cannot assign permissions you don't have" ladder groups need.
    for (const id of EDITABLE_PERMISSIONS) {
        assert.ok(!id.startsWith('admin_'), `${id} is an admin page`);
        assert.ok(!['all', 'manage_users', 'org_admin', 'support_inbox',
            'modify_n8n_workflows', 'use_n8n_tools', 'page_settings'].includes(id), `${id} must not be editable`);
    }
    assert.ok(isEditablePermission('use_notebooks'));
    assert.ok(!isEditablePermission('manage_users'));
    assert.ok(!isEditablePermission('all'));
});

test('sanitize drops anything the org may not set, and dedupes', () => {
    assert.deepStrictEqual(
        sanitizePermissions(['use_notebooks', 'all', 'manage_users', 'use_notebooks', 'nonsense', 42, null]),
        ['use_notebooks'],
    );
    assert.deepStrictEqual(sanitizePermissions([]), []);
    assert.deepStrictEqual(sanitizePermissions(null), []);
    assert.deepStrictEqual(sanitizePermissions('use_notebooks'), [], 'a bare string is not a list');
});

test('sanitize returns a canonical order, not click order', () => {
    const a = sanitizePermissions(['use_notebooks', 'manage_agents']);
    const b = sanitizePermissions(['manage_agents', 'use_notebooks']);
    assert.deepStrictEqual(a, b);
});

test('a role with no override keeps the shipped default exactly', () => {
    const merged = mergeRolePermissions(DEFAULTS, {});
    assert.deepStrictEqual(merged, DEFAULTS);
    assert.deepStrictEqual(mergeRolePermissions(DEFAULTS, null), DEFAULTS);
});

test('an override replaces every editable permission and keeps the rest', () => {
    const merged = mergeRolePermissions(DEFAULTS, { member: ['use_forms'] });
    // Datatables, Approvals and Notebooks were all editable and are gone; the
    // org asked for Forms instead. page_chat is not editable, so it survived —
    // that is the "an org cannot take away what it was not offered" half.
    assert.deepStrictEqual(merged.member, ['page_chat', 'use_forms']);
    // Untouched roles are untouched.
    assert.deepStrictEqual(merged.org_admin, DEFAULTS.org_admin);
    assert.deepStrictEqual(merged.dpo, DEFAULTS.dpo);
});

test('an empty override means "none of them", not "no opinion"', () => {
    // The difference the whole feature turns on: a role the admin cleared must
    // come back empty, not fall back to the default it was cleared from.
    const merged = mergeRolePermissions(DEFAULTS, { member: [] });
    assert.deepStrictEqual(merged.member, ['page_chat']);
});

test('an override can never smuggle in a permission the org may not set', () => {
    const merged = mergeRolePermissions(DEFAULTS, { member: ['all', 'manage_users', 'admin_security'] });
    assert.deepStrictEqual(merged.member, ['page_chat']);
});

test('an override for a role the install does not ship is ignored', () => {
    // Roles come from config/orgRoles.json. A stale blob naming a role that
    // was since removed must not resurrect it as a grantable thing.
    const merged = mergeRolePermissions(DEFAULTS, { wizard: ['use_notebooks'] });
    assert.ok(!('wizard' in merged));
});
