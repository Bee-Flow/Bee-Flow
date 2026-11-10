import { describe, expect, it } from 'vitest';
import { homeOrgIdOf, isOrgAdminRole, isPlatformAdmin } from './adminAccess';

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
