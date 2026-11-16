// Every admin address that is written somewhere keeps landing on a tab or a
// rail row of the dashboard: the alias targets themselves, the Settings
// redirects (authedApp/settingsRoutes), the lesson surface gates, and the paths
// the server writes into notifications, e-mails, lessons and compliance
// remediation links. A rename that forgets an alias goes red here instead of
// opening the wrong page.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { render, screen } from '@testing-library/react';
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
    ORG_SETTINGS_ADMIN_TARGETS, ORG_USERS_TAB_TO_SECURITY, SETTINGS_ORG_ADMIN_TARGETS, USAGE_REPORT_TO_MONITORING, settingsOrgAdminTarget,
} from '@/authedApp/settingsRoutes';
import { DEFAULT_SECTION, resolveSection } from '@/components/admin/compliance/sections';
import { NAV_SURFACE_GATES } from '@/components/onboarding/surfaceGates';
import EntitlementsContext, { type EntitlementsValue } from '@/components/licensing/EntitlementsContext';
import LicenseContext from '@/components/licensing/LicenseContext';
import AdminDashboard from '@/pages/AdminDashboard';
import { withQueryClient } from '@/test/queryWrapper';
import { ADMIN_PATH_ALIASES, ORG_SECTION_ALIASES, orgSectionAlias, resolveAdminPath, type ResolvedAdminPath } from './adminPathAliases';
import { ADMIN_TABS, type AdminTab } from './adminTabs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../../../../..');

/** The segments of an app address or page name under admin/ ('/app/admin/a/b?x', 'admin/a/b'). */
function segmentsOf(address: string): ResolvedAdminPath {
    const bare = address.split(/[?#]/)[0].replace(/^\/+/, '').replace(/^app\//, '');
    expect(bare === 'admin' || bare.startsWith('admin/'), address).toBe(true);
    const [seg1 = '', seg2 = '', seg3 = ''] = bare.split('/').slice(1);
    return { seg1, seg2, seg3 };
}

const tabById = (id: string): AdminTab | undefined => ADMIN_TABS.find(tab => tab.id === id);

/** The in-page tabs of the tabs that have them (the panels' own lists). */
const IN_PAGE_SECTIONS: Readonly<Record<string, readonly string[]>> = {
    people: ['users', 'invitations', 'groups', 'org-roles'],
    roles: ['roles', 'permissions'],
    'nextcloud-instances': ['health'],
    access: ['grants', 'ceiling'],
};

/** The parts a row's own page has (its third segment), where it lists them. */
const ROW_PARTS: Readonly<Record<string, readonly string[]>> = {
    'security/sso': ['email-domains'],
    'security/guardrail-library': ['presets', 'patterns', 'terms', 'pii', 'dlp', 'directchat'],
};

/** The section ids a tab is known to have, where a registry lists them; null: the panel decides. */
function knownSections(tab: AdminTab): ((section: string, part: string) => boolean) | null {
    const partOk = (section: string, part: string) => !part || !Object.hasOwn(ROW_PARTS, `${tab.id}/${section}`) || ROW_PARTS[`${tab.id}/${section}`].includes(part);
    if (tab.railRows?.length) {
        // A tab's rail rows (top-level or child rows) are its sections.
        const ids = tab.railRows.map(row => row.section);
        return (section, part) => ids.includes(tab.id === 'organisation' ? orgSectionAlias(section) ?? section : section) && partOk(section, part);
    }
    if (tab.id === 'compliance') return (section) => section === DEFAULT_SECTION || resolveSection(section) !== DEFAULT_SECTION;
    if (Object.hasOwn(IN_PAGE_SECTIONS, tab.id)) return (section) => IN_PAGE_SECTIONS[tab.id].includes(section);
    return null;
}

/** Why an admin address does not land on a tab or row of the dashboard, or null when it does. */
function landingProblem(address: string): string | null {
    const resolved = resolveAdminPath(segmentsOf(address));
    const tab = tabById(resolved.seg1);
    if (!tab) return `${address}: no tab "${resolved.seg1}"`;
    const isKnown = knownSections(tab);
    // A '*' segment is a value filled in at run time (a thread, an incident, a section variable).
    if (!isKnown || !resolved.seg2 || resolved.seg2 === '*') return null;
    const part = resolved.seg3 === '*' ? '' : resolved.seg3;
    return isKnown(resolved.seg2, part) ? null : `${address}: "${resolved.seg2}${part ? `/${part}` : ''}" is not a section of ${tab.id}`;
}

const problemsOf = (addresses: readonly string[]) => addresses.map(landingProblem).filter(Boolean);

/** Admin addresses written as string literals in a server file; `${...}` becomes '*'. */
function adminLiteralsIn(file: string): string[] {
    const text = fs.readFileSync(file, 'utf8');
    const found = text.match(/['"`](?:\/app\/)?admin\/[^'"`\s)]*/g) ?? [];
    return found.map(m => m.slice(1).replace(/\$\{[^}]*\}/g, '*').replace(/[.,;:]+$/, ''));
}

function serverFiles(dir: string): string[] {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) return serverFiles(full);
        return /\.(js|mjs|cjs|mts)$/.test(e.name) && !/\.test\./.test(e.name) ? [full] : [];
    });
}

