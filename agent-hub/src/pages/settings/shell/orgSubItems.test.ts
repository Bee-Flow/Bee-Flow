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

const ids = (f: OrgSubItemFacts) => filterOrgSubItems(BASE, AZURE, f).map(s => s.id);

describe('filterOrgSubItems: the Azure row', () => {
    // GET/PUT /api/org-azure-config/:orgId are platform-admin routes in every
    // deployment mode, so an org admin would get a panel that cannot load or save.
    it('is withheld from an org admin who is not a platform admin', () => {
        expect(ids(facts())).not.toContain('org_azure');
    });

    it('is offered to a platform admin on a self-hosted install', () => {
        expect(ids(facts({ isPlatformAdmin: true }))).toContain('org_azure');
    });

    it('stays off on cloud, where Azure is set in the admin dashboard', () => {
        expect(ids(facts({ isPlatformAdmin: true, isSelfHosted: false }))).not.toContain('org_azure');
    });
});
