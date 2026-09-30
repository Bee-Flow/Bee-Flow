import { translate } from '@/core/i18n';

import {
    editableRows,
    fixedPermissions,
    holdersOf,
    isAdminRole,
    memberCountLabel,
    orderedRoleIds,
    permissionCopy,
    permissionsForRole,
    roleChoice,
    roleCopy,
    roleOptions,
    sameSet,
    withSavedRole,
} from './roles';

const mapping = [
    { id: 'member', permissions: ['member', 'use_apps', 'use_notebooks'] },
    { id: 'custom_role', permissions: [] },
    { id: 'org_admin', permissions: ['org_admin', 'manage_users', 'use_notebooks', 'zzz_new', 'use_notebooks'] },
];

describe('role order and copy', () => {
    it('lists the server’s roles in the web’s order, unknown ones last', () => {
        expect(orderedRoleIds(mapping)).toEqual(['org_admin', 'member', 'custom_role']);
        expect(roleOptions(mapping)[0]).toBe('user');
    });

    it('falls back to the shipped six when the server named none', () => {
        expect(orderedRoleIds([])).toEqual(['org_admin', 'dpo', 'isms_auditor', 'agent_admin', 'agent_editor', 'member']);
    });

    it('names known roles and humanises the rest', () => {
        expect(roleCopy('dpo', translate).name).toBe('Data Protection Officer');
        expect(roleCopy('user', translate).name).toBe('User');
        expect(roleCopy('custom_role', translate)).toEqual({ name: 'Custom role', description: '' });
        expect(permissionCopy('use_notebooks', translate).label).toBe('Notebooks');
        expect(permissionCopy('zzz_new', translate).label).toBe('Zzz new');
    });
});

describe('what a role grants', () => {
    it('drops role markers, dedupes, and keeps unknown ids at the end', () => {
        expect(permissionsForRole('org_admin', mapping)).toEqual(['use_notebooks', 'manage_users', 'zzz_new']);
    });

    it('splits the editable switches from the fixed rest', () => {
        const editable = ['use_notebooks', 'use_apps'];
        expect(editableRows('member', mapping, editable)).toEqual([
            { id: 'use_apps', granted: true },
            { id: 'use_notebooks', granted: true },
        ]);
        expect(fixedPermissions('org_admin', mapping, editable, true)).toEqual(['manage_users', 'zzz_new']);
        expect(fixedPermissions('org_admin', mapping, editable, false)).toContain('use_notebooks');
    });

    it('splices a save back in, keeping the fixed half', () => {
        const next = withSavedRole(mapping, 'org_admin', ['use_notebooks'], []);
        expect(next.find((r) => r.id === 'org_admin')?.permissions).toEqual(['org_admin', 'manage_users', 'zzz_new']);
        expect(next.find((r) => r.id === 'member')).toBe(mapping[0]);
    });

    it('counts holders, ignoring the system account', () => {
        expect(holdersOf('dpo', [{ orgRole: 'dpo' }, { orgRole: 'dpo', isSystem: true }, { orgRole: 'member' }])).toBe(1);
    });

    it('compares grant sets regardless of order', () => {
        expect(sameSet(['a', 'b'], ['b', 'a'])).toBe(true);
        expect(sameSet(['a'], ['a', 'b'])).toBe(false);
    });
});

describe('confirming and counting', () => {
    it('treats the *_admin roles as the ones to confirm', () => {
        expect(isAdminRole('org_admin')).toBe(true);
        expect(isAdminRole('agent_admin')).toBe(true);
        expect(isAdminRole('member')).toBe(false);
        expect(isAdminRole('dpo')).toBe(false);
        expect(isAdminRole('')).toBe(false);
    });

    it('counts members in one voice', () => {
        expect(memberCountLabel(1, translate)).toBe('1 member');
        expect(memberCountLabel(0, translate)).toBe('0 members');
        expect(memberCountLabel(3, translate)).toBe('3 members');
    });

    it('offers a role with what it is for', () => {
        expect(roleChoice('org_admin', translate)).toMatchObject({ id: 'org_admin', label: 'Organisation Admin' });
        expect(roleChoice('org_admin', translate).description).not.toBe('');
    });
});
