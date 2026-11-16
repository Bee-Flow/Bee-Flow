import { describe, expect, it } from 'vitest';
import { ADMIN_RAIL_ORDER, ADMIN_TAB_GROUPS, ADMIN_TABS, adminRailBlockOf, adminScopeOf, adminSectionScope, buildAdminRailSections, canOpenAdminTab, fixedOrgViewOf, groupAdminTabs, isAdminSectionVisible, isAdminSectionVisibleTo, resolveAdminTab, shownAdminScope } from './adminTabs';
import type { AdminAccess, AdminTab } from './adminTabs';

const access = (over: Partial<AdminAccess> = {}): AdminAccess => ({
    isCloud: true, isSelfHosted: false, tier: 'enterprise', serverOverride: false, isSuperAdmin: true, hasPermission: () => true, ...over,
});
const tab = (id: string) => ADMIN_TABS.find(t => t.id === id) as AdminTab;

describe('canOpenAdminTab', () => {
    it('hides cloud-only tabs on self-hosted and enterprise tabs below enterprise', () => {
        expect(canOpenAdminTab(tab('subscriptions'), access({ isCloud: false, isSelfHosted: true }))).toBe(false);
        expect(canOpenAdminTab(tab('appearance'), access({ tier: 'community' }))).toBe(false);
        expect(canOpenAdminTab(tab('ai-config'), access({ tier: 'community' }))).toBe(true);
    });

    it('opens Monitoring below enterprise for an organisation admin by role, and for a holder of admin_monitoring', () => {
        const community = { tier: 'community', isSuperAdmin: false };
        expect(canOpenAdminTab(tab('monitoring'), access({ ...community, hasPermission: p => p === 'org_admin' }))).toBe(true);
        expect(canOpenAdminTab(tab('monitoring'), access({ ...community, hasPermission: p => p === 'admin_monitoring' }))).toBe(true);
        expect(canOpenAdminTab(tab('monitoring'), access({ ...community, hasPermission: p => p === 'admin_security' }))).toBe(false);
    });

    it('hides subscriptions while a server-wide licence governs, and super-admin tabs from others', () => {
        expect(canOpenAdminTab(tab('subscriptions'), access({ serverOverride: true }))).toBe(false);
        expect(canOpenAdminTab(tab('modules'), access({ isSuperAdmin: false }))).toBe(false);
        expect(canOpenAdminTab(tab('security'), access({ isSuperAdmin: false, hasPermission: p => p === 'admin_security' }))).toBe(true);
    });
});

describe('the Organisation tab', () => {
    it('sits right after Agents in the registry, so the fallback tab stays Agents, and heads the rail by its group', () => {
        expect(ADMIN_TABS.map(t => t.id).slice(0, 2)).toEqual(['agents', 'organisation']);
        expect(ADMIN_TAB_GROUPS[0].id).toBe('organisation');
        // Changed on purpose (wave 2): Identity & access heads the whole server's organisations, roles and sign-in.
        expect(ADMIN_TAB_GROUPS.map(g => g.id)).toEqual(['organisation', 'ai', 'identity', 'security', 'connections', 'platform', 'operations', 'website']);
        expect(resolveAdminTab({}, () => true).activeTab).toBe('agents');
        expect(groupAdminTabs([tab('agents'), tab('organisation')]).map(g => g.id)).toEqual(['organisation', 'ai']);
    });

    it('opens with org_admin on any tier and deployment, never for a holder of other admin permissions alone', () => {
        const orgAdmin = access({ isSuperAdmin: false, tier: 'community', hasPermission: p => p === 'org_admin' });
        expect(canOpenAdminTab(tab('organisation'), orgAdmin)).toBe(true);
        expect(canOpenAdminTab(tab('organisation'), { ...orgAdmin, isCloud: false, isSelfHosted: true })).toBe(true);
        expect(canOpenAdminTab(tab('organisation'), access({ isSuperAdmin: false, hasPermission: p => p === 'admin_security' }))).toBe(false);
    });

    // Changed on purpose (wave 2): the Azure services form is no longer offered here, so it has no scope of its own.
    // Changed on purpose (wave 3): the Google Maps key moved to Platform services, so no part is server-wide.
    it('is the organisation the dashboard works on, in every section and part', () => {
        expect(adminScopeOf(tab('organisation'), 'info')).toBe('mixed');
        expect(adminSectionScope('organisation', 'azure')).toBe('mixed');
        expect(adminSectionScope('organisation', 'azure', 'config')).toBe('mixed');
        expect(adminSectionScope('organisation', 'integrations', 'maps')).toBe('mixed');
        expect(fixedOrgViewOf('organisation', 'info')).toBeNull();
    });
});

