import { describe, expect, it } from 'vitest';
import { orgFacts } from '@/test/organisationHubKit';
import { visibleOrgSections } from '@/components/admin/organisation/orgSections';
import type { TranslateFn } from '@/hooks/useTranslation';
import { ADMIN_TABS } from './adminTabs';
import { activeRailRow, adminRailView, railRowLabel, type OrgRailSection } from './adminRailRows';
import type { AdminOrgChoice } from './useAdminOrg';

const t = ((key: string, fallback?: string) => fallback ?? key) as TranslateFn;
const choice = (isPlatformAdmin: boolean): AdminOrgChoice => ({
    isPlatformAdmin, orgId: null, orgName: null, organizations: [], organizationsLoaded: true, pending: false,
    homeOrganization: { id: 'org-a', name: 'Org A' }, setOrgId: () => {},
});
const orgRows = (over = {}): OrgRailSection[] => visibleOrgSections(orgFacts(over)).map(s => ({ ...s, serverWide: s.id === 'azure' }));
const tabs = (ids: string[]) => ADMIN_TABS.filter(tab => ids.includes(tab.id));
const ORG_ADMIN_TABS = ['agents', 'organisation', 'security', 'access', 'compliance', 'monitoring'];

/** Each group of the organisation block as `group: row ids`. */
function orgBlock(sections: ReturnType<typeof adminRailView>) {
    const org = sections.find(s => s.id === 'org');
    return org?.groups.map(g => `${g.id}: ${g.tabs.map(r => r.id).join(' ')}`);
}

describe('adminRailView: the Organisation sections as rows of the rail', () => {
    it('puts each section in its own group, after the tabs of that group, and the tab itself has no row', () => {
        const view = adminRailView({ tabs: tabs(ORG_ADMIN_TABS), orgSections: orgRows({ githubConnected: true, showNcSync: true }), isPlatformAdmin: false, choice: choice(false), t });
        expect(orgBlock(view)).toEqual([
            'organisation: organisation/info organisation/auth organisation/license organisation/academy',
            'ai: agents organisation/ai-context organisation/integration-cache organisation/meeting-templates',
            'security: security access compliance organisation/encryption',
            'connections: organisation/integrations organisation/mcp organisation/mcp-access organisation/github-sync organisation/nextcloud-sync',
            'operations: monitoring',
        ]);
        expect(view.map(s => s.id)).toEqual(['org']);
    });

    it('gives a hidden section no row', () => {
        const view = adminRailView({ tabs: tabs(ORG_ADMIN_TABS), orgSections: orgRows({ canUseLearning: false }), isPlatformAdmin: false, choice: choice(false), t });
        const ids = view.flatMap(s => s.groups).flatMap(g => g.tabs).map(r => r.id);
        expect(ids).not.toContain('organisation/academy');
        expect(ids).not.toContain('organisation/github-sync');
        expect(ids).toContain('organisation/info');
    });

    it('keeps the whole-server block for a platform admin, and the server-wide mark on a server-wide section', () => {
        const view = adminRailView({ tabs: ADMIN_TABS, orgSections: orgRows({ isSelfHosted: true, isPlatformAdmin: true }), isPlatformAdmin: true, choice: choice(true), t });
        expect(view.map(s => s.id)).toEqual(['org', 'instance']);
        const rows = view[0].groups.flatMap(g => g.tabs);
        expect(rows.find(r => r.id === 'organisation/azure')?.serverWide).toBe(true);
        expect(rows.filter(r => r.serverWide).map(r => r.id)).toEqual(['organisation/azure']);
        expect(view[1].groups.flatMap(g => g.tabs).map(r => r.id)).not.toContain('organisation/info');
    });

    it('leaves the sections out with the tab', () => {
        const view = adminRailView({ tabs: tabs(['security', 'access']), orgSections: orgRows(), isPlatformAdmin: false, choice: choice(false), t });
        expect(orgBlock(view)).toEqual(['security: security access']);
    });
});

describe('activeRailRow and railRowLabel', () => {
    it('is the tab, or for the Organisation tab the section it opens (the first visible one without a section)', () => {
        const sections = orgRows();
        expect(activeRailRow('agents', 'chat', sections)).toBe('agents');
        expect(activeRailRow('organisation', 'encryption', sections)).toBe('organisation/encryption');
        expect(activeRailRow('organisation', undefined, sections)).toBe('organisation/info');
        expect(activeRailRow('organisation', 'github-sync', sections)).toBe('organisation/info');
    });

    it('names the current row for the narrow top bar', () => {
        const view = adminRailView({ tabs: tabs(ORG_ADMIN_TABS), orgSections: orgRows(), isPlatformAdmin: false, choice: choice(false), t });
        expect(railRowLabel(view, 'organisation/encryption')).toBe('settings.encryption');
        expect(railRowLabel(view, 'nowhere')).toBeUndefined();
    });
});
