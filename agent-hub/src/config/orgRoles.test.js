// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { ORG_ROLES, PERMISSION_CATALOG, permissionsForRole, editablePermissionsForRole } from './orgRoles';

/**
 * The Organisation Roles screen answers "who in my organisation can use this",
 * and it used to answer from a hand-written list that had drifted from the
 * server's own config. It now renders the real mapping through these helpers,
 * so what they drop and what they keep is the whole correctness question.
 */

// The shape GET /auth/org-roles returns.
const MAPPING = [
    { id: 'org_admin', permissions: ['org_admin', 'manage_users', 'manage_agents', 'use_approvals'] },
    { id: 'member', permissions: ['member', 'use_approvals', 'use_apps', 'use_forms'] },
    { id: 'dpo', permissions: ['dpo', 'admin_compliance'] },
];

describe('permissionsForRole', () => {
    it('turns permission ids into the copy the screen shows', () => {
        const perms = permissionsForRole('member', MAPPING);
        expect(perms.map((p) => p.id)).toEqual(['use_apps', 'use_approvals', 'use_forms']);
        expect(perms.find((p) => p.id === 'use_forms').label).toBe('Forms');
        expect(perms.every((p) => p.desc.length > 0)).toBe(true);
    });

    it('drops the role marker — the row already says which role it is', () => {
        expect(permissionsForRole('org_admin', MAPPING).map((p) => p.id)).not.toContain('org_admin');
        expect(permissionsForRole('dpo', MAPPING).map((p) => p.id)).toEqual(['admin_compliance']);
    });

    it('orders every role by the catalog, so two roles can be read side by side', () => {
        const order = Object.keys(PERMISSION_CATALOG);
        const ids = permissionsForRole('org_admin', MAPPING).map((p) => p.id);
        const positions = ids.map((id) => order.indexOf(id));
        expect(positions).toEqual([...positions].sort((a, b) => a - b));
    });

    it('shows a permission it has no copy for rather than hiding it', () => {
        // Hiding what it did not recognise is exactly how the old hand-written
        // list came to under-report what a role could do.
        const perms = permissionsForRole('x', [{ id: 'x', permissions: ['brand_new_thing'] }]);
        expect(perms).toEqual([{ id: 'brand_new_thing', label: 'Brand New Thing', desc: '' }]);
    });

    it('returns nothing for an unknown role or a mapping that never arrived', () => {
        expect(permissionsForRole('org_admin', [])).toEqual([]);
        expect(permissionsForRole('org_admin', null)).toEqual([]);
        expect(permissionsForRole('nope', MAPPING)).toEqual([]);
    });
});

describe('editablePermissionsForRole', () => {
    const EDITABLE = ['use_notebooks', 'use_apps', 'manage_agents'];

    it('offers every editable permission with whether the role has it', () => {
        const rows = editablePermissionsForRole('member', MAPPING, EDITABLE);
        expect(rows.map((r) => [r.id, r.granted])).toEqual([
            ['manage_agents', false],
            ['use_apps', true],
            ['use_notebooks', false],
        ]);
    });

    it('offers only what the SERVER says is editable', () => {
        // The list is not kept here on purpose — a toggle the PUT would drop
        // is a control that reverts on save.
        const rows = editablePermissionsForRole('org_admin', MAPPING, ['use_notebooks']);
        expect(rows.map((r) => r.id)).toEqual(['use_notebooks']);
        expect(editablePermissionsForRole('org_admin', MAPPING, [])).toEqual([]);
        expect(editablePermissionsForRole('org_admin', MAPPING, undefined)).toEqual([]);
    });

    it('orders the editor the same way the chips above it are ordered', () => {
        const order = Object.keys(PERMISSION_CATALOG);
        const ids = editablePermissionsForRole('member', MAPPING, EDITABLE).map((r) => r.id);
        const positions = ids.map((id) => order.indexOf(id));
        expect(positions).toEqual([...positions].sort((a, b) => a - b));
    });

    it('still offers a permission it has no copy for', () => {
        const rows = editablePermissionsForRole('member', MAPPING, ['brand_new_thing']);
        expect(rows).toEqual([{ id: 'brand_new_thing', label: 'Brand New Thing', desc: '', granted: false }]);
    });
});

describe('ORG_ROLES', () => {
    it('describes each role without claiming what it grants', () => {
        // The grant lives in server/config/orgRoles.json. A `permissions` key
        // here is a second source of truth, and it drifted last time.
        for (const role of ORG_ROLES) {
            expect(role.permissions).toBeUndefined();
            expect(role.id && role.name && role.description && role.color).toBeTruthy();
        }
    });
});
