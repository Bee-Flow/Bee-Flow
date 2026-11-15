import { Bot, Cpu, Sparkles } from 'lucide-react';
import { describe, expect, it } from 'vitest';
import { orgFacts } from '@/test/organisationHubKit';
import { visibleOrgSections } from '@/components/admin/organisation/orgSections';
import type { TranslateFn } from '@/hooks/useTranslation';
import { ADMIN_TABS, type AdminTab } from './adminTabs';
import { activeRailRow, adminRailView, railRowLabel, visibleRailRows, type RailGateViewer, type VisibleRailRows } from './adminRailRows';
import type { AdminOrgChoice } from './useAdminOrg';

const t = ((key: string, fallback?: string) => fallback ?? key) as TranslateFn;
const choice = (isPlatformAdmin: boolean): AdminOrgChoice => ({
    isPlatformAdmin, orgId: null, orgName: null, organizations: [], organizationsLoaded: true, pending: false,
    homeOrganization: { id: 'org-a', name: 'Org A' }, setOrgId: () => {},
});
const viewer = (isPlatformAdmin: boolean, over: Partial<RailGateViewer> = {}): RailGateViewer => ({
    isPlatformAdmin, isHomeOrgAdmin: true, agentSections: isPlatformAdmin ? ['chat', 'system'] : ['chat'],
    hasFeature: () => true, hasTier: () => true, ...over,
});
const tabs = (ids: string[]) => ADMIN_TABS.filter(tab => ids.includes(tab.id));
const rowsFor = (list: readonly AdminTab[], over = {}, isPlatformAdmin = false): VisibleRailRows =>
    visibleRailRows(list, { org: { sections: visibleOrgSections(orgFacts(over)), facts: orgFacts(over) }, viewer: viewer(isPlatformAdmin) });
const view = (list: readonly AdminTab[], over = {}, isPlatformAdmin = false) =>
    adminRailView({ tabs: list, rows: rowsFor(list, over, isPlatformAdmin), isPlatformAdmin, choice: choice(isPlatformAdmin), t });
const ORG_ADMIN_TABS = ['agents', 'organisation', 'people', 'security', 'access', 'compliance', 'monitoring'];

/** Each group of a block as `group: row ids`. */
function block(sections: ReturnType<typeof adminRailView>, id: 'org' | 'instance') {
    return sections.find(s => s.id === id)?.groups.map(g => `${g.id}: ${g.tabs.map(r => r.id).join(' ')}`);
}

describe('adminRailView: the Organisation sections as rows of the rail', () => {
    // Changed on purpose (wave 2): the rows follow the target tree (ADMIN_RAIL_ORDER), the hubs' sections are rows.
    it('draws the organisation block of the target tree, and the Organisation tab itself has no row', () => {
        const rail = view(tabs(ORG_ADMIN_TABS), { githubAvailable: true, ncSectionAvailable: true, microsoft365: true });
        expect(block(rail, 'org')).toEqual([
            'organisation: organisation/info organisation/license people organisation/projects organisation/academy monitoring',
            'ai: agents/chat organisation/models organisation/conversations organisation/memory organisation/meeting-notes',
            'security: organisation/auth access security/guardrails organisation/encryption organisation/mcp-access compliance',
            'connections: organisation/integrations organisation/mcp organisation/nextcloud-sync organisation/azure organisation/github-sync organisation/integration-cache',
        ]);
        expect(rail.map(s => s.id)).toEqual(['org']);
    });

    it('offers Knowledge bases to whoever manages knowledge', () => {
        const ids = view(tabs(ORG_ADMIN_TABS), { canManageKnowledge: true }).flatMap(s => s.groups).flatMap(g => g.tabs).map(r => r.id);
        expect(ids).toContain('organisation/knowledge-bases');
    });

    it('gives a hidden section no row', () => {
        const ids = view(tabs(ORG_ADMIN_TABS), { learningCenter: false }).flatMap(s => s.groups).flatMap(g => g.tabs).map(r => r.id);
        expect(ids).not.toContain('organisation/academy');
        expect(ids).not.toContain('organisation/github-sync');
        expect(ids).toContain('organisation/info');
    });

    // Changed on purpose (wave 2): the instance-wide Azure form is no longer a row, so no organisation row carries the server mark.
    it('keeps the whole-server block for a platform admin, with no server-wide row in the organisation block', () => {
        const rail = view(ADMIN_TABS, { isSelfHosted: true, isPlatformAdmin: true }, true);
        expect(rail.map(s => s.id)).toEqual(['org', 'instance']);
        expect(rail[0].groups.flatMap(g => g.tabs).filter(r => r.serverWide)).toEqual([]);
        expect(rail[1].groups.flatMap(g => g.tabs).map(r => r.id)).not.toContain('organisation/info');
    });

    it('leaves the sections out with the tab', () => {
        expect(block(view(tabs(['security', 'access'])), 'org')).toEqual(['security: access security/guardrails']);
    });
});

