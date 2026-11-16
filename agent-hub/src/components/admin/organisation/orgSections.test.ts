import { describe, expect, it } from 'vitest';
import { SETTINGS_ORG_ADMIN_TARGETS } from '@/authedApp/settingsRoutes';
import { availabilityAnswer, orgFacts } from '@/test/organisationHubKit';
import { ADMIN_TABS, ADMIN_TAB_GROUPS } from '@/components/admin/dashboard/adminTabs';
import {
    ORG_HUB_SECTIONS, awaitingOrgSection, isOrgSectionVisible, openOrgSection,
    orgSectionUnavailableReason, orgStandingFactsOf, visibleOrgSections,
} from './orgSections';
import { orgAvailabilityFactsOf } from './orgAvailabilityFacts';

const ids = (over = {}) => visibleOrgSections(orgFacts(over)).map(s => s.id);

describe('the Organisation tab: which sections a viewer gets', () => {
    // Changed on purpose (wave 2): the target tree's sections (AI context split, Meeting notes, Models, Knowledge bases).
    it('an organisation admin on cloud with every gate open gets the full set, in nav order', () => {
        expect(ids({ githubAvailable: true, ncSectionAvailable: true, microsoft365: true, canManageKnowledge: true })).toEqual([
            'info', 'license', 'projects', 'academy', 'knowledge-bases', 'models', 'conversations', 'memory', 'meeting-notes',
            'auth', 'encryption', 'mcp-access', 'integrations', 'mcp', 'nextcloud-sync', 'azure', 'github-sync', 'integration-cache',
        ]);
    });

    it('offers Projects with Projects for the organisation, Knowledge bases to whoever manages knowledge', () => {
        expect(ids({ projects: false })).not.toContain('projects');
        expect(ids()).not.toContain('knowledge-bases');
        expect(ids({ canManageKnowledge: true })).toContain('knowledge-bases');
        expect(ids({ canSeeOrg: false, isPlatformAdmin: true })).toContain('knowledge-bases');
    });

    it('drops License & Usage on a self-hosted install, where licensing is server-wide', () => {
        expect(ids()).toContain('license');
        expect(ids({ isSelfHosted: true })).not.toContain('license');
    });

    // Changed on purpose (admin dashboard wave 2): the rule reads the CHOSEN organisation's
    // binding, so the viewer's own connector sign-in no longer hides another organisation's row.
    it('drops Sign-in Method only for an organisation bound to a Nextcloud: a stored method never hides it', () => {
        expect(ids({ ncBound: true })).not.toContain('auth');
        expect(ids({ isNcConnectorUser: true })).toContain('auth');
        // The preferred method never locks: the row stays, on cloud as self-hosted.
        expect(ids()).toContain('auth');
        expect(ids({ isSelfHosted: true })).toContain('auth');
    });

    it('offers Academy only with the Learning Center for the organisation', () => {
        expect(ids({ learningCenter: false })).not.toContain('academy');
    });

    it('offers Meeting notes only with meeting notes for the organisation', () => {
        expect(ids({ meetingNotes: false })).not.toContain('meeting-notes');
        expect(ids()).toContain('meeting-notes');
    });

    it('offers the answer cache with automations, the MCP library with MCP, for the organisation', () => {
        expect(ids({ automations: false })).not.toContain('integration-cache');
        expect(ids({ mcp: false })).not.toContain('mcp');
        expect(ids({ mcp: false })).toContain('mcp-access');
    });

    // Changed on purpose (wave 2): GitHub Sync follows the organisation's GitHub, not the viewer's personal link.
    it('offers GitHub Sync when the organisation has GitHub, Nextcloud Sync where Nextcloud applies to it', () => {
        expect(ids()).not.toContain('github-sync');
        expect(ids()).not.toContain('nextcloud-sync');
        expect(ids({ githubAvailable: true })).toContain('github-sync');
        expect(ids({ ncSectionAvailable: true })).toContain('nextcloud-sync');
    });

    // Changed on purpose (wave 2): the instance-wide Azure services form is no longer a row; Microsoft 365
    // (the organisation's group sync) follows the chosen organisation's Microsoft, for every viewer alike.
    it('Microsoft 365: where Microsoft applies to the organisation, one row for everyone', () => {
        expect(ids()).not.toContain('azure');
        expect(ids({ microsoft365: true })).toContain('azure');
        expect(ids({ microsoft365: true, isPlatformAdmin: true, isSelfHosted: true })).toContain('azure');
        const azure = visibleOrgSections(orgFacts({ microsoft365: true })).find(s => s.id === 'azure');
        expect(azure?.labelKey).toBe('admin_nav.microsoft_365');
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
        // Changed on purpose (wave 2): Sign-in and MCP client access are Security & access, the answer cache Connections.
        expect(inGroup('organisation')).toEqual(['info', 'license', 'projects', 'academy']);
        expect(inGroup('ai')).toEqual(['knowledge-bases', 'models', 'conversations', 'memory', 'meeting-notes']);
        expect(inGroup('security')).toEqual(['auth', 'encryption', 'mcp-access']);
        expect(inGroup('connections')).toEqual(['integrations', 'mcp', 'nextcloud-sync', 'azure', 'github-sync', 'integration-cache']);
        const moved = Object.values(SETTINGS_ORG_ADMIN_TARGETS).filter(t => t.startsWith('admin/organisation/')).map(t => t.slice('admin/organisation/'.length));
        expect(moved.length).toBeGreaterThan(10);
        for (const id of moved) expect(ORG_HUB_SECTIONS.map(s => s.id), id).toContain(id);
    });
});