describe('resolveAdminTab', () => {
    const allowed = (ids: string[]) => (t: AdminTab | undefined) => !!t && ids.includes(t.id);

    // Changed on purpose (admin dashboard wave 2): a tab that exists but is not the
    // viewer's is refused on its own address; it used to swap in the first allowed tab.
    it('opens the requested tab when allowed, and keeps a refused one so the dashboard can say so', () => {
        expect(resolveAdminTab({ seg1: 'modules' }, allowed(['security', 'modules'])).activeTab).toBe('modules');
        const refused = resolveAdminTab({ seg1: 'ai-config', seg2: 'limits' }, allowed(['access', 'security']));
        expect(refused.activeTab).toBe('ai-config');
        expect(refused.isTabAllowed).toBe(false);
        expect(refused.firstAllowedTab?.id).toBe('security');
    });

    it('opens the first allowed tab, in registry order, for no tab or a name no tab has', () => {
        expect(resolveAdminTab({}, allowed(['access', 'security']))).toMatchObject({ activeTab: 'security', isTabAllowed: true });
        const unknown = resolveAdminTab({ seg1: 'no-such-tab', seg2: 'x' }, allowed(['access', 'security']));
        expect(unknown).toMatchObject({ activeTab: 'security', isTabAllowed: true, path: { seg1: 'security', seg2: '', seg3: '' } });
        expect(resolveAdminTab({}, allowed([])).isTabAllowed).toBe(false);
    });

    it('maps /admin/chat and /admin/system onto the agents tab', () => {
        const r = resolveAdminTab({ seg1: 'system' }, allowed(['agents']));
        expect(r.activeTab).toBe('agents');
        expect(r.agentSection).toBe('system');
        expect(r.path).toEqual({ seg1: 'agents', seg2: 'system', seg3: '' });
        expect(resolveAdminTab({}, allowed(['agents'])).activeTab).toBe('agents');
    });

    // Changed on purpose (wave 2): the chat models are the Models section now.
    it('maps the old AI configuration tab names onto its sections, keeping what follows', () => {
        expect(resolveAdminTab({ seg1: 'ai-config', seg2: 'chatModels', seg3: 'p1' }, allowed(['ai-config'])).path)
            .toEqual({ seg1: 'ai-config', seg2: 'models', seg3: 'p1' });
        expect(resolveAdminTab({ seg1: 'ai-config', seg2: 'limits' }, allowed(['ai-config'])).path)
            .toEqual({ seg1: 'ai-config', seg2: 'limits', seg3: '' });
    });

    it('gives only the agents tab an agent section', () => {
        expect(resolveAdminTab({ seg1: 'security', seg2: 'sso' }, allowed(['security'])).agentSection).toBe('');
    });

    // Changed on purpose (review of wave 2): the old bare Security address was the people list for
    // everyone, and Security gave way to its rows (no page of its own), so it opens People whenever People opens.
    it('opens People for the old Security address without a section', () => {
        expect(resolveAdminTab({ seg1: 'security' }, allowed(['people'])).path).toMatchObject({ seg1: 'people' });
        expect(resolveAdminTab({ seg1: 'security' }, allowed(['security', 'people'])).path).toMatchObject({ seg1: 'people', seg2: '' });
        expect(resolveAdminTab({ seg1: 'security' }, allowed(['security'])).activeTab).toBe('security');
        expect(resolveAdminTab({ seg1: 'security', seg2: 'guardrails' }, allowed(['security', 'people'])).activeTab).toBe('security');
        expect(resolveAdminTab({ seg1: 'security', seg2: 'sso' }, allowed(['people'])).isTabAllowed).toBe(false);
    });
});

describe('rail rows by section scope', () => {
    it('the Organisation tab declares its sections as top-level rows of the organisation block', () => {
        const rows = tab('organisation').railRows ?? [];
        expect(rows.map(r => r.section)).toEqual(expect.arrayContaining(['info', 'auth', 'encryption', 'mcp', 'azure']));
        expect(rows.every(r => r.kind === 'row' && r.block === 'org')).toBe(true);
        const groups = new Set(ADMIN_TAB_GROUPS.map(g => g.id));
        expect(ADMIN_TABS.flatMap(t => t.railRows ?? []).every(r => groups.has(r.group))).toBe(true);
    });

    it('a section row sits in the block it names, a tab in the block of its scope', () => {
        expect(adminRailBlockOf(tab('modules'))).toBe('instance');
        expect(adminRailBlockOf(tab('security'))).toBe('org');
        expect(adminRailBlockOf({ ...tab('modules'), block: 'org' })).toBe('org');
    });

    it('Product website leaves the dashboard chrome', () => {
        expect(ADMIN_TABS.filter(t => t.escapesChrome).map(t => t.id)).toEqual(['product-website']);
    });
});

