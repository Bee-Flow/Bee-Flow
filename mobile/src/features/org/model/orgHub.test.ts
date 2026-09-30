import { buildAccessSnapshot } from '@/core/access';
import type { LicenseStatus } from '@/features/usage';

import { hubGroups, licenceNeedsAttention, showLicenceGroup } from './orgHub';
import { searchOrgPlaces } from './orgSearch';
import { ORG_HUB_GROUPS, ORG_SECTIONS } from './sections';
import type { LicenseHealth } from './types';
import { visibleOrgSections, type OrgVisibilityInputs } from './visibility';

const ADMIN: OrgVisibilityInputs = {
    canSeeOrg: true,
    canManageUsers: true,
    canSeeCompliance: true,
    canUseLearning: true,
    isSuperAdmin: false,
    isSelfHosted: false,
    isNcOrg: false,
    isNcConnectorUser: false,
    authLocked: false,
    githubConnected: true,
};

const flat = (inputs: OrgVisibilityInputs) =>
    hubGroups(visibleOrgSections(inputs)).flatMap((g) => g.sections.map((s) => s.id));

describe('ORG_HUB_GROUPS', () => {
    it('files every section in exactly one group', () => {
        const filed = ORG_HUB_GROUPS.flatMap((g) => g.sections);
        expect([...filed].sort()).toEqual(ORG_SECTIONS.map((s) => s.id).sort());
        expect(new Set(filed).size).toBe(filed.length);
    });

    it.each([
        ['a cloud admin', ADMIN],
        ['a self-hosted Nextcloud admin', { ...ADMIN, isSelfHosted: true, isNcOrg: true }],
        ['a DPO', { ...ADMIN, canSeeOrg: false, canManageUsers: false }],
    ])('shows %s the sections visibleOrgSections offers, no more', (_label, inputs) => {
        expect([...flat(inputs)].sort()).toEqual(visibleOrgSections(inputs).map((s) => s.id).sort());
    });

    it('drops a group with nothing visible in it', () => {
        const groups = hubGroups(visibleOrgSections({ ...ADMIN, canSeeOrg: false, canManageUsers: false }));
        expect(groups.map((g) => g.group.id)).toEqual(['privacy']);
    });
});

describe('the licence on the index', () => {
    const health = (pastDue: number): LicenseHealth => ({
        refresher: { enabled: true },
        crl: { enabled: true },
        dunning: { past_due_count: pastDue, suspended_count: 0 },
        now: '2026-09-27T00:00:00Z',
    });
    const licence = (over: Partial<NonNullable<LicenseStatus['license']>>) =>
        ({ tier: 'business', source: 'license_key', license: over, subscription: null, features: [], limits: {} }) as unknown as LicenseStatus;
    const now = Date.parse('2026-09-27T00:00:00Z');

    it('needs attention near expiry, after a failed refresh, or with dunning trouble', () => {
        expect(licenceNeedsAttention(licence({ expiresAt: '2027-09-27T00:00:00Z', refreshStatus: 'ok' }), health(0), now)).toBe(false);
        expect(licenceNeedsAttention(licence({ expiresAt: '2026-10-05T00:00:00Z' }), health(0), now)).toBe(true);
        expect(licenceNeedsAttention(licence({ refreshStatus: 'failed' }), null, now)).toBe(true);
        expect(licenceNeedsAttention(licence({}), health(2), now)).toBe(true);
    });

    it('draws the whole group only on self-hosted or for a health problem, and never for a member', () => {
        expect(showLicenceGroup(true, true, health(0))).toBe(false);
        expect(showLicenceGroup(true, false, health(0))).toBe(true);
        expect(showLicenceGroup(true, true, health(1))).toBe(true);
        expect(showLicenceGroup(false, false, health(1))).toBe(false);
    });
});

describe('searchOrgPlaces', () => {
    const admin = buildAccessSnapshot({
        user: { id: 'u1', displayName: 'Ada', isAdmin: false, role: 'user', provider: 'local', orgRole: 'org_admin' },
        permissions: { permissions: [], groups: [], organizations: [], allowedAgentTypes: [] },
    });
    const ids = (query: string, inputs = ADMIN) =>
        searchOrgPlaces({ query, access: admin, visible: visibleOrgSections(inputs) }).map((d) => d.id);

    it('finds the screens below a section', () => {
        expect(ids('invitations')).toContain('org-invitations');
        expect(ids('n8n')).toContain('org-n8n');
        expect(ids('group sync', { ...ADMIN, isSelfHosted: true })).toContain('org-azure-sso');
    });

    it('keeps out what the index hides this session', () => {
        expect(ids('azure')).toEqual([]);
        expect(ids('invoices', { ...ADMIN, isSelfHosted: true })).toEqual([]);
    });

    it('answers nothing to an empty query', () => {
        expect(ids('  ')).toEqual([]);
    });
});
