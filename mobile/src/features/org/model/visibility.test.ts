import { buildAccessSnapshot } from '@/core/access';
import type { User } from '@/core/auth/types';

import { inputsFromAccess, visibleOrgSections, type OrgVisibilityInputs } from './visibility';

const ADMIN: OrgVisibilityInputs = {
    canSeeOrg: true,
    canManageUsers: true,
    canSeeCompliance: true,
    canUseLearning: true,
    isSuperAdmin: false,
    isPlatformAdmin: false,
    isSelfHosted: false,
    isNcOrg: false,
    isNcConnectorUser: false,
    authLocked: false,
    githubConnected: true,
};

const ids = (inputs: OrgVisibilityInputs) => visibleOrgSections(inputs).map((s) => s.id);

describe('visibleOrgSections', () => {
    it('offers a cloud org admin every web section but Nextcloud and Azure, then the phone’s', () => {
        expect(ids(ADMIN)).toEqual([
            'license', 'auth', 'privacy', 'encryption', 'ai_context', 'integration_cache', 'info',
            'org_usage', 'org_compliance', 'org_users', 'org_academy', 'org_integrations',
            'org_github_sync', 'org_meeting_templates', 'knowledge_bases',
        ]);
    });

    it('drops the licence on self-hosted', () => {
        expect(ids({ ...ADMIN, isSelfHosted: true })).not.toContain('license');
    });

    // /api/org-azure-config/:orgId and /api/branding/admin answer a platform admin only.
    it('offers Azure (self-hosted) and the theme to a platform admin only', () => {
        expect(ids({ ...ADMIN, isSelfHosted: true })).not.toContain('org_azure');
        expect(ids({ ...ADMIN, isSelfHosted: true })).not.toContain('theme');
        // `all` makes isSuperAdmin true here, never isPlatformAdmin.
        expect(ids({ ...ADMIN, isSelfHosted: true, isSuperAdmin: true })).not.toContain('org_azure');
        const platform = ids({ ...ADMIN, isSelfHosted: true, isSuperAdmin: true, isPlatformAdmin: true });
        expect(platform).toContain('org_azure');
        expect(platform).toContain('theme');
        expect(ids({ ...ADMIN, isSuperAdmin: true, isPlatformAdmin: true })).not.toContain('org_azure');
    });

    it('hides the sign-in method once chosen, and for a Nextcloud org', () => {
        expect(ids({ ...ADMIN, authLocked: true })).not.toContain('auth');
        const nc = ids({ ...ADMIN, isNcOrg: true });
        expect(nc).not.toContain('auth');
        expect(nc).toContain('org_nextcloud_sync');
    });

    it('follows the capability, permission and GitHub gates', () => {
        const shown = ids({ ...ADMIN, canSeeCompliance: false, canUseLearning: false, githubConnected: false, canManageUsers: false });
        expect(shown).not.toContain('org_compliance');
        expect(shown).not.toContain('org_academy');
        expect(shown).not.toContain('org_github_sync');
        expect(shown).not.toContain('org_users');
    });

    it('shows a DPO who is no org admin only Compliance', () => {
        expect(ids({ ...ADMIN, canSeeOrg: false, canManageUsers: false })).toEqual(['org_compliance']);
    });
});

describe('inputsFromAccess', () => {
    const facts = { isNcOrg: false, provider: 'local', authLocked: false, githubConnected: false };
    const snapshot = (over: Partial<User>, permissions: string[]) =>
        buildAccessSnapshot({
            user: { id: 'u1', displayName: 'Ada', isAdmin: false, role: 'user', provider: 'local', ...over },
            permissions: { permissions, groups: [], organizations: [], allowedAgentTypes: [] },
        });

    it('reads an org admin from the org role', () => {
        const inputs = inputsFromAccess(snapshot({ orgRole: 'org_admin' }, []), facts);
        expect(inputs.canSeeOrg).toBe(true);
        expect(inputs.canManageUsers).toBe(true);
        expect(inputs.isSuperAdmin).toBe(false);
        expect(inputs.isPlatformAdmin).toBe(false);
    });

    it('reads a platform admin from the role, never from the `all` permission', () => {
        expect(inputsFromAccess(snapshot({ orgRole: 'org_admin' }, ['all']), facts).isPlatformAdmin).toBe(false);
        expect(inputsFromAccess(snapshot({ role: 'admin' }, []), facts).isPlatformAdmin).toBe(true);
    });

    it('lets manage_users manage people without seeing the org', () => {
        const inputs = inputsFromAccess(snapshot({}, ['manage_users']), facts);
        expect(inputs).toMatchObject({ canSeeOrg: false, canManageUsers: true });
    });

    it('marks a Nextcloud connector session', () => {
        expect(inputsFromAccess(snapshot({}, []), { ...facts, provider: 'nextcloud_connector' }).isNcConnectorUser).toBe(true);
    });
});
