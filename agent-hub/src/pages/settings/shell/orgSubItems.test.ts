import { describe, expect, it } from 'vitest';
import { filterOrgSubItems, type OrgSubItemFacts } from './orgSubItems';
import type { OrgSubItem } from './settingsShellTypes';

const Icon = () => null;
const row = (id: string): OrgSubItem => ({ id, labelKey: `settings.${id}`, icon: Icon, color: '#000' });
const BASE = [row('org_users'), row('org_integrations')];
const AZURE = row('org_azure');

const facts = (over: Partial<OrgSubItemFacts> = {}): OrgSubItemFacts => ({
    canSeeOrg: true,
    canManageUsers: true,
    canUseLearning: false,
    showComplianceNav: false,
    isSelfHosted: true,
    isPlatformAdmin: false,
    isNcConnectorUser: false,
    isNcOrg: false,
    showNcSync: false,
    githubConnected: false,
    orgAuthLocked: false,
    entitlementsLoading: false,
    entitlementsUnknown: false,
    ...over,
});

// The group-sync row takes the Azure tab's id and address, with its own label.
const GROUP_SYNC: OrgSubItem = { ...AZURE, labelKey: 'azure.group_sync_nav' };

const rows = (f: OrgSubItemFacts) => filterOrgSubItems(BASE, AZURE, f, GROUP_SYNC);
const ids = (f: OrgSubItemFacts) => rows(f).map(s => s.id);
const labels = (f: OrgSubItemFacts) => rows(f).map(s => s.labelKey);

describe('filterOrgSubItems: the Azure row', () => {
    // GET/PUT /api/org-azure-config/:orgId are platform-admin routes in every
    // deployment mode, so an org admin would get a panel that cannot load or save.
    it('is withheld from an org admin who is not a platform admin', () => {
        expect(labels(facts())).not.toContain('settings.org_azure');
    });

    it('is offered to a platform admin on a self-hosted install, without the group-sync row', () => {
        expect(labels(facts({ isPlatformAdmin: true }))).toContain('settings.org_azure');
        expect(labels(facts({ isPlatformAdmin: true }))).not.toContain('azure.group_sync_nav');
    });

    it('stays off on cloud, where Azure is set in the admin dashboard', () => {
        expect(ids(facts({ isPlatformAdmin: true, isSelfHosted: false }))).not.toContain('org_azure');
    });
});

describe('filterOrgSubItems: the group-sync row', () => {
    // The sync routes (/api/org-azure-config/:orgId/sync-groups*) are the
    // organisation admin's of that organisation.
    it('is offered to an org admin on a self-hosted install, once', () => {
        expect(labels(facts())).toEqual(['settings.org_users', 'settings.org_integrations', 'azure.group_sync_nav']);
    });

    it('is not offered on cloud, nor to someone who cannot see the organisation', () => {
        expect(ids(facts({ isSelfHosted: false }))).not.toContain('org_azure');
        expect(ids(facts({ canSeeOrg: false }))).not.toContain('org_azure');
    });

    it('is not offered when the caller passes no group-sync row', () => {
        expect(filterOrgSubItems(BASE, AZURE, facts()).map(s => s.id)).not.toContain('org_azure');
    });
});