describe('groupAdminTabs', () => {
    it('puts every tab in a known group and leaves empty groups out', () => {
        const groupIds = new Set(ADMIN_TAB_GROUPS.map(g => g.id));
        expect(ADMIN_TABS.every(t => groupIds.has(t.group))).toBe(true);
        expect(groupAdminTabs([tab('security'), tab('modules')]).map(g => g.id)).toEqual(['security', 'platform']);
    });

    it('orders the rows inside a group by the target tree (ADMIN_RAIL_ORDER)', () => {
        const [workspace] = groupAdminTabs([tab('monitoring'), tab('people')]);
        expect(workspace.tabs.map(t => t.id)).toEqual(['people', 'monitoring']);
        const rail = new Set(ADMIN_RAIL_ORDER);
        for (const t of ADMIN_TABS.filter(x => !x.railRows?.every(r => r.kind === 'row'))) expect(rail, t.id).toContain(t.id);
    });
});

describe('scope', () => {
    const SCOPES = ['instance', 'org', 'mixed', 'user'];

    it('every tab and every sub-section has a known scope', () => {
        for (const t of ADMIN_TABS) {
            if (t.scope !== null) expect(SCOPES, t.id).toContain(t.scope);
            for (const scope of Object.values(t.sections ?? {})) expect(SCOPES, t.id).toContain(scope);
        }
    });

    it('a sub-section overrides the tab scope only where it is listed', () => {
        expect(adminScopeOf(tab('agents'), 'system')).toBe('instance');
        expect(adminScopeOf(tab('agents'), 'chat')).toBe('mixed');
        expect(adminScopeOf(tab('monitoring'))).toBe('mixed');
        expect(adminScopeOf(tab('monitoring'), 'feedback')).toBe('mixed');
        expect(adminScopeOf(tab('security'), 'constructor')).toBe('mixed');
        expect(adminScopeOf(tab('compliance'), 'anything')).toBe('org');
    });

    // Changed on purpose (wave 2): the Privacy Shield follows the chosen organisation, the console is the Guardrail library.
    it('the Privacy Shield is the organisation\'s, Sign-in & SSO and the Guardrail library the whole server', () => {
        expect(adminSectionScope('security', 'guardrails')).toBe('org');
        expect(adminSectionScope('security', 'sso')).toBe('instance');
        expect(adminSectionScope('security', 'guardrail-library')).toBe('instance');
        expect(adminSectionScope('nope', 'users')).toBeNull();
    });

    it('Access follows the dashboard organisation; the server part of its Ceiling is the whole server', () => {
        expect(adminScopeOf(tab('access'))).toBe('mixed');
        expect(adminScopeOf(tab('access'), 'ceiling', 'server')).toBe('instance');
        expect(shownAdminScope({ tab: tab('access'), override: null, hasHomeOrg: true })).toBe('mixed');
    });

    // Changed on purpose (wave 2): the old Users screen is People plus rows of their own.
    it('the people: organisations, Nextcloud instances and roles are server-wide, users and groups follow the choice', () => {
        for (const id of ['organisations', 'nextcloud-instances', 'roles', 'mcp-servers']) expect(adminSectionScope(id)).toBe('instance');
        for (const part of ['users', 'groups']) expect(adminSectionScope('people', part)).toBe('mixed');
        for (const part of ['invitations', 'org-roles']) expect(adminSectionScope('people', part)).toBe('org');
    });

    it('names the sections that do not follow the organisation picker, most specific first', () => {
        expect(fixedOrgViewOf('compliance')).toBe('home');
        expect(fixedOrgViewOf('compliance', 'frameworks', 'x')).toBe('home');
        // Changed on purpose (wave 2): the Privacy Shield row follows the organisation choice (it asks for one under "All").
        expect(fixedOrgViewOf('security', 'guardrails', 'organisations')).toBeNull();
        expect(fixedOrgViewOf('security', 'guardrail-library', 'patterns')).toBeNull();
        expect(fixedOrgViewOf('agents', 'chat')).toBeNull();
        expect(fixedOrgViewOf('monitoring')).toBeNull();
    });

    it('an organisation scope is shown only to a viewer with a home organisation; an override wins', () => {
        const compliance = tab('compliance');
        expect(shownAdminScope({ tab: compliance, override: null, hasHomeOrg: true })).toBe('org');
        expect(shownAdminScope({ tab: compliance, override: null, hasHomeOrg: false })).toBeNull();
        expect(shownAdminScope({ tab: tab('appearance'), override: 'user', hasHomeOrg: false })).toBe('user');
        expect(shownAdminScope({ tab: undefined, override: null, hasHomeOrg: true })).toBeNull();
    });
});

