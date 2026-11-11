import { describe, expect, it } from 'vitest';
import { SETTINGS_ORG_ADMIN_TARGETS } from '@/authedApp/settingsRoutes';
import { orgFacts } from '@/test/organisationHubKit';
import { ADMIN_TAB_GROUPS } from '@/components/admin/dashboard/adminTabs';
import { ORG_HUB_SECTIONS, activeOrgSection, isOrgSectionVisible, orgAzureSection, orgStandingFactsOf, visibleOrgSections } from './orgSections';

const ids = (over = {}) => visibleOrgSections(orgFacts(over)).map(s => s.id);

describe('the Organisation tab: which sections a viewer gets', () => {
    it('an organisation admin on cloud with every gate open gets the full set, in nav order', () => {
        expect(ids({ githubConnected: true, showNcSync: true })).toEqual([
            'info', 'auth', 'license', 'academy', 'encryption', 'ai-context', 'integration-cache', 'meeting-templates',
            'integrations', 'mcp', 'mcp-access', 'github-sync', 'nextcloud-sync',
        ]);
    });

    it('drops License & Usage on a self-hosted install, where licensing is server-wide', () => {
        expect(ids()).toContain('license');
        expect(ids({ isSelfHosted: true })).not.toContain('license');
    });

    it('drops Sign-in Method for a Nextcloud-bound organisation or a connector user, and once locked on cloud', () => {
        expect(ids({ isNcOrg: true })).not.toContain('auth');
        expect(ids({ isNcConnectorUser: true })).not.toContain('auth');
        expect(ids({ orgAuthLocked: true })).not.toContain('auth');
        // Self-hosted keeps it after the lock: the page also holds the Allowed Domains editor.
        expect(ids({ orgAuthLocked: true, isSelfHosted: true })).toContain('auth');
    });

    it('offers Academy only with the Learning Center in the plan', () => {
        expect(ids({ canUseLearning: false })).not.toContain('academy');
    });

    it('offers Meeting Templates only with Meeting Notes in the plan ceiling: not while it loads, open when it is unknown', () => {
        expect(ids({ inCeiling: () => false })).not.toContain('meeting-templates');
        expect(ids({ entitlementsLoading: true })).not.toContain('meeting-templates');
        expect(ids({ inCeiling: () => false, entitlementsUnknown: true })).toContain('meeting-templates');
    });

    it('offers GitHub Sync once GitHub is connected, Nextcloud Sync where Nextcloud applies', () => {
        expect(ids()).not.toContain('github-sync');
        expect(ids()).not.toContain('nextcloud-sync');
        expect(ids({ githubConnected: true })).toContain('github-sync');
        expect(ids({ showNcSync: true })).toContain('nextcloud-sync');
    });

    it('Azure: none on cloud; on self-hosted the services setup for the platform admin, the group sync for an organisation admin', () => {
        expect(orgAzureSection(orgFacts())).toBeNull();
        expect(ids()).not.toContain('azure');
        expect(orgAzureSection(orgFacts({ isSelfHosted: true, isPlatformAdmin: true }))).toBe('config');
        expect(orgAzureSection(orgFacts({ isSelfHosted: true }))).toBe('group-sync');
        const azure = (over: object) => visibleOrgSections(orgFacts({ isSelfHosted: true, ...over })).find(s => s.id === 'azure')?.labelKey;
        expect(azure({ isPlatformAdmin: true })).toBe('settings.azure_config');
        expect(azure({})).toBe('azure.group_sync_nav');
    });

    it('gives nothing to someone who does not administer an organisation, everything that applies to a platform admin', () => {
        expect(ids({ canSeeOrg: false })).toEqual([]);
        expect(ids({ canSeeOrg: false, isPlatformAdmin: true })).toContain('info');
        expect(isOrgSectionVisible('no-such-section', orgFacts())).toBe(false);
    });

    it('every section sits in a rail group of the dashboard, and every old Settings address that moved here names a section', () => {
        const groups = new Set<string>(ADMIN_TAB_GROUPS.map(g => g.id));
        expect(ORG_HUB_SECTIONS.every(s => groups.has(s.group))).toBe(true);
        const inGroup = (group: string) => ORG_HUB_SECTIONS.filter(s => s.group === group).map(s => s.id);
        expect(inGroup('organisation')).toEqual(['info', 'auth', 'license', 'academy']);
        expect(inGroup('ai')).toEqual(['ai-context', 'integration-cache', 'meeting-templates']);
        expect(inGroup('security')).toEqual(['encryption']);
        expect(inGroup('connections')).toEqual(['integrations', 'mcp', 'mcp-access', 'github-sync', 'nextcloud-sync', 'azure']);
        expect(visibleOrgSections(orgFacts({ isSelfHosted: true })).find(s => s.id === 'azure')?.group).toBe('connections');
        const moved = Object.values(SETTINGS_ORG_ADMIN_TARGETS).filter(t => t.startsWith('admin/organisation/')).map(t => t.slice('admin/organisation/'.length));
        expect(moved.length).toBeGreaterThan(10);
        for (const id of moved) expect(ORG_HUB_SECTIONS.map(s => s.id), id).toContain(id);
    });
});

describe('activeOrgSection', () => {
    it('opens the requested section when the viewer has it, else the first one, and none without sections', () => {
        const sections = visibleOrgSections(orgFacts());
        expect(activeOrgSection(sections, 'encryption')).toBe('encryption');
        expect(activeOrgSection(sections, undefined)).toBe('info');
        expect(activeOrgSection(sections, 'github-sync')).toBe('info');
        expect(activeOrgSection([], 'info')).toBe('');
    });
});

describe('orgStandingFactsOf', () => {
    it('counts an organisation-admin role, the org_admin permission or `all` as administering the organisation', () => {
        expect(orgStandingFactsOf({ orgRole: 'org_admin' }).canSeeOrg).toBe(true);
        expect(orgStandingFactsOf({ orgRole: 'admin' }).canSeeOrg).toBe(true);
        expect(orgStandingFactsOf({ permissions: ['org_admin'] }).canSeeOrg).toBe(true);
        expect(orgStandingFactsOf({ permissions: ['all'] }).canSeeOrg).toBe(true);
        expect(orgStandingFactsOf({ orgRole: 'member', permissions: ['manage_users'] }).canSeeOrg).toBe(false);
    });

    it('reads the deployment, the Nextcloud binding and the platform admin from the account', () => {
        expect(orgStandingFactsOf({ featureFlags: { deploymentMode: 'self-hosted' } }).isSelfHosted).toBe(true);
        expect(orgStandingFactsOf({}).isSelfHosted).toBe(false);
        expect(orgStandingFactsOf({ ncOrg: { instanceId: 'nc1' } })).toMatchObject({ isNcOrg: true, showNcSync: true });
        expect(orgStandingFactsOf({ role: 'admin' })).toMatchObject({ isPlatformAdmin: true, showNcSync: true });
        expect(orgStandingFactsOf({ permissions: ['all'] })).toMatchObject({ isPlatformAdmin: false, showNcSync: true });
        expect(orgStandingFactsOf({ provider: 'nextcloud_connector' }).isNcConnectorUser).toBe(true);
    });
});
