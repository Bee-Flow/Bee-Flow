import { describe, expect, it } from 'vitest';
import { ADMIN_TAB_GROUPS, ADMIN_TABS, adminScopeOf, adminSectionScope, buildAdminRailSections, canOpenAdminTab, fixedOrgViewOf, groupAdminTabs, isAdminSectionVisible, isAdminSectionVisibleTo, resolveAdminTab, shownAdminScope } from './adminTabs';
import type { AdminAccess, AdminTab } from './adminTabs';

const access = (over: Partial<AdminAccess> = {}): AdminAccess => ({
    isCloud: true, isSelfHosted: false, tier: 'enterprise', serverOverride: false, isSuperAdmin: true, hasPermission: () => true, ...over,
});
const tab = (id: string) => ADMIN_TABS.find(t => t.id === id) as AdminTab;

describe('canOpenAdminTab', () => {
    it('hides cloud-only tabs on self-hosted and enterprise tabs below enterprise', () => {
        expect(canOpenAdminTab(tab('subscriptions'), access({ isCloud: false, isSelfHosted: true }))).toBe(false);
        expect(canOpenAdminTab(tab('monitoring'), access({ tier: 'community' }))).toBe(false);
        expect(canOpenAdminTab(tab('ai-config'), access({ tier: 'community' }))).toBe(true);
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
        expect(resolveAdminTab({}, () => true).activeTab).toBe('agents');
        expect(groupAdminTabs([tab('agents'), tab('organisation')]).map(g => g.id)).toEqual(['organisation', 'ai']);
    });

    it('opens with org_admin on any tier and deployment, never for a holder of other admin permissions alone', () => {
        const orgAdmin = access({ isSuperAdmin: false, tier: 'community', hasPermission: p => p === 'org_admin' });
        expect(canOpenAdminTab(tab('organisation'), orgAdmin)).toBe(true);
        expect(canOpenAdminTab(tab('organisation'), { ...orgAdmin, isCloud: false, isSelfHosted: true })).toBe(true);
        expect(canOpenAdminTab(tab('organisation'), access({ isSuperAdmin: false, hasPermission: p => p === 'admin_security' }))).toBe(false);
    });

    it('is the organisation the dashboard works on, with the Azure setup and the Maps key server-wide', () => {
        expect(adminScopeOf(tab('organisation'), 'info')).toBe('mixed');
        expect(adminSectionScope('organisation', 'azure')).toBe('mixed');
        expect(adminSectionScope('organisation', 'azure', 'config')).toBe('instance');
        expect(adminSectionScope('organisation', 'integrations', 'maps')).toBe('instance');
        expect(fixedOrgViewOf('organisation', 'info')).toBeNull();
    });
});

describe('resolveAdminTab', () => {
    const allowed = (ids: string[]) => (t: AdminTab | undefined) => !t || ids.includes(t.id);

    it('opens the requested tab when allowed, else the first allowed one in registry order', () => {
        expect(resolveAdminTab({ seg1: 'modules' }, allowed(['security', 'modules'])).activeTab).toBe('modules');
        const fallback = resolveAdminTab({ seg1: 'ai-config' }, allowed(['access', 'security']));
        expect(fallback.activeTab).toBe('security');
        expect(fallback.isTabAllowed).toBe(true);
    });

    it('maps /admin/chat and /admin/system onto the agents tab', () => {
        const r = resolveAdminTab({ seg1: 'system' }, allowed(['agents']));
        expect(r.activeTab).toBe('agents');
        expect(r.agentSection).toBe('system');
        expect(resolveAdminTab({}, allowed(['agents'])).activeTab).toBe('agents');
    });
});

