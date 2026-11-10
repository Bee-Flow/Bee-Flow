import { describe, expect, it } from 'vitest';
import { homeOrgIdOf, isHomeOrgAdmin, isOrgAdminRole, isPlatformAdmin, mayManageAccount } from './adminAccess';

describe('isPlatformAdmin', () => {
    it('is the session flag or the global role admin', () => {
        expect(isPlatformAdmin({ isAdmin: true })).toBe(true);
        expect(isPlatformAdmin({ role: 'admin' })).toBe(true);
    });

    it('is not an organisation admin, a plain user, or nobody', () => {
        expect(isPlatformAdmin({ orgRole: 'org_admin' })).toBe(false);
        expect(isPlatformAdmin({ role: 'user', isAdmin: false })).toBe(false);
        expect(isPlatformAdmin(null)).toBe(false);
        expect(isPlatformAdmin(undefined)).toBe(false);
    });

    it('does not count the all permission', () => {
        expect(isPlatformAdmin({ permissions: ['all'] } as { isAdmin?: boolean })).toBe(false);
    });
});

describe('isOrgAdminRole', () => {
    it('accepts the current and the legacy admin role only', () => {
        expect(isOrgAdminRole('org_admin')).toBe(true);
        expect(isOrgAdminRole('admin')).toBe(true);
        expect(isOrgAdminRole('member')).toBe(false);
        expect(isOrgAdminRole('agent_admin')).toBe(false);
        expect(isOrgAdminRole(null)).toBe(false);
        expect(isOrgAdminRole(undefined)).toBe(false);
    });
});

describe('homeOrgIdOf', () => {
    it('reads organizationId, then orgId, and ignores empty or non-string values', () => {
        expect(homeOrgIdOf({ organizationId: 'o1' })).toBe('o1');
        expect(homeOrgIdOf({ orgId: 'o2' })).toBe('o2');
        expect(homeOrgIdOf({ organizationId: '' })).toBeNull();
        expect(homeOrgIdOf({ organizationId: 5 })).toBeNull();
        expect(homeOrgIdOf(null)).toBeNull();
    });
});

describe('mayManageAccount', () => {
    it('lets anyone but a platform admin manage the accounts whose home is their own organisation', () => {
        expect(mayManageAccount({ role: 'user', organizationId: 'o1' }, false, 'o1')).toBe(true);
        expect(mayManageAccount({ organizationId: 'o2' }, false, 'o1')).toBe(false);
        expect(mayManageAccount({ organizationId: null }, false, 'o1')).toBe(false);
        expect(mayManageAccount({}, false, null)).toBe(false);
    });

    it('keeps a platform admin account to platform admins, who manage every account', () => {
        expect(mayManageAccount({ role: 'admin', organizationId: 'o1' }, false, 'o1')).toBe(false);
        expect(mayManageAccount({ role: 'admin', organizationId: 'o1' }, true, null)).toBe(true);
        expect(mayManageAccount({ organizationId: null }, true, null)).toBe(true);
    });
});

describe('isHomeOrgAdmin', () => {
    it('is the server answer, which also counts an admin group of the home organisation', () => {
        expect(isHomeOrgAdmin({ isHomeOrgAdmin: true, orgRole: 'member', organizationId: 'o1' })).toBe(true);
        expect(isHomeOrgAdmin({ isHomeOrgAdmin: false, orgRole: 'org_admin', organizationId: 'o1' })).toBe(false);
    });

    it('does not guess from the organisation role without that answer', () => {
        expect(isHomeOrgAdmin({ orgRole: 'org_admin', organizationId: 'o1' })).toBe(false);
        expect(isHomeOrgAdmin({ isHomeOrgAdmin: 'true' })).toBe(false);
        expect(isHomeOrgAdmin(null)).toBe(false);
    });
});