describe('awaitingOrgSection: a deep link waits for the availability instead of opening another section', () => {
    it('waits only while the answer is being read, for a section that exists and is not (yet) visible', () => {
        const pending = orgFacts({ mcp: false, availabilityPending: true });
        expect(awaitingOrgSection(pending, 'mcp')).toBe(true);
        expect(awaitingOrgSection(pending, 'info')).toBe(false);
        expect(awaitingOrgSection(pending, 'no-such-section')).toBe(false);
        expect(awaitingOrgSection(pending, undefined)).toBe(false);
        expect(awaitingOrgSection(orgFacts({ mcp: false }), 'mcp')).toBe(false);
        // An old id waits as its section does.
        expect(awaitingOrgSection(orgFacts({ githubAvailable: false, availabilityPending: true }), 'github_sync')).toBe(true);
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

describe('openOrgSection: a section the viewer does not get opens as itself', () => {
    it('keeps the requested section (by its current id) and says whether it is there; no section or an unknown one opens the first', () => {
        const sections = visibleOrgSections(orgFacts());
        expect(openOrgSection(sections, 'encryption')).toEqual({ id: 'encryption', available: true });
        expect(openOrgSection(sections, 'github-sync')).toEqual({ id: 'github-sync', available: false });
        expect(openOrgSection(sections, 'github_sync')).toEqual({ id: 'github-sync', available: false });
        expect(openOrgSection(sections, 'ai-context')).toEqual({ id: 'conversations', available: true });
        // Changed on purpose (wave 2): AI context is Conversations now, Meeting templates Meeting notes.
        expect(openOrgSection(sections, 'ai_context')).toEqual({ id: 'conversations', available: true });
        expect(openOrgSection(sections, 'meeting-templates')).toEqual({ id: 'meeting-notes', available: true });
        expect(openOrgSection(sections, undefined)).toEqual({ id: 'info', available: true });
        expect(openOrgSection(sections, 'no-such-section')).toEqual({ id: 'info', available: true });
        expect(openOrgSection([], undefined)).toEqual({ id: '', available: false });
        expect(openOrgSection([], 'info')).toEqual({ id: 'info', available: false });
    });
});

describe('orgSectionUnavailableReason: why a section is not there', () => {
    it('names the availability reason of the family behind the section', () => {
        const facts = orgAvailabilityFactsOf({ read: { data: availabilityAnswer({ off: ['mcp', 'learningCenter'] }) }, platformAdmin: false, homeOrg: true, sessionNcBound: false });
        expect(facts.familyReasons).toEqual({ mcp: 'not_in_plan', learningCenter: 'not_in_plan' });
        expect(orgSectionUnavailableReason('mcp', { ...orgFacts(), ...facts })).toBe('not_in_plan');
        expect(orgSectionUnavailableReason('academy', { ...orgFacts(), ...facts })).toBe('not_in_plan');
    });

    it('names the section\'s own reasons, and falls back to a plain one', () => {
        expect(orgSectionUnavailableReason('license', orgFacts({ isSelfHosted: true }))).toBe('self_hosted_licence');
        expect(orgSectionUnavailableReason('auth', orgFacts({ ncBound: true }))).toBe('nextcloud_sign_in');
        expect(orgSectionUnavailableReason('knowledge-bases', orgFacts())).toBe('no_permission');
        expect(orgSectionUnavailableReason('nextcloud-sync', orgFacts())).toBe('not_bound');
        expect(orgSectionUnavailableReason('github-sync', orgFacts())).toBe('unknown');
        expect(orgSectionUnavailableReason('info', orgFacts({ canSeeOrg: false }))).toBe('no_permission');
    });
});

describe('the section rows\' icons', () => {
    it('gives the preferred sign-in method an icon of its own, not the one of Access', () => {
        const auth = ORG_HUB_SECTIONS.find(s => s.id === 'auth');
        const access = ADMIN_TABS.find(tab => tab.id === 'access');
        expect(auth?.icon).toBeDefined();
        expect(auth?.icon).not.toBe(access?.icon);
    });

    // Changed on purpose (wave 3): the sign-in row says what its page used to say under its own title.
    it('describes every section for the page header', () => {
        for (const section of ORG_HUB_SECTIONS) expect(section.descriptionKey, section.id).toMatch(/^(admin_nav\.|org_signin\.subtitle$)/);
    });
});