/**
 * Admin addresses a server file writes that do not lead into the dashboard at all
 * (another page under the admin/ prefix), each with why it is left as it is.
 */
const NOT_DASHBOARD: Readonly<Record<string, string>> = {
    // A Studio page written under admin/ by a compliance check (eaa/art4-webpage-a11y.js); not a dashboard address.
    'admin/studio/webpages': 'Studio webpages, not a dashboard tab',
};

describe('the alias table', () => {
    it('sends every old address to a tab or row that exists, and never to another alias', () => {
        for (const [from, to] of Object.entries(ADMIN_PATH_ALIASES)) {
            expect(Object.hasOwn(ADMIN_PATH_ALIASES, to), `${from} -> ${to} is a chain`).toBe(false);
            expect(landingProblem(`admin/${to}`), from).toBeNull();
            expect(resolveAdminPath(segmentsOf(`admin/${from}`)), from).toEqual(segmentsOf(`admin/${to}`));
        }
        for (const [from, to] of Object.entries(ORG_SECTION_ALIASES)) {
            expect(tabById('organisation')?.railRows?.map(r => r.section), from).toContain(to);
        }
    });

    // Changed on purpose (wave 2): the AI configuration and Users moves are real aliases now.
    it('keeps the segments after the matched key, the most specific key first', () => {
        expect(resolveAdminPath({ seg1: 'chat', seg2: 'x' })).toEqual({ seg1: 'agents', seg2: 'chat', seg3: 'x' });
        expect(resolveAdminPath({ seg1: 'ai-config', seg2: 'webSearchInference' })).toEqual({ seg1: 'ai-config', seg2: 'retrieval', seg3: '' });
        expect(resolveAdminPath({ seg1: 'security', seg2: 'users', seg3: 'roles' })).toEqual({ seg1: 'roles', seg2: '', seg3: '' });
        expect(resolveAdminPath({ seg1: 'security', seg2: 'users', seg3: 'groups' })).toEqual({ seg1: 'people', seg2: 'groups', seg3: '' });
        expect(resolveAdminPath({ seg1: 'security', seg2: 'connector-health', seg3: 'org-b' })).toEqual({ seg1: 'nextcloud-instances', seg2: 'health', seg3: 'org-b' });
        expect(resolveAdminPath({})).toEqual({ seg1: '', seg2: '', seg3: '' });
    });

    // Every address the old tree had, and where it opens now (the target tree of wave 2).
    it.each([
        ['security/users', 'people'],
        ['security/users/users', 'people/users'],
        ['security/users/invitations', 'people/invitations'],
        ['security/users/groups', 'people/groups'],
        ['security/users/org-roles', 'people/org-roles'],
        ['security/users/organizations', 'organisations'],
        ['security/users/nextcloud', 'nextcloud-instances'],
        ['security/users/roles', 'roles'],
        ['security/users/permissions', 'roles/permissions'],
        ['security/users/custom-tiers', 'organisation/models'],
        ['security/users/sync', 'organisation/nextcloud-sync'],
        ['security/users/my-organization', 'organisation/info'],
        ['security/email-domains', 'security/sso/email-domains'],
        ['security/connector-health', 'nextcloud-instances/health'],
        ['security/guardrails', 'security/guardrails'],
        ['security/guardrails/organisations', 'security/guardrails'],
        ['security/guardrails/patterns', 'security/guardrail-library/patterns'],
        ['security/guardrails/directchat', 'security/guardrail-library/directchat'],
        ['integrations/integrations', 'integrations/defaults'],
        ['integrations/services', 'integrations/connected-apps'],
        ['integrations/features', 'licenses/features'],
        ['integrations/search', 'ai-config/retrieval'],
        ['integrations/mcp', 'mcp-servers'],
        ['ai-config/chat-models', 'ai-config/models'],
        ['ai-config/embeddings', 'ai-config/retrieval'],
        ['ai-config/web-search', 'ai-config/retrieval'],
        ['ai-config/providers/reranker', 'ai-config/retrieval'],
        ['monitoring/usage', 'monitoring/spend'],
        ['organisation/ai-context', 'organisation/conversations'],
        ['organisation/meeting-templates', 'organisation/meeting-notes'],
        ['organisation/mcp/server', 'mcp-servers'],
        ['chat', 'agents/chat'],
        ['system', 'agents/system'],
    ])('admin/%s opens admin/%s', (from, to) => {
        expect(resolveAdminPath(segmentsOf(`admin/${from}`))).toEqual(segmentsOf(`admin/${to}`));
        expect(landingProblem(`admin/${to}`)).toBeNull();
    });
});