describe('adminRailView: the whole-server block', () => {
    it('has group headings like the organisation block, none over a group of one row', () => {
        const rail = view(ADMIN_TABS, { isPlatformAdmin: true }, true);
        const server = rail.find(s => s.id === 'instance');
        const headings = Object.fromEntries((server?.groups ?? []).map(g => [g.id, g.label]));
        expect(headings.ai).toBe('AI & agents');
        expect(headings.identity).toBe('Identity & access');
        expect(headings.platform).toBe('Platform');
        expect(headings.operations).toBe('Operations');
        expect(headings.website).toBe('Website');
    });

    it('draws the whole-server block of the target tree, the hubs with their child rows', () => {
        const rail = view(ADMIN_TABS, { isPlatformAdmin: true }, true);
        expect(block(rail, 'instance')).toEqual([
            'ai: ai-config agents/system',
            'identity: organisations roles security/sso security/guardrail-library',
            'connections: integrations mcp-servers nextcloud-instances',
            'platform: licenses modules appearance languages',
            'operations: support subscriptions',
            'website: product-website website-analytics release-notes',
        ]);
        const rows = rail.flatMap(s => s.groups).flatMap(g => g.tabs);
        expect(rows.find(r => r.id === 'ai-config')?.children?.map(c => c.id)).toEqual([
            'ai-config/providers', 'ai-config/models', 'ai-config/retrieval', 'ai-config/direct-chat', 'ai-config/limits',
        ]);
        expect(rows.find(r => r.id === 'integrations')?.children?.map(c => c.id)).toEqual([
            'integrations/defaults', 'integrations/email', 'integrations/transcription', 'integrations/connected-apps',
        ]);
        expect(rows.find(r => r.id === 'appearance')?.children?.map(c => c.id)).toEqual(['appearance/look', 'appearance/icon-packs']);
        expect(rows.find(r => r.id === 'licenses')?.children?.map(c => c.id)).toEqual(['licenses/server', 'licenses/features']);
        expect(rows.find(r => r.id === 'monitoring')?.children?.map(c => c.id)).toContain('monitoring/spend');
    });

    it('gates the child rows on the licence and the viewer', () => {
        const rows = visibleRailRows(ADMIN_TABS, {
            org: { sections: [], facts: null },
            viewer: viewer(false, { isHomeOrgAdmin: false, hasFeature: () => false, hasTier: () => false }),
        });
        expect(rows.monitoring.map(r => r.section)).toEqual(['overview']);
        expect(rows.integrations.map(r => r.section)).toEqual(['defaults']);
        expect(rows.security.map(r => r.section)).toEqual([]);
        expect(rows.agents.map(r => r.section)).toEqual(['chat']);
        const homeAdmin = visibleRailRows(ADMIN_TABS, { org: { sections: [], facts: null }, viewer: viewer(false) });
        expect(homeAdmin.monitoring.map(r => r.section)).toContain('feedback');
        expect(homeAdmin.security.map(r => r.section)).toEqual(['guardrails']);
    });

    it('marks a row that leaves the dashboard chrome', () => {
        const rows = view(ADMIN_TABS, {}, true).flatMap(s => s.groups).flatMap(g => g.tabs);
        expect(rows.filter(r => r.escapesChrome).map(r => r.id)).toEqual(['product-website']);
    });
});

