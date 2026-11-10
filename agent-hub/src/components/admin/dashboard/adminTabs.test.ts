import { describe, expect, it } from 'vitest';
import { ADMIN_TAB_GROUPS, ADMIN_TABS, adminScopeOf, adminSectionScope, canOpenAdminTab, groupAdminTabs, resolveAdminTab, shownAdminScope } from './adminTabs';
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
        expect(adminScopeOf(tab('monitoring'), 'feedback')).toBe('instance');
        expect(adminScopeOf(tab('security'), 'constructor')).toBe('mixed');
        expect(adminScopeOf(tab('compliance'), 'anything')).toBe('org');
    });

    it('the server-wide guardrails section is "instance", the users section stays "mixed"', () => {
        expect(adminSectionScope('security', 'guardrails')).toBe('instance');
        expect(adminSectionScope('security', 'users')).toBe('mixed');
        expect(adminSectionScope('nope', 'users')).toBeNull();
    });

    it('Access names no scope: its panel picks the organisation itself', () => {
        expect(adminScopeOf(tab('access'))).toBeNull();
        expect(shownAdminScope({ tab: tab('access'), override: null, hasHomeOrg: true })).toBeNull();
    });

    it('an organisation scope is shown only to a viewer with a home organisation; an override wins', () => {
        const compliance = tab('compliance');
        expect(shownAdminScope({ tab: compliance, override: null, hasHomeOrg: true })).toBe('org');
        expect(shownAdminScope({ tab: compliance, override: null, hasHomeOrg: false })).toBeNull();
        expect(shownAdminScope({ tab: tab('appearance'), override: 'user', hasHomeOrg: false })).toBe('user');
        expect(shownAdminScope({ tab: undefined, override: null, hasHomeOrg: true })).toBeNull();
    });
});
