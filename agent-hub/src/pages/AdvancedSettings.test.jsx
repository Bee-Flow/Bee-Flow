import { act, cleanup, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Characterisation of the SETTINGS SHELL — the screen around the sections:
 * which sidebar rows exist for which account, which org sub-items survive the
 * permission/licence/deployment filter and in which groups they are drawn,
 * which panel a segment opens, where the bounce effects (Simple Mode,
 * self-hosted, phone, self-hosted licence, Learning Center, Notifications)
 * land, and how the Organisation accordion behaves.
 *
 * The URL⟷tab mapping itself lives in authedApp/settingsRoutes.js and is
 * frozen by settingsRoutes.test.js; this file pins the SCREEN, so it asserts
 * on rendered rows, rendered panels and the props handed to them, and only
 * touches the address bar where the screen writes it.
 *
 * Every section is stubbed — this is about the shell, and the sections have
 * their own files. i18n is real (labels are the strings on screen); the
 * licence hooks and the viewport are the seams the branches read.
 */

vi.mock('../utils/helpers', () => ({ API_BASE: '', authFetch: vi.fn() }));

let viewport = { isMobile: false, isCompact: false, isDesktop: true, width: 1920 };
vi.mock('../hooks/useViewport', () => ({
    useViewport: () => viewport,
    default: () => viewport,
}));

let subscription = { hasActiveSub: true, sub: null, loading: false };
vi.mock('../components/licensing/SubscriptionContext', () => ({
    useSubscriptionContext: () => subscription,
}));

// What this member may use (useCan, and LicenseContext.hasFeature, which
// useProjectsAvailable reads).
let capabilities = new Set();
vi.mock('../components/licensing/Gate', () => ({
    useCan: (cap) => capabilities.has(cap),
    default: ({ children }) => children,
}));

// `loading` (the Learning Center and Notifications bounces wait for it) and
// the org's plan ceiling (the Meeting Templates row reads it).
let entitlementsLoading = false;
let entitlementsError = null;
let ceiling = new Set();
vi.mock('../components/licensing/EntitlementsContext', () => ({
    useEntitlements: () => ({ loading: entitlementsLoading, error: entitlementsError, degraded: false, inCeiling: (id) => ceiling.has(id) }),
}));

vi.mock('../components/licensing/LicenseContext', () => ({
    // Pass-through so the test can see WHAT the shell wrapped and with which
    // gate; the gate's own semantics (including its fail-open on an
    // entitlements outage) belong to LicenseContext's tests.
    RequireTier: ({ tier, feature, children }) => (
        <div data-testid="require-tier" data-tier={tier} data-feature={feature}>{children}</div>
    ),
    useLicenseContext: () => ({ hasFeature: (cap) => capabilities.has(cap) }),
}));

/* ── Section stubs. Each records the props the shell hands it. ───────────── */
vi.mock('./settings/PreferencesSection', () => ({
    default: (p) => <div data-testid="section-preferences" data-agents={JSON.stringify(p.agents)} />,
}));
vi.mock('./settings/AppearanceSection', () => ({ default: () => <div data-testid="section-appearance" /> }));
vi.mock('./settings/SecuritySection', () => ({ default: () => <div data-testid="section-security" /> }));
vi.mock('./settings/NotificationsSection', () => ({ default: () => <div data-testid="section-notifications" /> }));
vi.mock('./settings/MemorySection', () => ({
    default: (p) => (
        <div data-testid="section-memory" data-stats={JSON.stringify(p.memoryStats)}>
            <button onClick={p.onOpenMemory}>open-memory</button>
            <button onClick={p.onImported}>imported</button>
        </div>
    ),
}));
vi.mock('./settings/IntegrationsSection', () => ({
    default: (p) => (
        <div data-testid="section-integrations"
            data-props={Object.keys(p).sort().join(',')}
            data-fireflies={String(p.statuses?.hasFirefliesKey)}
            data-signrequest={String(p.statuses?.hasSignRequestConfig)}
            data-github={String(p.statuses?.githubConnected)}>
            <button onClick={() => p.onSaved('fireflies')}>saved-fireflies</button>
            <button onClick={() => p.onSaved('afas-profit')}>saved-afas</button>
            <button onClick={() => p.onSaved('github')}>saved-github</button>
            <button onClick={() => p.onSaved('google')}>saved-google</button>
        </div>
    ),
}));
vi.mock('./settings/LearningCenterSection', () => ({ default: () => <div data-testid="section-learning" /> }));
vi.mock('./settings/HelpSupportSection', () => ({
    default: (p) => (
        <div data-testid="section-help" data-learnlink={String(p.showLearningLink)}>
            <button onClick={() => p.onOpenLearning?.()}>open-learning</button>
        </div>
    ),
}));
vi.mock('./settings/OrganisationSection', () => ({
    default: (p) => (
        <div data-testid="section-organisation"
            data-active={p.activeSection}
            data-report={p.usageInitialReport} />
    ),
}));
vi.mock('./settings/ConsumerLicenseSection', () => ({ default: () => <div data-testid="section-consumer-license" /> }));
vi.mock('./settings/ConsumerPrivacySection', () => ({ default: () => <div data-testid="section-consumer-privacy" /> }));
vi.mock('./settings/ConsumerUsageSection', () => ({ default: () => <div data-testid="section-consumer-usage" /> }));
vi.mock('./settings/ConsumerIntegrationsSection', () => ({ default: () => <div data-testid="section-consumer-integrations" /> }));
vi.mock('./settings/ConsumerBetaFeaturesSection', () => ({ default: () => <div data-testid="section-consumer-beta" /> }));
vi.mock('../components/integrations/azure/index', () => ({ default: () => <div data-testid="section-azure" /> }));
vi.mock('../components/knowledge/memory/MemoryPanel', () => ({
    default: (p) => <div data-testid="memory-panel"><button onClick={p.onClose}>close-memory</button></div>,
}));
vi.mock('../components/admin/compliance', () => ({
    default: (p) => (
        <div data-testid="section-compliance" data-section={p.activeSection} data-check={String(p.focusCheckId)}
            data-onback={typeof p.onBack === 'function' ? 'fn' : String(p.onBack)}>
            {/* The phone frame's own back chevron (fe-9): the shell hands it
                down on mobile only, and it returns to the section list. */}
            <button disabled={typeof p.onBack !== 'function'} onClick={() => p.onBack?.()}>hub-back</button>
            <button onClick={() => p.onNavigate('admin/compliance/dsr/req%2F7')}>go-dsr</button>
            <button onClick={() => p.onNavigate('admin/compliance/frameworks?tab=calendar')}>go-calendar</button>
            <button onClick={() => p.onNavigate('admin/compliance/training', { replace: true })}>go-redirect</button>
            <button onClick={() => p.onNavigate('admin/security/guardrails')}>go-guardrails</button>
            <button onClick={() => p.onNavigate('admin/agents')}>go-agents</button>
        </div>
    ),
}));
// The Compliance badge's data seam. The hook itself (its poll, its tolerant
// parse, its failed flag) is pinned by its own file; what this screen owns is
// the OPTIONS it asks with and what it does with the number that comes back.
let complianceCounts = null;
const countsHookOpts = [];
vi.mock('../components/admin/compliance/data/useComplianceCounts', () => ({
    default: (opts) => {
        countsHookOpts.push(opts);
        return { counts: complianceCounts, failed: false, bump: vi.fn(), refresh: vi.fn() };
    },
}));
// The real SECTIONS table (it drives seven of the org sub-items) without the
// panel tree behind it.
vi.mock('../components/admin/org/OrgInfoPanel', async () => {
    const shared = await import('../components/admin/org/orgInfo/orgInfoShared');
    return { SECTIONS: shared.SECTIONS, default: () => null };
});

import AdvancedSettings from './AdvancedSettings';
import { renderWithClient } from '../test/render';
import { authFetch } from '../utils/helpers';

const json = (body, ok = true) => ({ ok, status: ok ? 200 : 500, json: async () => body });

const MEMBER = { id: 'u1', username: 'tom', displayName: 'Tom Smit', permissions: [], orgRole: 'member' };
const ORG_ADMIN = { ...MEMBER, orgRole: 'org_admin', permissions: ['org_admin'], organizationId: 'org1' };
const SUPER_ADMIN = { ...MEMBER, role: 'admin', permissions: ['all'], organizationId: 'org1' };
const DPO = { ...MEMBER, permissions: ['admin_compliance'] };
const CONSUMER = { ...MEMBER, isConsumerAccount: true };
const PHONE = { isMobile: true, isCompact: false, isDesktop: false, width: 390 };
const SELF_HOSTED = { featureFlags: { deploymentMode: 'self-hosted' } };

/** Route every call the shell makes on mount. `over` may be changed later. */
let served = {};
function serve(over = {}) {
    served = over;
    authFetch.mockImplementation(async (url) => {
        const u = String(url);
        if (u.includes('/agents/all')) return served.agentsRes ?? json(served.agents ?? []);
        if (u.includes('/agents/memory/stats')) return served.memoryStats ?? json({ total: 3 });
        if (u.includes('/auth/organizations')) return served.orgs ?? json([{ id: 'org1', authMethod: null }]);
        if (u.includes('/ai/user-settings')) return json(served.userSettings ?? {});
        if (u.includes('/api/integrations/linkedin/status')) return json({ connected: false });
        if (u.includes('/auth/app-password-status')) return json({ hasAppPassword: false });
        if (u.includes('/api/integrations/github/status')) return json({ connected: !!served.githubConnected });
        throw new Error(`unrouted call: ${u}`);
    });
}

/** Flush the mount reads (the query cache notifies on a timer) and the effects they trigger. */
async function settle() {
    for (let i = 0; i < 8; i++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
}

async function mount({ user = MEMBER, path = '/app/settings', ...props } = {}) {
    window.history.replaceState({}, '', path);
    const view = renderWithClient(<AdvancedSettings user={user} {...props} />);
    await settle();
    return view;
}

/** A real click (pointer + mouse + click events), settled. */
const click = async (el) => { await userEvent.setup().click(el); };

const navEl = (c) => c.querySelector('div.flex-1.overflow-y-auto');
/** The top-level rows (NavItem), in render order. */
const topRows = (c) => [...navEl(c).children].filter(el => el.tagName === 'BUTTON').map(b => b.textContent.trim());
/** The top-level rows, split into groups at each thin rule. */
const topGroups = (c) => {
    const out = [[]];
    for (const el of navEl(c).children) {
        if (el.tagName === 'BUTTON') out[out.length - 1].push(el.textContent.trim());
        else if (el.tagName === 'DIV' && el.getAttribute('aria-hidden') === 'true') out.push([]);
    }
    return out.filter(g => g.length > 0);
};
/** The expanded organisation sub-items, in render order. */
const subRows = (c) => [...navEl(c).querySelectorAll('div.space-y-px.overflow-hidden button')].map(b => b.textContent.trim());
/** The expanded organisation sub-items, split into groups at each divider. */
const subGroups = (c) => {
    const box = navEl(c).querySelector('div.space-y-px.overflow-hidden');
    if (!box) return [];
    const out = [[]];
    for (const el of box.children) {
        if (el.tagName === 'BUTTON') out[out.length - 1].push(el.textContent.trim());
        else out.push([]);
    }
    return out;
};
const headers = (c) => [...navEl(c).querySelectorAll('p')].map(p => p.textContent.trim());
const rowByLabel = (c, label) => [...navEl(c).querySelectorAll('button')].find(b => b.textContent.trim() === label);
/** The user mini-card above the nav (the phone back button comes first in DOM order). */
const miniCard = (c) => [...c.querySelectorAll('button')].find(b => b.className.includes('py-3.5'));
const isActive = (btn) => btn.getAttribute('aria-current') === 'page';
const titleBar = (c) => c.querySelector('span.text-\\[15px\\]');
/** The testid of whatever the content panel is showing. */
const panel = () => {
    const el = document.querySelector('[data-testid^="section-"]');
    return el ? el.getAttribute('data-testid') : null;
};
const expand = (c) => click(rowByLabel(c, 'Organisation'));

beforeEach(() => {
    cleanup();
    vi.clearAllMocks();
    viewport = { isMobile: false, isCompact: false, isDesktop: true, width: 1920 };
    subscription = { hasActiveSub: true, sub: null, loading: false };
    capabilities = new Set(['learning_center', 'compliance_hub_gdpr', 'projects']);
    ceiling = new Set(['meeting_notes']);
    entitlementsLoading = false;
    entitlementsError = null;
    complianceCounts = null;
    countsHookOpts.length = 0;
    window.history.replaceState({}, '', '/app/settings');
    serve();
});

/* ══ Sidebar: the top-level rows ═════════════════════════════════════════ */
describe('AdvancedSettings — top-level nav rows', () => {
    it('shows the eight personal rows, in URL order, for an ordinary member', async () => {
        const { container } = await mount();
        expect(topRows(container)).toEqual([
            'Preferences', 'Appearance', 'Security', 'Memory', 'Notifications',
            'Connections', 'Learning Center', 'Help & Support',
        ]);
        expect(headers(container)).toEqual(['Personal']);
    });

    it('draws a thin rule above the resources (Learning Center, Help & Support), and only above them', async () => {
        const { container } = await mount();
        expect(topGroups(container)).toEqual([
            ['Preferences', 'Appearance', 'Security', 'Memory', 'Notifications', 'Connections'],
            ['Learning Center', 'Help & Support'],
        ]);
        cleanup();

        // Above whichever of the two is first on screen…
        const selfHosted = await mount({ user: { ...MEMBER, ...SELF_HOSTED } });
        expect(topGroups(selfHosted.container).at(-1)).toEqual(['Learning Center']);
        cleanup();

        // …and not at all when neither is.
        capabilities = new Set(['projects']);
        const neither = await mount({ user: { ...MEMBER, ...SELF_HOSTED } });
        expect(topGroups(neither.container)).toEqual([
            ['Preferences', 'Appearance', 'Security', 'Memory', 'Notifications', 'Connections'],
        ]);
    });

    it('drops Learning Center when the plan does not carry the capability', async () => {
        capabilities = new Set(['projects']);
        const { container } = await mount();
        expect(topRows(container)).not.toContain('Learning Center');
        expect(topRows(container)).toContain('Connections');
    });

    it('drops Notifications when Projects is not available, by plan or by operator switch', async () => {
        // Every switch on that page is a project event.
        capabilities = new Set(['learning_center']);
        const { container } = await mount();
        expect(topRows(container)).not.toContain('Notifications');
        expect(topRows(container)).toContain('Memory');
        cleanup();

        capabilities = new Set(['learning_center', 'projects']);
        const off = await mount({ user: { ...MEMBER, featureFlags: { projects: false } } });
        expect(topRows(off.container)).not.toContain('Notifications');
    });

    it('drops Help & Support on a self-hosted deployment', async () => {
        const { container } = await mount({ user: { ...MEMBER, ...SELF_HOSTED } });
        expect(topRows(container)).toEqual([
            'Preferences', 'Appearance', 'Security', 'Memory', 'Notifications', 'Connections', 'Learning Center',
        ]);
    });

    it('shows only the first row in Simple Mode — for an org admin too', async () => {
        const { container } = await mount({ user: { ...ORG_ADMIN, simpleMode: true, isConsumerAccount: true } });
        expect(topRows(container)).toEqual(['Preferences']);
        expect(headers(container)).toEqual(['Personal']);
        expect(topGroups(container)).toEqual([['Preferences']]);
    });

    it('hides Connections, Learning Center and the whole Organisation group on a phone', async () => {
        viewport = PHONE;
        const { container } = await mount({ user: ORG_ADMIN });
        expect(topGroups(container)).toEqual([
            ['Preferences', 'Appearance', 'Security', 'Memory', 'Notifications'],
            ['Help & Support'],
        ]);
        expect(headers(container)).toEqual(['Personal']);
    });
});

/* ══ Sidebar: accessibility and the tour anchor ══════════════════════════ */
describe('AdvancedSettings — what the sidebar tells assistive tech', () => {
    it('is a labelled navigation region whose open page is aria-current', async () => {
        const { container } = await mount({ path: '/app/settings/memory' });
        const nav = screen.getByRole('navigation', { name: 'Settings' });
        expect(nav).toBe(navEl(container));
        expect(rowByLabel(container, 'Memory').getAttribute('aria-current')).toBe('page');
        expect(rowByLabel(container, 'Preferences').hasAttribute('aria-current')).toBe(false);
    });

    it('titles every row with its full label, for the labels the narrow sidebar truncates', async () => {
        const { container } = await mount({ user: ORG_ADMIN, path: '/app/settings/organisation/info' });
        for (const btn of navEl(container).querySelectorAll('button')) {
            expect(btn.getAttribute('title')).toBe(btn.textContent.trim());
        }
    });

    it('renders the anchor the onboarding tour targets (settings-nav-preferences)', async () => {
        const { container } = await mount();
        expect(screen.getByTestId('settings-nav-preferences')).toBe(rowByLabel(container, 'Preferences'));
    });

    it('draws row states with the theme tokens, not an inline black tint', async () => {
        const { container } = await mount({ path: '/app/settings/memory' });
        const active = rowByLabel(container, 'Memory');
        const idle = rowByLabel(container, 'Appearance');
        expect(active.className).toContain('bg-[var(--item-active-bg)]');
        expect(idle.className).toContain('hover:bg-[var(--item-hover-bg)]');
        expect(active.getAttribute('style')).toBeNull();
        expect(idle.getAttribute('style')).toBeNull();
    });
});

/* ══ Sidebar: the Workspace group ════════════════════════════════════════ */
describe('AdvancedSettings — who gets the Organisation group', () => {
    it('gives an org admin the Workspace header and the Organisation parent row', async () => {
        const { container } = await mount({ user: ORG_ADMIN });
        expect(headers(container)).toEqual(['Personal', 'Workspace']);
        expect(topRows(container)).toContain('Organisation');
    });

    it('accepts the org_admin PERMISSION alone as well as the role', async () => {
        const { container } = await mount({ user: { ...MEMBER, permissions: ['org_admin'] } });
        expect(topRows(container)).toContain('Organisation');
    });

    it('gives a pure DPO the group with Compliance as its only entry', async () => {
        const { container } = await mount({ user: DPO });
        expect(headers(container)).toEqual(['Personal', 'Workspace']);
        expect(subRows(container)).toEqual([]);           // collapsed at first
        await expand(container);
        expect(subRows(container)).toEqual(['Compliance']);
    });

    it('withholds the group from a DPO whose org is below Enterprise', async () => {
        capabilities = new Set(['learning_center', 'projects']);      // no compliance_hub_gdpr
        const { container } = await mount({ user: DPO });
        expect(headers(container)).toEqual(['Personal']);
        expect(topRows(container)).not.toContain('Organisation');
    });

    it('withholds it from an ordinary member', async () => {
        const { container } = await mount();
        expect(topRows(container)).not.toContain('Organisation');
    });
});

/* ══ Sidebar: the org sub-items filter ═══════════════════════════════════ */
describe('AdvancedSettings — organisation sub-items', () => {
    it('lists the full cloud set for an org admin with every gate open, in topic order', async () => {
        serve({ githubConnected: true });
        const user = { ...ORG_ADMIN, permissions: ['org_admin', 'admin_compliance'], ncOrg: { instanceId: 'nc1' } };
        const { container } = await mount({ user });
        await expand(container);
        expect(subRows(container)).toEqual([
            'Organisation Info',
            'License & Usage',
            'Usage & Monitoring',
            'Users & Groups',
            // 'Sign-in Method' is absent: this org is NC-bound.
            'Academy',
            'Privacy Shield',
            'Encryption',
            'Compliance',
            'AI & Collaboration',
            'Answer Reuse',
            'Meeting Templates',
            'Integrations',
            'MCP Library',
            'MCP Access',
            'GitHub Sync',
            'Nextcloud Sync',
        ]);
    });

    it('is what a plain org admin sees, in five topic groups: no Compliance, no GitHub Sync, no Nextcloud Sync', async () => {
        const { container } = await mount({ user: ORG_ADMIN });
        await expand(container);
        expect(subGroups(container)).toEqual([
            ['Organisation Info', 'License & Usage', 'Usage & Monitoring'],
            ['Users & Groups', 'Sign-in Method', 'Academy'],
            ['Privacy Shield', 'Encryption'],
            ['AI & Collaboration', 'Answer Reuse', 'Meeting Templates'],
            ['Integrations', 'MCP Library', 'MCP Access'],
        ]);
    });

    it('hides Users & Groups from an org admin identified by PERMISSION only (wart)', async () => {
        // canSeeOrg accepts perms ['org_admin']; canManageUsers does not — it
        // wants 'all', 'manage_users', or an orgRole of admin/org_admin. So the
        // same account gets the Organisation group but no Users & Groups.
        const { container } = await mount({ user: { ...MEMBER, permissions: ['org_admin'] } });
        await expand(container);
        expect(subRows(container)).toContain('Organisation Info');
        expect(subRows(container)).not.toContain('Users & Groups');
    });

    it('hides Academy when the plan has no Learning Center', async () => {
        capabilities = new Set(['compliance_hub_gdpr', 'projects']);
        const { container } = await mount({ user: ORG_ADMIN });
        await expand(container);
        expect(subRows(container)).not.toContain('Academy');
        expect(subRows(container)).toContain('Integrations');
    });

    it('hides Meeting Templates when the plan ceiling has no Meeting Notes, and while it loads', async () => {
        // The page (templates and the Meet / Teams panels) is behind the
        // meeting_notes licence on the server: without it the page is empty.
        ceiling = new Set();
        const { container } = await mount({ user: ORG_ADMIN });
        await expand(container);
        expect(subRows(container)).not.toContain('Meeting Templates');
        expect(subRows(container)).toContain('Answer Reuse');
        cleanup();

        ceiling = new Set(['meeting_notes']);
        entitlementsLoading = true;
        const loading = await mount({ user: ORG_ADMIN, path: '/app/settings/organisation/info' });
        expect(subRows(loading.container)).not.toContain('Meeting Templates');
    });

    it('adds GitHub Sync only once the org has connected GitHub', async () => {
        serve({ githubConnected: true });
        const { container } = await mount({ user: ORG_ADMIN });
        await expand(container);
        expect(subRows(container)).toContain('GitHub Sync');
    });

    it('shows Nextcloud Sync to a super-admin whose own org is not NC-bound', async () => {
        const { container } = await mount({ user: SUPER_ADMIN });
        await expand(container);
        expect(subRows(container)).toContain('Nextcloud Sync');
    });

    it('hides Sign-in Method for a Nextcloud-connector user, NC org or not', async () => {
        const { container } = await mount({ user: { ...ORG_ADMIN, provider: 'nextcloud_connector' } });
        await expand(container);
        expect(subRows(container)).not.toContain('Sign-in Method');
        expect(subRows(container)).not.toContain('Nextcloud Sync');   // org itself is not NC-bound
    });

    it('hides Sign-in Method once the org has locked its auth method', async () => {
        serve({ orgs: json([{ id: 'org1', authMethod: 'password' }]) });
        const { container } = await mount({ user: ORG_ADMIN });
        await expand(container);
        expect(subRows(container)).not.toContain('Sign-in Method');
    });

    it('keeps Sign-in Method after the lock on self-hosted, where it also holds Allowed Domains', async () => {
        serve({ orgs: json([{ id: 'org1', authMethod: 'password' }]) });
        const { container } = await mount({ user: { ...ORG_ADMIN, ...SELF_HOSTED } });
        await expand(container);
        expect(subRows(container)).toContain('Sign-in Method');
    });

    it('swaps License & Usage for Azure Configuration on self-hosted', async () => {
        const { container } = await mount({
            user: { ...ORG_ADMIN, ...SELF_HOSTED },
            path: '/app/settings/preferences',
        });
        await expand(container);
        const rows = subRows(container);
        expect(rows).not.toContain('License & Usage');
        expect(rows[0]).toBe('Organisation Info');
        expect(rows[rows.length - 1]).toBe('Azure Configuration');
    });

    it('never asks for the org list when the user cannot see the org', async () => {
        await mount({ user: MEMBER });
        expect(authFetch.mock.calls.map(c => String(c[0]))).not.toContain('/auth/organizations');
    });

    it('SECURITY: a failing org-list call leaves Sign-in Method on the menu', async () => {
        // fetchOrgAuthLocked returns early on !res.ok, so orgAuthLocked stays
        // false — the menu is WIDER after a failed probe than after a
        // successful one that says "locked".
        serve({ orgs: json({ error: 'nope' }, false) });
        const { container } = await mount({ user: ORG_ADMIN });
        await expand(container);
        expect(subRows(container)).toContain('Sign-in Method');
    });

    it('SECURITY: with no organizationId it reads the FIRST org in the response', async () => {
        // orgs[0] is a fallback for "which org am I in?" — for a super-admin
        // the list is every org on the deployment, so a foreign org's
        // authMethod decides whether this menu entry is shown.
        serve({ orgs: json([{ id: 'other-org', authMethod: 'sso' }, { id: 'mine', authMethod: null }]) });
        const { container } = await mount({ user: { ...SUPER_ADMIN, organizationId: undefined } });
        await expand(container);
        expect(subRows(container)).not.toContain('Sign-in Method');
    });
});

/* ══ Sidebar: the consumer group ═════════════════════════════════════════ */
describe('AdvancedSettings — consumer account group', () => {
    it('shows the five account rows for an org-less cloud user', async () => {
        const { container } = await mount({ user: CONSUMER });
        expect(headers(container)).toEqual(['Personal', 'Account']);
        expect(topRows(container).slice(-5)).toEqual([
            'License & Usage', 'Privacy Shield', 'Usage & Monitoring', 'Integrations', 'Beta Features',
        ]);
    });

    it('drops them again as soon as the same account can see an org', async () => {
        const { container } = await mount({ user: { ...CONSUMER, permissions: ['org_admin'] } });
        expect(headers(container)).toEqual(['Personal', 'Workspace']);
        expect(topRows(container)).not.toContain('Beta Features');
    });

    it('hides them on a phone', async () => {
        viewport = PHONE;
        const { container } = await mount({ user: CONSUMER });
        expect(headers(container)).toEqual(['Personal']);
    });
});

/* ══ Which panel a segment opens ═════════════════════════════════════════ */
describe('AdvancedSettings — the panel a segment opens', () => {
    const cases = [
        ['/app/settings/preferences', 'section-preferences'],
        ['/app/settings/appearance', 'section-appearance'],
        ['/app/settings/security', 'section-security'],
        ['/app/settings/memory', 'section-memory'],
        ['/app/settings/notifications', 'section-notifications'],
        ['/app/settings/integrations', 'section-integrations'],
        ['/app/settings/learning', 'section-learning'],
        ['/app/settings/help_support', 'section-help'],
    ];
    for (const [path, testid] of cases) {
        it(`opens ${testid} on ${path}`, async () => {
            await mount({ path });
            expect(panel()).toBe(testid);
        });
    }

    it('opens Preferences on an unknown segment, and marks that row active', async () => {
        const { container } = await mount({ path: '/app/settings/not-a-section-2026' });
        expect(panel()).toBe('section-preferences');
        expect(isActive(rowByLabel(container, 'Preferences'))).toBe(true);
        expect(isActive(rowByLabel(container, 'Memory'))).toBe(false);
        // The bogus segment is left in the address bar — nothing rewrites it.
        expect(window.location.pathname).toBe('/app/settings/not-a-section-2026');
    });

    it('renders the consumer panels only for a consumer account', async () => {
        await mount({ user: CONSUMER, path: '/app/settings/account/beta' });
        expect(panel()).toBe('section-consumer-beta');
        cleanup();
        await mount({ user: MEMBER, path: '/app/settings/account/beta' });
        expect(panel()).toBeNull();
    });

    it('renders nothing on an organisation deep link for a member', async () => {
        await mount({ user: MEMBER, path: '/app/settings/organisation/info' });
        expect(panel()).toBeNull();
    });

    it('maps each org sub-tab onto the activeSection OrganisationSection expects', async () => {
        const map = [
            ['/app/settings/organisation/users', 'users'],
            ['/app/settings/organisation/academy', 'academy'],
            ['/app/settings/organisation/integrations', 'integrations'],
            ['/app/settings/organisation/usage', 'usage'],
            ['/app/settings/organisation/github-sync', 'github_sync'],
            ['/app/settings/organisation/nextcloud-sync', 'nextcloud_sync'],
            ['/app/settings/organisation/meeting-templates', 'meeting_templates'],
            ['/app/settings/organisation/license', 'license'],
            ['/app/settings/organisation/info', 'info'],
            ['/app/settings/organisation/ai-context', 'ai_context'],
            ['/app/settings/organisation/integration-cache', 'integration_cache'],
        ];
        for (const [path, active] of map) {
            await mount({ user: SUPER_ADMIN, path });
            expect(screen.getByTestId('section-organisation').dataset.active, path).toBe(active);
            cleanup();
        }
    });

    it('still renders Meeting Templates on a deep link when its row is hidden', async () => {
        ceiling = new Set();
        await mount({ user: ORG_ADMIN, path: '/app/settings/organisation/meeting-templates' });
        expect(screen.getByTestId('section-organisation').dataset.active).toBe('meeting_templates');
    });

    it('passes the deep usage segment through as the initial report', async () => {
        await mount({ user: SUPER_ADMIN, path: '/app/settings/organisation/usage/safety' });
        const el = screen.getByTestId('section-organisation');
        expect(el.dataset.active).toBe('usage');
        expect(el.dataset.report).toBe('safety');
    });

    it('opens the Azure panel on its own segment, not OrganisationSection', async () => {
        await mount({ user: { ...ORG_ADMIN, ...SELF_HOSTED }, path: '/app/settings/organisation/azure' });
        expect(panel()).toBe('section-azure');
    });

    it('resolves an unknown organisation sub-segment to the License section', async () => {
        await mount({ user: ORG_ADMIN, path: '/app/settings/organisation/does-not-exist' });
        // settingsTabFromPath maps an unknown org segment to the 'license' TAB,
        // so this lands in the `isOrgSubTab` branch. Nothing ever sets
        // activeTab to 'organisation': the parent row only toggles the
        // accordion.
        expect(screen.getByTestId('section-organisation').dataset.active).toBe('license');
    });

    it('hands Preferences an empty list when the agents call is refused, never the error body', async () => {
        // The old loader never checked res.ok: a 500's error BODY landed in `agents`,
        // and PreferencesSection calls agents.map() once the startup mode is 'specific'.
        serve({ agentsRes: json({ error: 'boom' }, false) });
        await mount({ path: '/app/settings/preferences' });
        expect(screen.getByTestId('section-preferences').dataset.agents).toBe('[]');
    });
});

/* ══ Compliance ══════════════════════════════════════════════════════════ */
describe('AdvancedSettings — Compliance Center', () => {
    it('wraps the hub in the enterprise tier gate and passes the deep segments', async () => {
        await mount({ user: { ...ORG_ADMIN, permissions: ['org_admin', 'admin_compliance'] },
            path: '/app/settings/organisation/compliance/dsr/req%2F7' });
        const gate = screen.getByTestId('require-tier');
        expect(gate.dataset.tier).toBe('enterprise');
        expect(gate.dataset.feature).toBe('compliance_hub_gdpr');
        const hub = screen.getByTestId('section-compliance');
        expect(hub.dataset.section).toBe('dsr');
        expect(hub.dataset.check).toBe('req/7');
        expect(gate.contains(hub)).toBe(true);
    });

    it('defaults the hub to its overview section', async () => {
        await mount({ user: DPO, path: '/app/settings/organisation/compliance' });
        expect(screen.getByTestId('section-compliance').dataset.section).toBe('overview');
        expect(screen.getByTestId('section-compliance').dataset.check).toBe('null');
    });

    it('renders nothing for a user without admin_compliance', async () => {
        await mount({ user: ORG_ADMIN, path: '/app/settings/organisation/compliance' });
        expect(panel()).toBeNull();
    });

    it('SECURITY: renders on a deep link even though the nav row is hidden below Enterprise', async () => {
        // showComplianceNav = RBAC && capability, but renderContent only asks
        // for the RBAC half — the licence half is left to RequireTier, which
        // is the component that fails OPEN when entitlements are unavailable.
        capabilities = new Set([]);
        const { container } = await mount({ user: DPO, path: '/app/settings/organisation/compliance' });
        expect(topRows(container)).not.toContain('Organisation');
        expect(screen.getByTestId('section-compliance')).toBeInTheDocument();
    });

    it('keeps compliance-internal navigation on the settings surface', async () => {
        await mount({ user: DPO, path: '/app/settings/organisation/compliance' });
        await click(screen.getByText('go-dsr'));
        expect(window.location.pathname).toBe('/app/settings/organisation/compliance/dsr/req%2F7');
        const hub = screen.getByTestId('section-compliance');
        expect(hub.dataset.section).toBe('dsr');
        expect(hub.dataset.check).toBe('req/7');
    });

    it('keeps the hub tab in the pushed URL, and a redirect replaces the entry instead of adding one', async () => {
        const user = userEvent.setup();
        await mount({ user: DPO, path: '/app/settings/organisation/compliance' });
        const before = window.history.length;
        await user.click(screen.getByText('go-calendar'));
        expect(window.location.pathname + window.location.search).toBe('/app/settings/organisation/compliance/frameworks?tab=calendar');
        expect(screen.getByTestId('section-compliance').dataset.section).toBe('frameworks');
        expect(window.history.length).toBe(before + 1);
        await user.click(screen.getByText('go-redirect'));
        expect(window.location.pathname + window.location.search).toBe('/app/settings/organisation/compliance/training');
        expect(window.history.length).toBe(before + 1);
    });

    it('lands a guardrails remediation link on Organisation → Privacy', async () => {
        const onNavigate = vi.fn();
        await mount({ user: { ...ORG_ADMIN, permissions: ['org_admin', 'admin_compliance'] },
            path: '/app/settings/organisation/compliance', onNavigate });
        await click(screen.getByText('go-guardrails'));
        expect(window.location.pathname).toBe('/app/settings/organisation/privacy');
        expect(screen.getByTestId('section-organisation').dataset.active).toBe('privacy');
        expect(onNavigate).not.toHaveBeenCalled();
    });

    it('forwards the same link to the app router when the user cannot see the org', async () => {
        const onNavigate = vi.fn();
        await mount({ user: DPO, path: '/app/settings/organisation/compliance', onNavigate });
        await click(screen.getByText('go-guardrails'));
        expect(onNavigate).toHaveBeenCalledWith('admin/security/guardrails');
        expect(window.location.pathname).toBe('/app/settings/organisation/compliance');
    });

    it('forwards unmapped admin paths to the app router', async () => {
        const onNavigate = vi.fn();
        await mount({ user: DPO, path: '/app/settings/organisation/compliance', onNavigate });
        await click(screen.getByText('go-agents'));
        expect(onNavigate).toHaveBeenCalledWith('admin/agents');
    });
});

/* ══ Compliance on a phone ═══════════════════════════════════════════════ */
describe('AdvancedSettings — Compliance is the one org section a phone keeps', () => {
    it('promotes it to a top-level row, among the settings, while the Organisation group stays hidden', async () => {
        viewport = PHONE;
        const { container } = await mount({ user: { ...ORG_ADMIN, permissions: ['org_admin', 'admin_compliance'] } });
        // A setting, so above the rule that sets the resources apart.
        expect(topGroups(container)).toEqual([
            ['Preferences', 'Appearance', 'Security', 'Memory', 'Notifications', 'Compliance'],
            ['Help & Support'],
        ]);
        // The group around it is still gone: no Workspace header, no accordion.
        expect(headers(container)).toEqual(['Personal']);
        expect(topRows(container)).not.toContain('Organisation');
    });

    it('gives a pure DPO the row too — the section is theirs, not the org admin\'s', async () => {
        viewport = PHONE;
        const { container } = await mount({ user: DPO });
        expect(topRows(container)).toContain('Compliance');
    });

    it('withholds the row below Enterprise and from a user without the permission', async () => {
        viewport = PHONE;
        capabilities = new Set([]);
        const { container: noLicence } = await mount({ user: DPO });
        expect(topRows(noLicence)).not.toContain('Compliance');

        cleanup();
        capabilities = new Set(['compliance_hub_gdpr']);
        const { container: noRbac } = await mount({ user: ORG_ADMIN });
        expect(topRows(noRbac)).not.toContain('Compliance');
    });

    it('keeps the row out of Simple Mode with the rest of the sidebar', async () => {
        viewport = PHONE;
        const { container } = await mount({ user: { ...DPO, simpleMode: true } });
        expect(topRows(container)).toEqual(['Preferences']);
    });

    it('draws the row icon in the compliance kind token, not a hex green', async () => {
        viewport = PHONE;
        const { container } = await mount({ user: DPO });
        const icon = rowByLabel(container, 'Compliance').querySelector('svg');
        expect(icon.getAttribute('class')).toContain('text-[var(--kind-compliance)]');
        expect(icon.getAttribute('style') ?? '').not.toMatch(/#[0-9a-f]{3,8}/i);
    });

    it('opens the hub on a tap, straight into the phone detail view', async () => {
        viewport = PHONE;
        const { container } = await mount({ user: DPO });
        await click(rowByLabel(container, 'Compliance'));
        expect(window.location.pathname).toBe('/app/settings/organisation/compliance');
        expect(panel()).toBe('section-compliance');
        expect(navEl(container).closest('div.flex-shrink-0').className).toContain('hidden md:flex');
    });

    it('no longer bounces the deep link to Preferences', async () => {
        viewport = PHONE;
        await mount({ user: DPO, path: '/app/settings/organisation/compliance/dsr' });
        expect(window.location.pathname).toBe('/app/settings/organisation/compliance/dsr');
        expect(screen.getByTestId('section-compliance').dataset.section).toBe('dsr');
    });

    it('still bounces every OTHER organisation deep link on a phone', async () => {
        viewport = PHONE;
        await mount({ user: { ...ORG_ADMIN, permissions: ['org_admin', 'admin_compliance'] }, path: '/app/settings/organisation/users' });
        expect(panel()).toBe('section-preferences');
    });

    it('hands the hub a way back to the section list and suppresses its own title bar', async () => {
        viewport = PHONE;
        const { container } = await mount({ user: DPO });
        // A deep link lands on the section LIST like every other phone deep
        // link; the detail view is what the tap opens.
        await click(rowByLabel(container, 'Compliance'));
        // The settings 48px bar (and its ArrowLeft) is gone — the hub draws one.
        expect(screen.queryByLabelText('Back')).toBeNull();
        expect(titleBar(container)).toBeNull();

        // ...and the onBack it was given returns to the list, where the bar is back.
        await click(screen.getByText('hub-back'));
        expect(screen.getByLabelText('Back')).toBeInTheDocument();
        expect(titleBar(container).textContent).toBe('Settings');
    });

    it('keeps the settings title bar on the phone section LIST, and on desktop', async () => {
        viewport = PHONE;
        const { container } = await mount({ user: DPO });
        expect(screen.getByLabelText('Back')).toBeInTheDocument();
        expect(titleBar(container).textContent).toBe('Settings');

        cleanup();
        viewport = { isMobile: false, isCompact: false, isDesktop: true, width: 1920 };
        const { container: desktop } = await mount({ user: DPO, path: '/app/settings/organisation/compliance' });
        expect(titleBar(desktop).textContent).toBe('Settings');
        expect(screen.getByTestId('section-compliance').dataset.onback).toBe('null');
    });
});

/* ══ The Compliance count badge ══════════════════════════════════════════ */
describe('AdvancedSettings — the count badge on the Compliance row', () => {
    it('asks for the one key it shows, once, without a poll', async () => {
        await mount({ user: DPO });
        expect(countsHookOpts[0]).toEqual({ enabled: true, poll: false, keys: ['attention_open'] });
    });

    it('does not ask at all when the row is not shown', async () => {
        capabilities = new Set([]);
        await mount({ user: MEMBER });
        expect(countsHookOpts.every(o => o.enabled === false)).toBe(true);
    });

    it('renders the open count on the desktop sub-item', async () => {
        complianceCounts = { attention_open: 3 };
        const { container } = await mount({ user: DPO, path: '/app/settings/organisation/compliance' });
        expect(screen.getByTestId('nav-compliance-count')).toHaveTextContent('3');
        // On the Compliance row itself, not loose in the sidebar.
        expect(rowByLabel(container, 'Compliance3')).toBeTruthy();
    });

    it('renders it on the phone row too', async () => {
        viewport = PHONE;
        complianceCounts = { attention_open: 12 };
        await mount({ user: DPO });
        expect(screen.getByTestId('nav-compliance-count')).toHaveTextContent('12');
    });

    it('shows NOTHING while the count is unknown, and nothing at zero', async () => {
        complianceCounts = null;                       // endpoint has not answered
        await mount({ user: DPO, path: '/app/settings/organisation/compliance' });
        expect(screen.queryByTestId('nav-compliance-count')).toBeNull();

        cleanup();
        complianceCounts = {};                          // answered, key withheld
        await mount({ user: DPO, path: '/app/settings/organisation/compliance' });
        expect(screen.queryByTestId('nav-compliance-count')).toBeNull();

        cleanup();
        complianceCounts = { attention_open: 0 };       // answered: nothing to do
        await mount({ user: DPO, path: '/app/settings/organisation/compliance' });
        expect(screen.queryByTestId('nav-compliance-count')).toBeNull();
    });

    it('leaves every other sub-item without a badge', async () => {
        complianceCounts = { attention_open: 3 };
        const { container } = await mount({ user: { ...ORG_ADMIN, permissions: ['org_admin', 'admin_compliance'] },
            path: '/app/settings/organisation/info' });
        expect(subRows(container).filter(r => /\d/.test(r))).toEqual(['Compliance3']);
    });
});

/* ══ Deep links the nav filter hides ═════════════════════════════════════ */
describe('AdvancedSettings — deep links to sub-tabs the sidebar hides', () => {
    it('SECURITY: /organisation/users renders for an org admin without manage_users', async () => {
        const user = { ...MEMBER, permissions: ['org_admin'] };   // canSeeOrg, not canManageUsers
        const { container } = await mount({ user, path: '/app/settings/organisation/users' });
        // The deep link expands the accordion by itself.
        expect(subRows(container)).not.toContain('Users & Groups');
        // …and the panel behind the hidden row renders anyway.
        expect(screen.getByTestId('section-organisation').dataset.active).toBe('users');
    });

    it('SECURITY: /organisation/auth renders after the org locked its sign-in method', async () => {
        serve({ orgs: json([{ id: 'org1', authMethod: 'sso' }]) });
        const { container } = await mount({ user: ORG_ADMIN, path: '/app/settings/organisation/auth' });
        expect(subRows(container)).not.toContain('Sign-in Method');
        expect(screen.getByTestId('section-organisation').dataset.active).toBe('auth');
    });

    it('SECURITY: /organisation/academy renders without the Learning Center capability', async () => {
        capabilities = new Set([]);
        const { container } = await mount({ user: ORG_ADMIN, path: '/app/settings/organisation/academy' });
        expect(subRows(container)).not.toContain('Academy');
        expect(screen.getByTestId('section-organisation').dataset.active).toBe('academy');
    });
});

/* ══ The bounces ═════════════════════════════════════════════════════════ */
describe('AdvancedSettings — bounces', () => {
    it('bounces Simple Mode off any other section, and rewrites the URL', async () => {
        await mount({ user: { ...MEMBER, simpleMode: true }, path: '/app/settings/appearance' });
        expect(panel()).toBe('section-preferences');
        expect(window.location.pathname).toBe('/app/settings/preferences');
    });

    it('bounces help_support on self-hosted', async () => {
        await mount({ user: { ...MEMBER, ...SELF_HOSTED }, path: '/app/settings/help_support' });
        expect(panel()).toBe('section-preferences');
        expect(window.location.pathname).toBe('/app/settings/preferences');
    });

    it('bounces the per-org licence page on self-hosted to the first row the sidebar draws', async () => {
        await mount({ user: { ...ORG_ADMIN, ...SELF_HOSTED }, path: '/app/settings/organisation/license' });
        expect(window.location.pathname).toBe('/app/settings/organisation/info');
        expect(screen.getByTestId('section-organisation').dataset.active).toBe('info');
    });

    it('bounces /learning to Preferences when the capability is off', async () => {
        // The welcome email links here (BFSF-279); a plan without the Learning
        // Center must not land on an empty panel.
        capabilities = new Set(['projects']);
        await mount({ path: '/app/settings/learning' });
        expect(panel()).toBe('section-preferences');
        expect(window.location.pathname).toBe('/app/settings/preferences');
    });

    it('keeps /learning while the entitlements are still loading', async () => {
        capabilities = new Set([]);
        entitlementsLoading = true;
        await mount({ path: '/app/settings/learning' });
        expect(panel()).toBeNull();
        expect(window.location.pathname).toBe('/app/settings/learning');
    });

    it('bounces /notifications to Preferences without Projects, once the licence is known', async () => {
        capabilities = new Set(['learning_center']);
        entitlementsLoading = true;
        await mount({ path: '/app/settings/notifications' });
        // Still loading: the address stays, and no project switches render.
        expect(window.location.pathname).toBe('/app/settings/notifications');
        expect(panel()).toBeNull();
        cleanup();

        entitlementsLoading = false;
        await mount({ path: '/app/settings/notifications' });
        expect(panel()).toBe('section-preferences');
        expect(window.location.pathname).toBe('/app/settings/preferences');
    });

    it('fails OPEN when the entitlements could not be read: no bounce, and the rows stay', async () => {
        // A resolver outage says nothing about the plan; hiding pages from
        // everyone during one is worse than showing a page the server refuses.
        capabilities = new Set(['learning_center']);
        ceiling = new Set();
        entitlementsError = 'HTTP 503';
        const { container } = await mount({ user: ORG_ADMIN, path: '/app/settings/notifications' });
        expect(window.location.pathname).toBe('/app/settings/notifications');
        expect(panel()).toBe('section-notifications');
        expect(topRows(container)).toContain('Notifications');
        await click(rowByLabel(container, 'Organisation'));
        expect(subRows(container)).toContain('Meeting Templates');
    });

    it('bounces a desktop-only tab on a phone', async () => {
        viewport = PHONE;
        await mount({ path: '/app/settings/integrations' });
        expect(panel()).toBe('section-preferences');
        expect(window.location.pathname).toBe('/app/settings/preferences');
    });

    it('bounces an organisation deep link on a phone', async () => {
        viewport = PHONE;
        await mount({ user: ORG_ADMIN, path: '/app/settings/organisation/users' });
        expect(panel()).toBe('section-preferences');
        expect(window.location.pathname).toBe('/app/settings/preferences');
    });

    it('exempts the licence page on a phone when the org has no active plan', async () => {
        subscription = { hasActiveSub: false, sub: null, loading: false };
        viewport = PHONE;
        await mount({ user: ORG_ADMIN, path: '/app/settings/organisation/license' });
        expect(window.location.pathname).toBe('/app/settings/organisation/license');
        expect(screen.getByTestId('section-organisation').dataset.active).toBe('license');
    });

    it('exempts a consumer\'s licence page on a phone: the Stripe return keeps its result', async () => {
        viewport = PHONE;
        const { container } = await mount({ user: CONSUMER, path: '/app/settings/account/license' });
        expect(window.location.pathname).toBe('/app/settings/account/license');
        expect(panel()).toBe('section-consumer-license');
        // Straight into the detail view, titled with the page.
        expect(navEl(container).closest('div.flex-shrink-0').className).toContain('hidden md:flex');
        expect(titleBar(container).textContent).toBe('License & Usage');
        // The account rows themselves stay off the phone.
        expect(headers(container)).toEqual(['Personal']);
    });

    it('still bounces the consumer licence page on a phone for an account that is not a consumer', async () => {
        viewport = PHONE;
        await mount({ user: MEMBER, path: '/app/settings/account/license' });
        expect(panel()).toBe('section-preferences');
        expect(window.location.pathname).toBe('/app/settings/preferences');
    });

    it('leaves a phone with no plan and no org rights on a blank screen (wart)', async () => {
        // The bounce exempts 'license' for a no-plan org, the sidebar is
        // pushed into detail view by the same condition, and renderContent
        // returns null because the user is not an org admin: back button,
        // title, nothing else.
        subscription = { hasActiveSub: false, sub: null, loading: false };
        viewport = PHONE;
        const { container } = await mount({ user: MEMBER, path: '/app/settings/organisation/license' });
        expect(panel()).toBeNull();
        expect(navEl(container).closest('div.flex-shrink-0').className).toContain('hidden md:flex');
        expect(titleBar(container)).toBeTruthy();
    });
});

/* ══ The Organisation accordion ══════════════════════════════════════════ */
describe('AdvancedSettings — the Organisation accordion', () => {
    it('starts expanded on an org deep link, and says so', async () => {
        const { container } = await mount({ user: ORG_ADMIN, path: '/app/settings/organisation/info' });
        expect(subRows(container)).toContain('Organisation Info');
        const parent = rowByLabel(container, 'Organisation');
        expect(isActive(parent)).toBe(false);
        expect(parent.getAttribute('aria-expanded')).toBe('true');
        expect(parent.getAttribute('aria-controls')).toBe('settings-org-subnav');
        expect(container.querySelector('#settings-org-subnav')).toBe(navEl(container).querySelector('div.space-y-px.overflow-hidden'));
        expect(isActive(rowByLabel(container, 'Organisation Info'))).toBe(true);
    });

    it('expands and auto-selects the first row the sidebar draws on the parent click', async () => {
        const { container } = await mount({ user: ORG_ADMIN, path: '/app/settings/preferences' });
        expect(subRows(container)).toEqual([]);
        expect(rowByLabel(container, 'Organisation').getAttribute('aria-expanded')).toBe('false');
        await expand(container);
        expect(window.location.pathname).toBe('/app/settings/organisation/info');
        expect(screen.getByTestId('section-organisation').dataset.active).toBe('info');
        expect(subRows(container).length).toBeGreaterThan(5);
    });

    it('only collapses when clicked on an org page: the page stays, and the parent row carries it', async () => {
        const { container } = await mount({ user: ORG_ADMIN, path: '/app/settings/organisation/usage' });
        await expand(container);
        expect(window.location.pathname).toBe('/app/settings/organisation/usage');
        expect(screen.getByTestId('section-organisation').dataset.active).toBe('usage');
        expect(subRows(container)).toEqual([]);
        const parent = rowByLabel(container, 'Organisation');
        expect(isActive(parent)).toBe(true);
        expect(parent.getAttribute('aria-expanded')).toBe('false');

        // Opening it again selects nothing new either.
        await expand(container);
        expect(window.location.pathname).toBe('/app/settings/organisation/usage');
        expect(isActive(rowByLabel(container, 'Usage & Monitoring'))).toBe(true);
    });

    it('marks the parent row active only while it is collapsed on a sub-tab', async () => {
        const { container } = await mount({ user: ORG_ADMIN, path: '/app/settings/preferences' });
        await expand(container);            // expand + select Organisation Info
        expect(isActive(rowByLabel(container, 'Organisation'))).toBe(false);
        expect(isActive(rowByLabel(container, 'Organisation Info'))).toBe(true);
    });

    it('re-expands itself when the active tab comes back to an org sub-tab', async () => {
        const { container } = await mount({ user: ORG_ADMIN, path: '/app/settings/organisation/info' });
        await expand(container);                                     // collapse, stay on Info
        await click(rowByLabel(container, 'Memory'));
        window.history.replaceState({}, '', '/app/settings/organisation/usage');
        await act(async () => { window.dispatchEvent(new PopStateEvent('popstate')); });
        expect(subRows(container)).toContain('Usage & Monitoring');
    });

    it('gives AI & Collaboration and Answer Reuse an address of their own', async () => {
        // Both rows used to fall back to the bare /app/settings, so a reload
        // or Back landed on Preferences.
        const { container } = await mount({ user: ORG_ADMIN, path: '/app/settings/organisation/info' });
        await click(rowByLabel(container, 'AI & Collaboration'));
        expect(window.location.pathname).toBe('/app/settings/organisation/ai-context');
        expect(screen.getByTestId('section-organisation').dataset.active).toBe('ai_context');
        await click(rowByLabel(container, 'Answer Reuse'));
        expect(window.location.pathname).toBe('/app/settings/organisation/integration-cache');
        expect(screen.getByTestId('section-organisation').dataset.active).toBe('integration_cache');
    });
});

/* ══ History, master–detail and the title bar ════════════════════════════ */
describe('AdvancedSettings — navigation mechanics', () => {
    it('pushes the tab URL on a nav click and switches the panel', async () => {
        const { container } = await mount();
        await click(rowByLabel(container, 'Memory'));
        expect(window.location.pathname).toBe('/app/settings/memory');
        expect(panel()).toBe('section-memory');
        expect(isActive(rowByLabel(container, 'Memory'))).toBe(true);
    });

    it('follows back/forward through popstate', async () => {
        await mount({ path: '/app/settings/memory' });
        window.history.replaceState({}, '', '/app/settings/appearance');
        await act(async () => { window.dispatchEvent(new PopStateEvent('popstate')); });
        expect(panel()).toBe('section-appearance');
    });

    it('keeps the current tab when popstate lands outside the settings tree', async () => {
        await mount({ path: '/app/settings/memory' });
        window.history.replaceState({}, '', '/app/studio');
        await act(async () => { window.dispatchEvent(new PopStateEvent('popstate')); });
        expect(panel()).toBe('section-memory');
    });

    it('resets the org deep segments on any nav click', async () => {
        await mount({ user: SUPER_ADMIN, path: '/app/settings/organisation/usage/safety' });
        expect(screen.getByTestId('section-organisation').dataset.report).toBe('safety');
        await click(screen.getByText('Usage & Monitoring'));
        expect(screen.getByTestId('section-organisation').dataset.report).toBe('');
    });

    it('opens Preferences from the user mini-card', async () => {
        const { container } = await mount({ path: '/app/settings/memory' });
        await click(miniCard(container));
        expect(panel()).toBe('section-preferences');
        expect(window.location.pathname).toBe('/app/settings/preferences');
    });

    it('titles the bar "Settings" on desktop, whatever the section', async () => {
        const { container } = await mount({ path: '/app/settings/memory' });
        expect(titleBar(container).textContent).toBe('Settings');
        expect(screen.queryByText('Memory', { selector: 'span.text-\\[15px\\]' })).toBeNull();
    });

    it('drills into a section on a phone and titles the bar with it', async () => {
        viewport = PHONE;
        const { container } = await mount();
        expect(titleBar(container).textContent).toBe('Settings');
        await click(rowByLabel(container, 'Memory'));
        expect(titleBar(container).textContent).toBe('Memory');
    });

    it('walks the phone back button from detail to list to onClose', async () => {
        viewport = PHONE;
        const onClose = vi.fn();
        const { container } = await mount({ onClose });
        const back = screen.getByLabelText('Back');

        await click(rowByLabel(container, 'Memory'));
        await click(back);                           // detail → list
        expect(onClose).not.toHaveBeenCalled();
        expect(titleBar(container).textContent).toBe('Settings');
        await click(back);                           // list → out of settings
        expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('falls back to an Escape keydown when no onClose is given', async () => {
        viewport = PHONE;
        const keys = [];
        const listener = e => keys.push(e.key);
        window.addEventListener('keydown', listener);
        await mount();
        await click(screen.getByLabelText('Back'));
        expect(keys).toEqual(['Escape']);
        window.removeEventListener('keydown', listener);
    });

    it('titles a phone detail view with an org sub-tab\'s own label', async () => {
        // The licence exemption puts a phone straight into detail view on an
        // org sub-tab, which has no top-level row; the title is still the
        // page's name.
        subscription = { hasActiveSub: false, sub: null, loading: false };
        viewport = PHONE;
        const { container } = await mount({ user: ORG_ADMIN, path: '/app/settings/organisation/license' });
        expect(titleBar(container).textContent).toBe('License & Usage');
    });
});

/* ══ The mini-card, the footer and the memory overlay ════════════════════ */
describe('AdvancedSettings — chrome', () => {
    it('shows the display name and the role badge from the org roles', async () => {
        const { container } = await mount({ user: ORG_ADMIN });
        const card = miniCard(container);
        expect(card.textContent).toContain('Tom Smit');
        expect(card.textContent).toContain('Organisation Admin');
    });

    it('names the two compliance roles the old table lacked', async () => {
        const { container } = await mount({ user: { ...MEMBER, orgRole: 'dpo' } });
        expect(miniCard(container).textContent).toContain('Data Protection Officer');
        cleanup();
        const auditor = await mount({ user: { ...MEMBER, orgRole: 'isms_auditor' } });
        expect(miniCard(auditor.container).textContent).toContain('ISMS Internal Auditor');
    });

    it('shows an unmapped role as its raw name, prettified', async () => {
        const { container } = await mount({ user: { ...MEMBER, orgRole: 'team_lead' } });
        expect(miniCard(container).textContent).toContain('Team Lead');
    });

    it('draws the admin chip in the success tokens and the others muted, without inline colours', async () => {
        const { container } = await mount({ user: ORG_ADMIN });
        const chip = [...miniCard(container).querySelectorAll('span')].find(s => s.textContent === 'Organisation Admin');
        expect(chip.className).toContain('text-[var(--success-ink)]');
        expect(chip.getAttribute('style')).toBeNull();
        cleanup();
        const member = await mount({ user: MEMBER });
        const plain = [...miniCard(member.container).querySelectorAll('span')].find(s => s.textContent === 'Member');
        expect(plain.className).toContain('text-[var(--text-muted)]');
    });

    it('falls back to the username, then to "User", and drops the badge with no role', async () => {
        const { container } = await mount({ user: { username: 'tom', permissions: [] } });
        expect(miniCard(container).textContent).toBe('Ttom');   // avatar initial + name, no badge
        cleanup();
        const second = await mount({ user: { permissions: [] } });
        expect(miniCard(second.container).textContent).toBe('UUser');
    });

    it('renders the avatar as an emoji, an image or an initial', async () => {
        const { container, unmount } = await mount({ user: { ...MEMBER, avatarType: 'emoji', avatar: '🐝' } });
        expect(container.textContent).toContain('🐝');
        unmount();

        const withUrl = await mount({ user: { ...MEMBER, avatarType: 'url', avatar: 'https://x/a.png' } });
        expect(withUrl.container.querySelector('img[alt="Avatar"]').getAttribute('src')).toBe('https://x/a.png');
        cleanup();

        const plain = await mount({ user: { ...MEMBER, displayName: 'zoe' } });
        expect(miniCard(plain.container).textContent).toContain('Z');
    });

    it('survives a missing user: member surface, "User" in the card', async () => {
        const { container } = await mount({ user: null });
        expect(topRows(container)).toEqual([
            'Preferences', 'Appearance', 'Security', 'Memory', 'Notifications',
            'Connections', 'Learning Center', 'Help & Support',
        ]);
        expect(headers(container)).toEqual(['Personal']);
        expect(miniCard(container).textContent).toBe('UUser');
        expect(panel()).toBe('section-preferences');
        // No org means no org-list probe either.
        expect(authFetch.mock.calls.map(c => String(c[0]))).not.toContain('/auth/organizations');
    });

    it('widens the content column for the org and consumer account pages only', async () => {
        const widthOf = () => document.querySelector('[data-testid^="section-"]').parentElement;

        await mount({ path: '/app/settings/preferences' });
        expect(widthOf().className).toContain('max-w-[640px]');
        cleanup();

        await mount({ user: SUPER_ADMIN, path: '/app/settings/organisation/info' });
        expect(widthOf().className).toContain('max-w-5xl');
        cleanup();

        // Every consumer page, the licence plan grid included.
        for (const seg of ['license', 'privacy', 'usage', 'integrations', 'beta']) {
            await mount({ user: CONSUMER, path: `/app/settings/account/${seg}` });
            expect(widthOf().className, seg).toContain('max-w-5xl');
            cleanup();
        }

        await mount({ user: SUPER_ADMIN, path: '/app/settings/organisation/usage' });
        expect(widthOf().style.maxWidth).toBe('100%');
        expect(widthOf().style.padding).toBe('24px 32px 32px');
        cleanup();

        await mount({ user: SUPER_ADMIN, path: '/app/settings/organisation/compliance' });
        const gate = document.querySelector('[data-testid="require-tier"]').parentElement;
        expect(gate.style.padding).toBe('0px');
        expect(gate.style.height).toBe('100%');
    });

    it('stamps the build version in the footer', async () => {
        const { container } = await mount();
        const footer = container.querySelector('div.px-4.py-3 p');
        expect(footer.textContent).toMatch(/^Bee Flow v\d+\.\d+\.\d+/);
        expect(footer.getAttribute('title')).toContain('v');
    });

    it('opens the memory overlay from the Memory section and refetches stats on close', async () => {
        await mount({ path: '/app/settings/memory' });
        expect(screen.getByTestId('section-memory').dataset.stats).toBe('{"total":3}');
        const statCalls = () => authFetch.mock.calls.filter(c => String(c[0]).includes('/agents/memory/stats')).length;
        expect(statCalls()).toBe(1);

        await click(screen.getByText('open-memory'));
        expect(screen.getByTestId('memory-panel')).toBeInTheDocument();

        await click(screen.getByText('close-memory'));
        expect(screen.queryByTestId('memory-panel')).toBeNull();
        expect(statCalls()).toBe(2);
    });

    it('leaves memoryStats null when the stats call fails', async () => {
        serve({ memoryStats: json({ error: 'nope' }, false) });
        await mount({ path: '/app/settings/memory' });
        expect(screen.getByTestId('section-memory').dataset.stats).toBe('null');
    });

    it('hands the Connections panel its statuses, the save callback and the user — no org flags', async () => {
        await mount({ user: { ...CONSUMER, permissions: [] }, path: '/app/settings/integrations' });
        expect(screen.getByTestId('section-integrations').dataset.props).toBe('onSaved,statuses,user');
    });

    it('shows SignRequest as connected when the server says so', async () => {
        serve({ userSettings: { hasSignRequestConfig: true } });
        await mount({ path: '/app/settings/integrations' });
        expect(screen.getByTestId('section-integrations').dataset.signrequest).toBe('true');
    });

    it('re-reads the statuses after a save or a disconnect, instead of forcing "connected"', async () => {
        await mount({ path: '/app/settings/integrations' });
        const settingsCalls = () => authFetch.mock.calls.filter(c => String(c[0]).includes('/ai/user-settings')).length;
        expect(settingsCalls()).toBe(1);
        expect(screen.getByTestId('section-integrations').dataset.fireflies).toBe('false');

        // A Disconnect fires the same onSaved: the server still says "not
        // connected", and that is what the row keeps showing.
        await click(screen.getByText('saved-fireflies'));
        await waitFor(() => expect(settingsCalls()).toBe(2));
        await settle();
        expect(screen.getByTestId('section-integrations').dataset.fireflies).toBe('false');

        serve({ userSettings: { hasFirefliesKey: true } });
        await click(screen.getByText('saved-afas'));
        await waitFor(() => expect(screen.getByTestId('section-integrations').dataset.fireflies).toBe('true'));

        // A row whose state does not live in `statuses` causes no re-read.
        const before = settingsCalls();
        await click(screen.getByText('saved-google'));
        await settle();
        expect(settingsCalls()).toBe(before);
    });

    it('reveals the org GitHub Sync row as soon as GitHub is connected', async () => {
        const { container } = await mount({ user: ORG_ADMIN, path: '/app/settings/integrations' });
        expect(screen.getByTestId('section-integrations').dataset.github).toBe('false');

        serve({ githubConnected: true });
        await click(screen.getByText('saved-github'));
        await waitFor(() => expect(screen.getByTestId('section-integrations').dataset.github).toBe('true'));
        await expand(container);
        expect(subRows(container)).toContain('GitHub Sync');
    });

    it('gives Help & Support the Learning Center link only where that page opens', async () => {
        await mount({ path: '/app/settings/help_support' });
        expect(screen.getByTestId('section-help').dataset.learnlink).toBe('true');
        await click(screen.getByText('open-learning'));
        expect(window.location.pathname).toBe('/app/settings/learning');
        expect(panel()).toBe('section-learning');
        cleanup();

        capabilities = new Set(['projects']);
        await mount({ path: '/app/settings/help_support' });
        expect(screen.getByTestId('section-help').dataset.learnlink).toBe('false');
        cleanup();

        capabilities = new Set(['learning_center', 'projects']);
        viewport = PHONE;
        await mount({ path: '/app/settings/help_support' });
        expect(screen.getByTestId('section-help').dataset.learnlink).toBe('false');
    });
});