describe('rows by section scope: a tab of its own with section rows', () => {
    // A hub that keeps its row with child rows, plus one top-level row in the other block.
    const HUB: AdminTab = {
        id: 'hub', labelKey: 'Hub', icon: Sparkles, group: 'ai', perm: ['all'], scope: 'instance',
        railRows: [
            { section: 'one', labelKey: 'One', icon: Cpu, group: 'ai', block: 'instance', kind: 'child' },
            { section: 'two', labelKey: 'Two', icon: Cpu, group: 'ai', block: 'instance', kind: 'child', gate: ctx => ctx.isPlatformAdmin },
            { section: 'own', labelKey: 'Own', icon: Bot, group: 'security', block: 'org', kind: 'row' },
        ],
    };

    it('keeps the hub row with its children under it, places a top-level row by its block and gates the rest', () => {
        const rows = visibleRailRows([HUB], { org: { sections: [], facts: null }, viewer: viewer(true) });
        const rail = adminRailView({ tabs: [HUB], rows, isPlatformAdmin: true, choice: choice(true), t });
        expect(block(rail, 'org')).toEqual(['security: hub/own']);
        const hub = rail.find(s => s.id === 'instance')?.groups[0].tabs[0];
        expect(hub?.id).toBe('hub');
        expect(hub?.children?.map(c => c.id)).toEqual(['hub/one', 'hub/two']);
        const closed = visibleRailRows([HUB], { org: { sections: [], facts: null }, viewer: viewer(false) });
        expect(closed.hub.map(r => r.section)).toEqual(['one', 'own']);
    });

    // Changed on purpose (wave 2): the hub's own address opens its first child, so that child is the current row.
    it('opens the child the section names, else the first child', () => {
        const rows = visibleRailRows([HUB], { org: { sections: [], facts: null }, viewer: viewer(true) });
        expect(activeRailRow('hub', 'two', rows, [HUB])).toBe('hub/two');
        expect(activeRailRow('hub', 'own', rows, [HUB])).toBe('hub/own');
        expect(activeRailRow('hub', undefined, rows, [HUB])).toBe('hub/one');
        expect(activeRailRow('hub', 'gone', rows, [HUB])).toBe('hub/one');
    });

    it('names a child row for the narrow top bar', () => {
        const rows = visibleRailRows([HUB], { org: { sections: [], facts: null }, viewer: viewer(true) });
        const rail = adminRailView({ tabs: [HUB], rows, isPlatformAdmin: true, choice: choice(true), t });
        expect(railRowLabel(rail, 'hub/one')).toBe('One');
    });
});

describe('activeRailRow and railRowLabel', () => {
    it('is the tab, or for a tab that gave way to its rows the section it opens (the first visible one without a section)', () => {
        const rows = rowsFor(ADMIN_TABS);
        expect(activeRailRow('agents', 'chat', rows)).toBe('agents/chat');
        expect(activeRailRow('agents', undefined, rows)).toBe('agents/chat');
        expect(activeRailRow('people', 'groups', rows)).toBe('people');
        expect(activeRailRow('organisation', 'encryption', rows)).toBe('organisation/encryption');
        expect(activeRailRow('organisation', undefined, rows)).toBe('organisation/info');
        expect(activeRailRow('organisation', 'github-sync', rows)).toBe('organisation/info');
        // An old section id lands on its section (ORG_SECTION_ALIASES).
        expect(activeRailRow('organisation', 'mcp_access', rows)).toBe('organisation/mcp-access');
        expect(activeRailRow('organisation', 'ai-context', rows)).toBe('organisation/conversations');
        expect(activeRailRow('organisation', 'meeting-templates', rows)).toBe('organisation/meeting-notes');
    });

    it('names the current row for the narrow top bar', () => {
        const rail = view(tabs(ORG_ADMIN_TABS));
        expect(railRowLabel(rail, 'organisation/encryption')).toBe('Encryption');
        expect(railRowLabel(rail, 'nowhere')).toBeUndefined();
    });
});
