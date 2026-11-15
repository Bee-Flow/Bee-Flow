import { describe, expect, it } from 'vitest';
import { SETTINGS_ORG_ADMIN_TARGETS } from '@/authedApp/settingsRoutes';
import { availabilityAnswer, orgFacts } from '@/test/organisationHubKit';
import { ADMIN_TAB_GROUPS } from '@/components/admin/dashboard/adminTabs';
import { ORG_HUB_SECTIONS, activeOrgSection, awaitingOrgSection, isOrgSectionVisible, orgAvailabilityFactsOf, orgStandingFactsOf, visibleOrgSections } from './orgSections';

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

describe('orgAvailabilityFactsOf: the chosen organisation, not the viewer\'s session', () => {
    const read = (over = {}) => ({ data: availabilityAnswer(over) });
    const base = { platformAdmin: false, homeOrg: true, sessionNcBound: false };

    it('Microsoft 365: set up on the server, and a directory connected or the viewer\'s own organisation', () => {
        const answer = (over: { serverConfigured?: boolean; directoryConnected?: boolean; homeOrg?: boolean }) => {
            const data = availabilityAnswer({ homeOrg: over.homeOrg ?? true });
            data.families.microsoft = { ...data.families.microsoft, serverConfigured: over.serverConfigured ?? true };
            data.microsoft = { directoryConnected: !!over.directoryConnected };
            return { data };
        };
        expect(orgAvailabilityFactsOf({ ...base, read: answer({}) }).microsoft365).toBe(true);
        expect(orgAvailabilityFactsOf({ ...base, read: answer({ serverConfigured: false }) }).microsoft365).toBe(false);
        expect(orgAvailabilityFactsOf({ ...base, read: answer({ homeOrg: false }) }).microsoft365).toBe(false);
        expect(orgAvailabilityFactsOf({ ...base, read: answer({ homeOrg: false, directoryConnected: true }) }).microsoft365).toBe(true);
        expect(orgAvailabilityFactsOf({ ...base, read: undefined }).microsoft365).toBe(false);
        expect(orgAvailabilityFactsOf({ ...base, platformAdmin: true, read: undefined }).microsoft365).toBe(true);
    });

    it('reads each family and the binding from the answer', () => {
        const facts = orgAvailabilityFactsOf({ ...base, read: read({ off: ['mcp', 'learningCenter'], ncBound: true }) });
        expect(facts).toMatchObject({ ncBound: true, ncSectionAvailable: true, mcp: false, learningCenter: false, automations: true, meetingNotes: true, projects: true });
        // A session that says otherwise is not asked once the answer is there.
        expect(orgAvailabilityFactsOf({ ...base, sessionNcBound: true, read: read() }).ncBound).toBe(false);
    });

    it('GitHub: the family, or a sync already set up for the organisation', () => {
        expect(orgAvailabilityFactsOf({ ...base, read: read({ off: ['github'] }) }).githubAvailable).toBe(false);
        expect(orgAvailabilityFactsOf({ ...base, read: read({ off: ['github'], githubSync: true }) }).githubAvailable).toBe(true);
        expect(orgAvailabilityFactsOf({ ...base, read: read() }).githubAvailable).toBe(true);
    });

    it('Nextcloud: a bound organisation, or the platform admin\'s own one while pairing is offered', () => {
        const unbound = read({ ncBound: false });
        expect(orgAvailabilityFactsOf({ ...base, read: unbound }).ncSectionAvailable).toBe(false);
        expect(orgAvailabilityFactsOf({ ...base, platformAdmin: true, read: unbound }).ncSectionAvailable).toBe(true);
        expect(orgAvailabilityFactsOf({ ...base, platformAdmin: true, read: read({ ncBound: false, homeOrg: false }) }).ncSectionAvailable).toBe(false);
    });

    it('without an answer: a platform admin fails open, an organisation admin closed; the binding falls back to the session for the home organisation', () => {
        for (const missing of [undefined, { isError: true }, { data: undefined }]) {
            const admin = orgAvailabilityFactsOf({ ...base, platformAdmin: true, read: missing });
            expect(admin).toMatchObject({ mcp: true, learningCenter: true, meetingNotes: true, githubAvailable: true, ncSectionAvailable: true });
            const orgAdmin = orgAvailabilityFactsOf({ ...base, read: missing });
            expect(orgAdmin).toMatchObject({ mcp: false, learningCenter: false, meetingNotes: false, githubAvailable: false, ncSectionAvailable: false });
        }
        expect(orgAvailabilityFactsOf({ ...base, sessionNcBound: true, read: undefined })).toMatchObject({ ncBound: true, ncSectionAvailable: true });
        expect(orgAvailabilityFactsOf({ ...base, homeOrg: false, sessionNcBound: true, read: undefined }).ncBound).toBe(false);
    });

    it('a degraded answer cannot vouch for the plan: unknown, by the fail policy', () => {
        const degraded = { data: { ...availabilityAnswer({ off: ['mcp'] }), degraded: true } };
        expect(orgAvailabilityFactsOf({ ...base, platformAdmin: true, read: degraded }).mcp).toBe(true);
        expect(orgAvailabilityFactsOf({ ...base, read: degraded }).mcp).toBe(false);
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

describe('activeOrgSection', () => {
    it('opens the requested section when the viewer has it, else the first one, and none without sections', () => {
        const sections = visibleOrgSections(orgFacts());
        expect(activeOrgSection(sections, 'encryption')).toBe('encryption');
        // Changed on purpose (wave 2): AI context is Conversations now, Meeting templates Meeting notes.
        expect(activeOrgSection(sections, 'ai_context')).toBe('conversations');
        expect(activeOrgSection(sections, 'ai-context')).toBe('conversations');
        expect(activeOrgSection(sections, 'meeting-templates')).toBe('meeting-notes');
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
