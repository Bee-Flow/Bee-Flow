/**
 * The person predicates. The one that changed on purpose is isOrgAdmin: it
 * now matches the server's org-admin write gates, so `manage_users` alone no
 * longer makes an org admin.
 */

import { canUseFeature, hasAnyPermission, hasPermission, isOrgAdmin, isSuperAdmin } from './roles';

const member = (permissions: string[], extra: { orgRole?: string; role?: string; isAdmin?: boolean } = {}) => ({
    role: 'user',
    orgRole: 'member',
    permissions,
    ...extra,
});

describe('isSuperAdmin', () => {
    it('is the session flag or the platform role, never the `all` permission', () => {
        expect(isSuperAdmin({ isAdmin: true, role: 'user' })).toBe(true);
        expect(isSuperAdmin({ role: 'admin' })).toBe(true);
        expect(isSuperAdmin(member(['all']))).toBe(false);
    });
});

describe('hasPermission', () => {
    it('honours the permission itself, `all`, and a super admin', () => {
        expect(hasPermission(member(['manage_skills']), 'manage_skills')).toBe(true);
        expect(hasPermission(member(['all']), 'manage_skills')).toBe(true);
        expect(hasPermission(member([], { isAdmin: true }), 'manage_skills')).toBe(true);
        expect(hasPermission(member(['use_apps']), 'manage_skills')).toBe(false);
    });

    it('any-of asks each id, and no ids is no', () => {
        expect(hasAnyPermission(member(['admin_monitoring']), ['admin_monitoring', 'org_admin'])).toBe(true);
        expect(hasAnyPermission(member(['use_apps']), ['admin_monitoring', 'org_admin'])).toBe(false);
        expect(hasAnyPermission(member(['use_apps']), [])).toBe(false);
    });
});

describe('isOrgAdmin (the server predicate)', () => {
    it('passes a super admin, an org_admin or legacy admin orgRole, and the org_admin permission', () => {
        expect(isOrgAdmin(member([], { isAdmin: true }))).toBe(true);
        expect(isOrgAdmin(member([], { orgRole: 'org_admin' }))).toBe(true);
        expect(isOrgAdmin(member([], { orgRole: 'admin' }))).toBe(true);
        expect(isOrgAdmin(member(['org_admin']))).toBe(true);
        expect(isOrgAdmin(member(['all']))).toBe(true);
    });

    it('does NOT pass manage_users or admin_security on their own — every requireOrgAdmin write would 403', () => {
        expect(isOrgAdmin(member(['manage_users']))).toBe(false);
        expect(isOrgAdmin(member(['admin_security', 'manage_users']))).toBe(false);
    });

    it('does not pass the other org roles', () => {
        for (const orgRole of ['dpo', 'isms_auditor', 'agent_admin', 'agent_editor', 'member', '']) {
            expect(isOrgAdmin(member(['admin_compliance', 'manage_agents'], { orgRole }))).toBe(false);
        }
    });
});

describe('canUseFeature (the web makeCanUse)', () => {
    const facts = (canUse: Record<string, boolean>, permissions: string[] = [], betaFeatures: string[] = []) => ({
        canUseFeature: canUse,
        permissions,
        betaFeatures,
    });

    it("takes the server's map as final, an explicit false over a stale `all`", () => {
        expect(canUseFeature(facts({ webpages: true }), 'webpages')).toBe(true);
        expect(canUseFeature(facts({ webpages: false }, ['all'], ['webpages']), 'webpages')).toBe(false);
    });

    it('falls back to `all` or the beta list when the map is silent', () => {
        expect(canUseFeature(facts({}, ['all']), 'webpages')).toBe(true);
        expect(canUseFeature(facts({}, [], ['webpages']), 'webpages')).toBe(true);
        expect(canUseFeature(facts({}, ['use_apps']), 'webpages')).toBe(false);
        // A non-boolean in the map (the reader takes the object on trust) is silence.
        expect(canUseFeature(facts({ webpages: null as unknown as boolean }, [], ['webpages']), 'webpages')).toBe(true);
    });
});
