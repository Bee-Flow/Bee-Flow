import { describe, expect, it } from 'vitest';
import { ADMIN_TAB_GROUPS, ADMIN_TABS, canOpenAdminTab, groupAdminTabs, resolveAdminTab } from './adminTabs';
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