describe('the addresses the client writes', () => {
    it('every Settings redirect target lands', () => {
        expect(problemsOf(Object.values(SETTINGS_ORG_ADMIN_TARGETS))).toEqual([]);
        expect(problemsOf(Object.values(USAGE_REPORT_TO_MONITORING))).toEqual([]);
        expect(problemsOf(Object.values(ORG_SETTINGS_ADMIN_TARGETS))).toEqual([]);
        const usersTabs = Object.keys(ORG_USERS_TAB_TO_SECURITY).map(tab => settingsOrgAdminTarget('org_users', { seg1: tab }) as string);
        expect(usersTabs).toHaveLength(Object.keys(ORG_USERS_TAB_TO_SECURITY).length);
        expect(problemsOf(usersTabs)).toEqual([]);
    });

    it('every admin screen a Learning Center lesson opens lands', () => {
        const lessons = adminLiteralsIn(path.join(REPO, 'agent-hub/src/components/onboarding/generated/lessons.js'));
        expect(lessons).toEqual(expect.arrayContaining(['admin/people', 'admin/organisation/meeting-notes', 'admin/access']));
        expect(problemsOf(lessons)).toEqual([]);
    });

    it('every lesson surface gate names a screen that lands', () => {
        const admin = Object.keys(NAV_SURFACE_GATES).filter(key => key.startsWith('admin/'));
        expect(admin.length).toBeGreaterThan(5);
        expect(problemsOf(admin)).toEqual([]);
    });
});

describe('the addresses the server writes', () => {
    const files = [
        ...serverFiles(path.join(REPO, 'server/compliance')),
        path.join(REPO, 'server/utils/appPaths.js'),
        path.join(REPO, 'server/routes/ai/config/integrations.js'),
        path.join(REPO, 'server/auth/connectorJwt.js'),
        path.join(REPO, 'server/i18n/defaults/en/learn.js'),
    ];

    it('finds them (the scan is not looking at nothing)', () => {
        const all = files.flatMap(adminLiteralsIn);
        expect(all).toEqual(expect.arrayContaining(['admin/security/users', 'admin/monitoring/activity', '/app/admin/support/*', '/app/admin/organisation/models']));
    });

    it('every one lands on a tab or row of the dashboard', () => {
        const problems = files.flatMap(file => adminLiteralsIn(file)
            .filter(address => !Object.hasOwn(NOT_DASHBOARD, address.replace(/^\/app\//, '')))
            .map(address => landingProblem(address))
            .filter(Boolean)
            .map(problem => `${path.relative(REPO, file)}: ${problem}`));
        expect(problems).toEqual([]);
    });
});

describe('a tab that exists but is not the viewer\'s', () => {
    type LicenseValue = React.ComponentProps<typeof LicenseContext.Provider>['value'];
    beforeEach(() => {
        vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })));
    });

    function renderAt(adminPath: { seg1?: string; seg2?: string }) {
        const license = { tier: 'enterprise', deploymentMode: 'cloud', serverOverride: false, hasTier: () => true, hasFeature: () => true } as unknown as LicenseValue;
        const entitlements = { loading: false, degraded: false, error: null, can: () => false, inCeiling: () => false } as unknown as EntitlementsValue;
        const securityAdmin = { id: 'u2', isAdmin: false, role: 'user', permissions: ['admin_security'] };
        render(withQueryClient(
            <EntitlementsContext.Provider value={entitlements}>
                <LicenseContext.Provider value={license}>
                    <AdminDashboard user={securityAdmin as never} onBack={vi.fn()} onNavigate={vi.fn()} adminPath={adminPath} />
                </LicenseContext.Provider>
            </EntitlementsContext.Provider>,
        ));
    }

    it('is refused on its own address, with the rail still there, instead of showing another tab', () => {
        renderAt({ seg1: 'modules' });
        expect(screen.getByTestId('admin-access-denied-section')).toBeInTheDocument();
        expect(screen.queryByTestId('admin-tab-people')).not.toBeInTheDocument();
        expect(screen.getByTestId('admin-rail')).toBeInTheDocument();
    });

    it('an old address of a refused tab is refused too', () => {
        renderAt({ seg1: 'chat' });
        expect(screen.getByTestId('admin-access-denied-section')).toBeInTheDocument();
    });

    // Changed on purpose (wave 2): People (admin_security) is the first tab of this viewer in registry order now.
    it('a name no tab has opens the first tab this viewer may open', () => {
        renderAt({ seg1: 'no-such-tab' });
        expect(screen.queryByTestId('admin-access-denied-section')).not.toBeInTheDocument();
        expect(screen.getByTestId('admin-tab-people')).toBeInTheDocument();
    });

    it('the old bare Security address (the people list) opens People, not an empty Security pane', () => {
        renderAt({ seg1: 'security' });
        expect(screen.queryByTestId('admin-access-denied-section')).not.toBeInTheDocument();
        expect(screen.getByTestId('admin-tab-people')).toBeInTheDocument();
    });

    it('a Security row this viewer does not get is the denied page, not an empty pane', () => {
        renderAt({ seg1: 'security', seg2: 'sso' });
        expect(screen.getByTestId('admin-access-denied-section')).toBeInTheDocument();
    });

    it('the old Security > Users address opens People', () => {
        renderAt({ seg1: 'security', seg2: 'users' });
        expect(screen.queryByTestId('admin-access-denied-section')).not.toBeInTheDocument();
        expect(screen.getByTestId('admin-tab-people')).toBeInTheDocument();
    });
});
