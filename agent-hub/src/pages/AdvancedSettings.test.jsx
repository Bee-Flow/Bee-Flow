import { act, cleanup, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Characterisation of the SETTINGS SHELL — the screen around the sections:
 * which sidebar rows exist for which account, which panel a segment opens,
 * where the bounce effects (Simple Mode, self-hosted, phone, self-hosted
 * licence, Learning Center, Notifications) land, and where an organisation
 * address goes: to the admin dashboard on a desktop (its sections' own rules
 * are pinned by components/admin/organisation), a phone keeping Compliance and
 * the no-plan licence page.
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
import { SETTINGS_ORG_ADMIN_TARGETS, SETTINGS_ORG_ID_TO_URL } from '../authedApp/settingsRoutes';
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

async function mount({ user = MEMBER, path = '/app/settings', onNavigate = vi.fn(), ...props } = {}) {
    window.history.replaceState({}, '', path);
    const view = renderWithClient(<AdvancedSettings user={user} onNavigate={onNavigate} {...props} />);
    await settle();
    return { ...view, onNavigate };
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
        const { container } = await mount({ user: ORG_ADMIN, path: '/app/settings/memory' });
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

/* ══ The organisation's pages: in the admin dashboard on a desktop ═══════ */
describe('AdvancedSettings — organisation addresses on a desktop', () => {
    it('draws no Workspace group: not for an org admin, a platform admin or a DPO', async () => {
        for (const user of [ORG_ADMIN, { ...MEMBER, permissions: ['org_admin'] }, SUPER_ADMIN, DPO]) {
            const { container } = await mount({ user });
            expect(headers(container)).toEqual(['Personal']);
            expect(topRows(container)).not.toContain('Organisation');
            expect(topRows(container)).not.toContain('Compliance');
            cleanup();
        }
    });

    it('replaces every /app/settings/organisation/<segment> with its dashboard page, and renders no panel meanwhile', async () => {
        for (const [id, segment] of Object.entries(SETTINGS_ORG_ID_TO_URL)) {
            const { onNavigate } = await mount({ user: SUPER_ADMIN, path: `/app/settings/organisation/${segment}` });
            expect(onNavigate, segment).toHaveBeenCalledWith(SETTINGS_ORG_ADMIN_TARGETS[id], { replace: true });
            expect(panel(), segment).toBeNull();
            cleanup();
        }
    });

    it('keeps the query string, so a Stripe return reaches the licence page with its result', async () => {
        const { onNavigate } = await mount({ user: ORG_ADMIN, path: '/app/settings/organisation/license?checkout=success&session_id=cs_1' });
        expect(onNavigate).toHaveBeenCalledWith('admin/organisation/license?checkout=success&session_id=cs_1', { replace: true });
    });

    it('carries the deep segments: a Compliance section and check, a usage report', async () => {
        const first = await mount({ user: DPO, path: '/app/settings/organisation/compliance/dsr/req%2F7' });
        expect(first.onNavigate).toHaveBeenCalledWith('admin/compliance/dsr/req%2F7', { replace: true });
        cleanup();
        const second = await mount({ user: SUPER_ADMIN, path: '/app/settings/organisation/usage/spend' });
        expect(second.onNavigate).toHaveBeenCalledWith('admin/monitoring/spend', { replace: true });
    });

    it('sends an unknown organisation segment to the licence page, as it always resolved', async () => {
        const { onNavigate } = await mount({ user: ORG_ADMIN, path: '/app/settings/organisation/does-not-exist' });
        expect(onNavigate).toHaveBeenCalledWith('admin/organisation/license', { replace: true });
    });

    it('leaves every other address alone', async () => {
        const { onNavigate } = await mount({ user: ORG_ADMIN, path: '/app/settings/memory' });
        expect(onNavigate).not.toHaveBeenCalled();
        expect(panel()).toBe('section-memory');
    });

    it('never asks for the org list when the user cannot see the org', async () => {
        await mount({ user: MEMBER });
        expect(authFetch.mock.calls.map(c => String(c[0]))).not.toContain('/auth/organizations');
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
        expect(headers(container)).toEqual(['Personal']);
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

    it('hands Preferences an empty list when the agents call is refused, never the error body', async () => {
        // The old loader never checked res.ok: a 500's error BODY landed in `agents`,
        // and PreferencesSection calls agents.map() once the startup mode is 'specific'.
        serve({ agentsRes: json({ error: 'boom' }, false) });
        await mount({ path: '/app/settings/preferences' });
        expect(screen.getByTestId('section-preferences').dataset.agents).toBe('[]');
    });
});

/* ══ Compliance ══════════════════════════════════════════════════════════ */
// A phone keeps the Compliance Center in Settings (a desktop opens it in the dashboard).
describe('AdvancedSettings — Compliance Center', () => {
    beforeEach(() => { viewport = PHONE; });

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
        expect(topRows(container)).not.toContain('Compliance');
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

    it('keeps the settings title bar on the phone section LIST', async () => {
        viewport = PHONE;
        const { container } = await mount({ user: DPO });
        expect(screen.getByLabelText('Back')).toBeInTheDocument();
        expect(titleBar(container).textContent).toBe('Settings');
    });
});

/* ══ The Compliance count badge ══════════════════════════════════════════ */
describe('AdvancedSettings — the count badge on the Compliance row', () => {
    it('asks for the one key it shows, once, without a poll, on a phone only', async () => {
        viewport = PHONE;
        await mount({ user: DPO });
        expect(countsHookOpts[0]).toEqual({ enabled: true, poll: false, keys: ['attention_open'] });
        cleanup();
        countsHookOpts.length = 0;
        viewport = { isMobile: false, isCompact: false, isDesktop: true, width: 1920 };
        await mount({ user: DPO });
        expect(countsHookOpts.every(o => o.enabled === false)).toBe(true);
    });

    it('does not ask at all when the row is not shown', async () => {
        capabilities = new Set([]);
        await mount({ user: MEMBER });
        expect(countsHookOpts.every(o => o.enabled === false)).toBe(true);
    });

    it('renders it on the phone row too', async () => {
        viewport = PHONE;
        complianceCounts = { attention_open: 12 };
        await mount({ user: DPO });
        expect(screen.getByTestId('nav-compliance-count')).toHaveTextContent('12');
    });

    it('shows NOTHING while the count is unknown, and nothing at zero', async () => {
        viewport = PHONE;
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

    it('bounces the per-org licence page on self-hosted to Preferences on a phone', async () => {
        subscription = { hasActiveSub: false, sub: null, loading: false };
        viewport = PHONE;
        await mount({ user: { ...ORG_ADMIN, ...SELF_HOSTED }, path: '/app/settings/organisation/license' });
        expect(window.location.pathname).toBe('/app/settings/preferences');
        expect(panel()).toBe('section-preferences');
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

        // A phone's organisation page: the no-plan licence page.
        subscription = { hasActiveSub: false, sub: null, loading: false };
        viewport = PHONE;
        await mount({ user: SUPER_ADMIN, path: '/app/settings/organisation/license' });
        expect(widthOf().className).toContain('max-w-5xl');
        cleanup();
        viewport = { isMobile: false, isCompact: false, isDesktop: true, width: 1920 };

        // Every consumer page, the licence plan grid included.
        for (const seg of ['license', 'privacy', 'usage', 'integrations', 'beta']) {
            await mount({ user: CONSUMER, path: `/app/settings/account/${seg}` });
            expect(widthOf().className, seg).toContain('max-w-5xl');
            cleanup();
        }

        viewport = PHONE;
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

    it('re-reads the GitHub status after a connect', async () => {
        await mount({ user: ORG_ADMIN, path: '/app/settings/integrations' });
        expect(screen.getByTestId('section-integrations').dataset.github).toBe('false');

        serve({ githubConnected: true });
        await click(screen.getByText('saved-github'));
        await waitFor(() => expect(screen.getByTestId('section-integrations').dataset.github).toBe('true'));
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