describe('server-wide scope', () => {
    it('a tab about the whole server is refused to anyone but a platform admin, whatever permissions they hold', () => {
        const instanceTabs = ADMIN_TABS.filter(t => t.scope === 'instance');
        expect(instanceTabs.length).toBeGreaterThan(0);
        for (const t of instanceTabs) {
            expect(canOpenAdminTab({ ...t, superAdminOnly: false, cloudOnly: false, minTier: undefined }, access({ isSuperAdmin: false }))).toBe(false);
        }
    });

    it('a section is visible to a platform admin always, to anyone else unless it is server-wide', () => {
        expect(isAdminSectionVisible('agents', false, 'system')).toBe(false);
        expect(isAdminSectionVisible('agents', true, 'system')).toBe(true);
        expect(isAdminSectionVisible('agents', false, 'chat')).toBe(true);
        for (const s of ['sso', 'guardrail-library']) expect(isAdminSectionVisible('security', false, s)).toBe(false);
        expect(isAdminSectionVisible('security', false, 'guardrails')).toBe(true);
    });

    it('feedback: a platform admin and an organisation admin of their home organisation see it, anyone else with the tab does not', () => {
        expect(isAdminSectionVisibleTo('monitoring', { isPlatformAdmin: true, isHomeOrgAdmin: false }, 'feedback')).toBe(true);
        expect(isAdminSectionVisibleTo('monitoring', { isPlatformAdmin: false, isHomeOrgAdmin: true }, 'feedback')).toBe(true);
        expect(isAdminSectionVisibleTo('monitoring', { isPlatformAdmin: false, isHomeOrgAdmin: false }, 'feedback')).toBe(false);
        // The other pages read the generic routes, which scope any holder of the tab to their organisation.
        for (const page of ['overview', 'spend', 'activity', 'terminations']) {
            expect(isAdminSectionVisibleTo('monitoring', { isPlatformAdmin: false, isHomeOrgAdmin: false }, page)).toBe(true);
        }
        // A server-wide section stays the platform admin's, whatever the organisation standing.
        expect(isAdminSectionVisibleTo('security', { isPlatformAdmin: false, isHomeOrgAdmin: true }, 'sso')).toBe(false);
    });

    // Changed on purpose (wave 2): the console's parts are one row of their own.
    it('guardrails: the library is server-wide in every part, the shield the organisation\'s', () => {
        for (const part of ['presets', 'patterns', 'terms', 'pii', 'dlp', 'directchat']) {
            expect(adminSectionScope('security', 'guardrail-library', part)).toBe('instance');
            expect(isAdminSectionVisible('security', false, 'guardrail-library', part)).toBe(false);
        }
        expect(isAdminSectionVisible('security', false, 'guardrails')).toBe(true);
    });
});

describe('buildAdminRailSections', () => {
    const all = ADMIN_TABS;

    it('splits by scope: instance tabs under the whole server, the rest under the organisation', () => {
        const [org, server] = buildAdminRailSections(all, true);
        expect(org.id).toBe('org');
        expect(server.id).toBe('instance');
        const ids = (s: typeof org) => s.groups.flatMap(g => g.tabs.map(t => t.id));
        expect(ids(server).every(id => tab(id).scope === 'instance')).toBe(true);
        expect(ids(org).every(id => tab(id).scope !== 'instance')).toBe(true);
        expect(ids(org)).toEqual(expect.arrayContaining(['organisation', 'agents', 'people', 'security', 'access', 'monitoring', 'compliance']));
        // Changed on purpose (wave 2): inside Workspace, People comes before Usage & monitoring (ADMIN_RAIL_ORDER).
        expect(ids(org).slice(0, 2)).toEqual(['people', 'monitoring']);
        expect(ids(org).length + ids(server).length).toBe(all.length);
    });

    it('leaves the whole-server group out for anyone but a platform admin', () => {
        const sections = buildAdminRailSections(all, false);
        expect(sections.map(s => s.id)).toEqual(['org']);
    });

    it('keeps the sub-groups in rail order and drops the empty ones', () => {
        const [org] = buildAdminRailSections([tab('security'), tab('agents')], false);
        expect(org.groups.map(g => g.id)).toEqual(['ai', 'security']);
        expect(buildAdminRailSections([], true)).toEqual([]);
    });
});