describe('groupAdminTabs', () => {
    it('puts every tab in a known group and leaves empty groups out', () => {
        const groupIds = new Set(ADMIN_TAB_GROUPS.map(g => g.id));
        expect(ADMIN_TABS.every(t => groupIds.has(t.group))).toBe(true);
        expect(groupAdminTabs([tab('security'), tab('modules')]).map(g => g.id)).toEqual(['security', 'platform']);
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

    it('the guardrails section mixes both kinds, the users section stays "mixed"', () => {
        expect(adminSectionScope('security', 'guardrails')).toBe('mixed');
        expect(adminSectionScope('security', 'sso')).toBe('instance');
        expect(adminSectionScope('security', 'users')).toBe('mixed');
        expect(adminSectionScope('nope', 'users')).toBeNull();
    });

    it('Access follows the dashboard organisation; the server part of its Ceiling is the whole server', () => {
        expect(adminScopeOf(tab('access'))).toBe('mixed');
        expect(adminScopeOf(tab('access'), 'ceiling', 'server')).toBe('instance');
        expect(shownAdminScope({ tab: tab('access'), override: null, hasHomeOrg: true })).toBe('mixed');
    });

    it('the Users screen: organisations, Nextcloud, roles and permissions are server-wide, users and groups are not', () => {
        for (const part of ['organizations', 'nextcloud', 'roles', 'permissions']) expect(adminSectionScope('security', 'users', part)).toBe('instance');
        for (const part of ['users', 'groups']) expect(adminSectionScope('security', 'users', part)).toBe('mixed');
    });

    it('names the sections that do not follow the organisation picker, most specific first', () => {
        expect(fixedOrgViewOf('compliance')).toBe('home');
        expect(fixedOrgViewOf('compliance', 'frameworks', 'x')).toBe('home');
        expect(fixedOrgViewOf('security', 'guardrails', 'organisations')).toBe('all');
        expect(fixedOrgViewOf('security', 'guardrails', 'patterns')).toBeNull();
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
        for (const s of ['sso', 'email-domains', 'connector-health']) expect(isAdminSectionVisible('security', false, s)).toBe(false);
        for (const s of ['users', 'guardrails']) expect(isAdminSectionVisible('security', false, s)).toBe(true);
    });

    it('feedback: a platform admin and an organisation admin of their home organisation see it, anyone else with the tab does not', () => {
        expect(isAdminSectionVisibleTo('monitoring', { isPlatformAdmin: true, isHomeOrgAdmin: false }, 'feedback')).toBe(true);
        expect(isAdminSectionVisibleTo('monitoring', { isPlatformAdmin: false, isHomeOrgAdmin: true }, 'feedback')).toBe(true);
        expect(isAdminSectionVisibleTo('monitoring', { isPlatformAdmin: false, isHomeOrgAdmin: false }, 'feedback')).toBe(false);
        // The other pages read the generic routes, which scope any holder of the tab to their organisation.
        for (const page of ['overview', 'usage', 'activity', 'terminations']) {
            expect(isAdminSectionVisibleTo('monitoring', { isPlatformAdmin: false, isHomeOrgAdmin: false }, page)).toBe(true);
        }
        // A server-wide section stays the platform admin's, whatever the organisation standing.
        expect(isAdminSectionVisibleTo('security', { isPlatformAdmin: false, isHomeOrgAdmin: true }, 'sso')).toBe(false);
    });

    it('guardrails: every part is server-wide except the per-organisation shield', () => {
        for (const part of ['presets', 'patterns', 'terms', 'pii', 'dlp', 'directchat']) {
            expect(adminSectionScope('security', 'guardrails', part)).toBe('instance');
            expect(isAdminSectionVisible('security', false, 'guardrails', part)).toBe(false);
        }
        expect(adminSectionScope('security', 'guardrails', 'organisations')).toBe('mixed');
        expect(isAdminSectionVisible('security', false, 'guardrails', 'organisations')).toBe(true);
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
        expect(ids(org)).toEqual(expect.arrayContaining(['organisation', 'agents', 'security', 'access', 'monitoring', 'compliance']));
        expect(ids(org)[0]).toBe('organisation');
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
