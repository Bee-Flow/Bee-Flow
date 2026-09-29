import { render as rtlRender, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

// The Studio screen lost its tab bar: its sections open from a flyout panel
// beside the sidebar's Studio row (from the same studioApps.jsx registry,
// gates included), and published App Studio apps open from the Apps row the
// same way. This file covers that sidebar side; Studio.registry.test.jsx
// covers the shell side.

// Controllable licence gate, fetch and storage, shared with the hoisted
// vi.mock factories. `fetchMock` answers the two menu-visibility endpoints the
// sidebar polls (approval facets, published forms); `storeMock` is a real
// store, because the rows seed themselves from the last remembered answer.
// `entitlementsMock` is the unified effective set (the Skills gate reads it)
// and `lockReason` decides hide-vs-lock for a failed gate; `runtimeMock.apps`
// stands in for the installed-module registry.
const { licenseMock, entitlementsMock, runtimeMock, fetchMock, storeMock, registryMock } = vi.hoisted(() => {
    // One vi.fn delegating to a swappable `impl`: serve() and the remembered-
    // answer tests set `impl`; the counts tests use the vi.fn API directly
    // (mockImplementation / mock.calls). Both styles work on the same mock.
    const fetchMock = vi.fn((url) => fetchMock.impl(url));
    fetchMock.impl = async () => ({ ok: false });
    return {
        licenseMock: { hasFeature: () => true },
        entitlementsMock: { can: () => true, lockReason: () => null, loading: false, error: null },
        runtimeMock: { apps: [] },
        fetchMock,
        storeMock: { data: {} },
        registryMock: { apps: null },
    };
});

/** Answer the sidebar's polls with `facets` and `forms`, miss on the rest. */
const serve = ({ facets = null, orgFacets = null, forms = null } = {}) => {
    fetchMock.impl = async (url) => {
        const u = String(url);
        if (u.includes('/approvals/facets')) {
            const f = u.includes('scope=org') ? orgFacets : facets;
            return f ? { ok: true, json: async () => ({ facets: f }) } : { ok: false };
        }
        if (u.includes('/automation/forms')) {
            return forms ? { ok: true, json: async () => ({ forms }) } : { ok: false };
        }
        return { ok: false };
    };
};

vi.mock('../../hooks/useTranslation', () => {
    const useTranslation = () => ({ t: (key, fallback) => fallback || key, locale: 'en' });
    return { default: useTranslation, useTranslation };
});
vi.mock('../appearance/ThemeContext', () => ({ useTheme: () => ({}) }));
vi.mock('../licensing/LicenseContext', () => ({
    useLicenseContext: () => ({ hasFeature: (f) => licenseMock.hasFeature(f), deploymentMode: 'cloud' }),
}));
vi.mock('../licensing/EntitlementsContext', () => ({
    useEntitlements: () => ({
        can: (id) => entitlementsMock.can(id),
        lockReason: (id) => entitlementsMock.lockReason(id),
        loading: entitlementsMock.loading,
        error: entitlementsMock.error,
    }),
}));
vi.mock('../../utils/helpers', () => ({
    API_BASE: '',
    authFetch: fetchMock,
}));
vi.mock('../../utils/scopedStorage', () => ({
    default: {
        getItem: (k) => storeMock.data[k] ?? null,
        setItem: (k, v) => { storeMock.data[k] = v; },
    },
}));
// The registry stays real unless a test hands it a section list of its own —
// only the "no sections at all" case needs to replace it.
vi.mock('../admin/Studio/studioApps', async (importOriginal) => {
    const actual = await importOriginal();
    return {
        ...actual,
        get STUDIO_APPS() { return registryMock.apps ?? actual.STUDIO_APPS; },
    };
});
vi.mock('./NotificationCenter', () => ({ default: () => null }));
vi.mock('./NavLink', () => ({ default: ({ children, ...p }) => <a {...p}>{children}</a> }));
vi.mock('../icons/AppIcon', () => ({ default: ({ name }) => <span data-appicon={name} /> }));
vi.mock('../../moduleRuntime/registry', () => ({ useRuntimeStudioApps: () => runtimeMock.apps }));
vi.mock('../admin/Studio/AppStudio/studioAppsApi', () => ({
    studioAppsApi: { listAccessible: vi.fn(), listMine: vi.fn() },
}));

import Sidebar from './Sidebar.jsx';
import { queryWrapper } from '../../test/queryWrapper';
import { studioAppsApi } from '../admin/Studio/AppStudio/studioAppsApi';

// The hooks under this tree read through React Query, so every render needs
// a client above it — a fresh one per render, never the app singleton.
const render = (ui, options) => rtlRender(ui, { wrapper: queryWrapper(), ...options });

const renderSidebar = (props = {}) => render(
    <Sidebar
        isOpen
        toggleSidebar={() => {}}
        user={{ isAdmin: true, permissions: ['all'] }}
        hasPermission={() => true}
        onNavigate={vi.fn()}
        currentPage="agents"
        onDirectChat={() => {}}
        onOpenMarketplace={() => {}}
        onOpenSearch={() => {}}
        onLogout={() => {}}
        {...props}
    />
);

/* Back to a fresh, empty workspace: no remembered rows, nothing published,
   nothing to approve. Each describe opts in to what it needs on top. */
const resetSidebarMocks = () => {
    cleanup();
    licenseMock.hasFeature = () => true;
    entitlementsMock.can = () => true;
    entitlementsMock.lockReason = () => null;
    entitlementsMock.loading = false;
    entitlementsMock.error = null;
    runtimeMock.apps = [];
    storeMock.data = {};
    registryMock.apps = null;
    fetchMock.mockReset();
    fetchMock.impl = async () => ({ ok: false });
    fetchMock.mockImplementation((url) => fetchMock.impl(url));
    serve();
    studioAppsApi.listAccessible.mockResolvedValue({ apps: [] });
    // /mine may 403 for pure consumers — the flyout must survive that.
    studioAppsApi.listMine.mockResolvedValue({ apps: [] });
};

const openStudioFlyout = () => fireEvent.click(screen.getByTestId('nav-studio'));
// The Apps row itself waits for the published-apps load — it is not in the
// menu until there is something published for this person to open.
const openAppsFlyout = async () => fireEvent.click(await screen.findByTestId('nav-apps'));

// A Community org: no licence features, nothing effective, and every gated
// capability either outside the plan ('ceiling') or, for Skills, inside the
// plan but not switched on ('not_granted').
const asCommunityOrg = () => {
    licenseMock.hasFeature = () => false;
    entitlementsMock.can = () => false;
    entitlementsMock.lockReason = (id) => (id === 'skills' ? 'not_granted' : 'ceiling');
};

describe('Sidebar — Studio flyout (registry-driven)', () => {
    beforeEach(resetSidebarMocks);

    it('renders every gate-passing Studio section in the flyout, with its short description', () => {
        renderSidebar();
        expect(screen.queryByTestId('flyout-studio')).toBeNull();
        openStudioFlyout();
        for (const id of ['agents', 'skills', 'knowledge', 'aiTasks', 'datatables', 'webpages', 'apps', 'playbooks', 'solutions', 'meetingNotes']) {
            expect(screen.getByTestId(`nav-studio-${id}`)).toBeTruthy();
        }
        // Descriptions come from the registry's descKey/descFallback.
        expect(screen.getByText('Create and manage your agents')).toBeTruthy();
        expect(screen.getByText('Reusable abilities for your agents')).toBeTruthy();
    });

    it('groups the sections under Build · AI · Bundle, in registry order', () => {
        renderSidebar();
        openStudioFlyout();
        const build = screen.getByTestId('flyout-group-build');
        const ai = screen.getByTestId('flyout-group-ai');
        const bundle = screen.getByTestId('flyout-group-bundle');
        expect(build.textContent).toContain('Build');
        expect(ai.textContent).toContain('AI');
        expect(bundle.textContent).toContain('Bundle');
        // Each section sits under its own heading, not merely somewhere in the
        // panel — the whole point of the grouping.
        for (const id of ['aiTasks', 'datatables', 'webpages', 'apps']) {
            expect(build.querySelector(`[data-testid="nav-studio-${id}"]`)).toBeTruthy();
        }
        for (const id of ['agents', 'skills', 'knowledge', 'meetingNotes']) {
            expect(ai.querySelector(`[data-testid="nav-studio-${id}"]`)).toBeTruthy();
        }
        expect(bundle.querySelector('[data-testid="nav-studio-playbooks"]')).toBeTruthy();
        expect(bundle.querySelector('[data-testid="nav-studio-solutions"]')).toBeTruthy();
        // Build, then AI, then Bundle — the rail's order.
        expect(build.compareDocumentPosition(ai) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
        expect(ai.compareDocumentPosition(bundle) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
        // No installed modules → no Add-ons heading (empty groups are dropped).
        expect(screen.queryByTestId('flyout-group-modules')).toBeNull();
    });

    it('tints each section glyph with its kind colour', () => {
        renderSidebar();
        openStudioFlyout();
        const glyph = screen.getByTestId('nav-studio-knowledge').querySelector('svg');
        expect(glyph.style.color).toBe('var(--kind-kb)');
        expect(screen.getByTestId('nav-studio-aiTasks').querySelector('svg').style.color).toBe('var(--type-trigger)');
    });

    it('never lists Approvals or Support in the Studio panel', () => {
        // Approvals is `hiddenFromNav`: it has its own top-level row (below),
        // and the same destination twice one hover apart is not a second
        // entrance. Support is not a Studio section at all any more.
        renderSidebar();
        openStudioFlyout();
        expect(screen.queryByTestId('nav-studio-approvals')).toBeNull();
        expect(screen.queryByTestId('nav-studio-support')).toBeNull();
    });

    it('on a Community org: licence-gated rows are PRESENT but locked; permission-style gates still hide', () => {
        asCommunityOrg();
        // No canUseFeature map and no beta grants → canUse() is false too.
        // The role still carries the three Community sections, which is what
        // separates "your licence does not include this" from "your role does
        // not include this".
        renderSidebar({
            user: { isAdmin: true, permissions: [] },
            hasPermission: (p) => ['manage_agents', 'manage_skills', 'manage_knowledge'].includes(p),
        });
        openStudioFlyout();
        // Always-on.
        for (const id of ['agents', 'knowledge']) {
            const row = screen.getByTestId(`nav-studio-${id}`);
            expect(row.disabled).toBe(false);
            expect(row.getAttribute('data-locked')).toBeNull();
        }
        // Locked with an upgrade hint — the org learns these exist. NOT the
        // `disabled` attribute (Firefox shows no title on one, and the
        // keyboard cannot reach it): aria-disabled, and the hint as a
        // visible line under the label as well as the tooltip.
        for (const id of ['webpages', 'apps', 'meetingNotes', 'solutions', 'aiTasks', 'datatables']) {
            const row = screen.getByTestId(`nav-studio-${id}`);
            expect(row.disabled, `${id} disabled`).toBe(false);
            expect(row.getAttribute('aria-disabled')).toBe('true');
            expect(row.getAttribute('title')).toBe('Available on a higher plan');
            expect(screen.getByTestId(`nav-studio-${id}-lock`)).toBeTruthy();
            expect(screen.getByTestId(`nav-studio-${id}-lock-hint`).textContent).toBe('Available on a higher plan');
            expect(row.className).toMatch(/cursor-not-allowed/);
        }
        // Skills: in the plan but not switched on → "ask an admin".
        const skills = screen.getByTestId('nav-studio-skills');
        expect(skills.disabled).toBe(false);
        expect(skills.getAttribute('aria-disabled')).toBe('true');
        expect(skills.getAttribute('title')).toBe('Not switched on for your organisation — ask an admin');
        expect(screen.getByTestId('nav-studio-skills-lock-hint').textContent).toBe('Not switched on for your organisation — ask an admin');
        // The locked rows keep their headings alive — Build holds Webpages
        // and Apps, Bundle holds Solutions.
        expect(screen.getByTestId('flyout-group-build')).toBeTruthy();
        expect(screen.getByTestId('flyout-group-bundle')).toBeTruthy();
    });

    it('a locked row neither navigates nor offers a sub-panel', () => {
        // (The Studio ROW's own landing — first UNLOCKED section — is
        // firstOpenStudioSection, pinned in studioApps.test.jsx; on desktop
        // the row click toggles the flyout, so it cannot be reached here.)
        asCommunityOrg();
        const onNavigate = vi.fn();
        // The role still grants the Community sections; what varies here is
        // the licence, so the locked row is a licence lock, not a role hide.
        renderSidebar({ onNavigate, user: { isAdmin: true, permissions: [] }, hasPermission: (p) => ['manage_agents', 'manage_skills', 'manage_knowledge'].includes(p) });
        openStudioFlyout();
        fireEvent.click(screen.getByTestId('nav-studio-apps'));
        expect(onNavigate).not.toHaveBeenCalled();
        expect(screen.getByTestId('nav-studio-apps').getAttribute('aria-haspopup')).toBeNull();
        // The flyout stays open — nothing happened.
        expect(screen.getByTestId('flyout-studio')).toBeTruthy();
        // The open ones still navigate.
        fireEvent.click(screen.getByTestId('nav-studio-agents'));
        expect(onNavigate).toHaveBeenLastCalledWith('studio/agents');
    });

    it('a failed gate whose entitlement IS effective is a permission matter and stays hidden', () => {
        // lockReason answers null (effective) while the licence flag says no:
        // a hide, exactly as before the lock variant existed.
        licenseMock.hasFeature = () => false;
        entitlementsMock.can = () => true;
        entitlementsMock.lockReason = () => null;
        renderSidebar({ user: { isAdmin: true, permissions: [] }, hasPermission: () => false });
        openStudioFlyout();
        for (const id of ['webpages', 'apps', 'meetingNotes', 'solutions', 'aiTasks', 'datatables']) {
            expect(screen.queryByTestId(`nav-studio-${id}`)).toBeNull();
        }
        // Build survives as a heading because Documents is ungated on purpose
        // — it replaces the ```quote``` block every chat could already render,
        // so there is no licence to fail. The assertion is therefore "only the
        // ungated row is left", not "the group is gone": a group that empties
        // out still disappears, which is what Bundle proves on the next line.
        expect(screen.queryByTestId('nav-studio-documents')).toBeTruthy();
        expect(screen.queryByTestId('flyout-group-bundle')).toBeNull();
    });

    it('while the entitlements are still loading, no row is locked — a licensed org must not see "higher plan" on every page load', () => {
        // Before the fetch lands `can` is false for everything and lockReason
        // would call every gated section 'ceiling'. That is not an answer yet.
        asCommunityOrg();
        entitlementsMock.loading = true;
        renderSidebar({ user: { isAdmin: true, permissions: [] }, hasPermission: (p) => ['manage_agents', 'manage_skills', 'manage_knowledge'].includes(p) });
        openStudioFlyout();
        expect(document.querySelectorAll('[data-locked="true"]').length).toBe(0);
        for (const id of ['webpages', 'apps', 'meetingNotes', 'solutions', 'skills']) {
            expect(screen.queryByTestId(`nav-studio-${id}`), id).toBeNull();
        }
        expect(screen.queryByText('Available on a higher plan')).toBeNull();
        // The always-on sections are unaffected.
        expect(screen.getByTestId('nav-studio-agents')).toBeTruthy();
    });

    it('a failed entitlements fetch locks nothing either', () => {
        asCommunityOrg();
        entitlementsMock.error = 'HTTP 503';
        renderSidebar({ user: { isAdmin: true, permissions: [] }, hasPermission: () => false });
        openStudioFlyout();
        expect(document.querySelectorAll('[data-locked="true"]').length).toBe(0);
        expect(screen.queryByText('Available on a higher plan')).toBeNull();
    });

    it('een module zonder eigen label() krijgt haar id als naam — nooit een lege rij', () => {
        // De flyout hield ooit zijn eigen kopie van studioSectionLabel, zonder
        // de terugval van de gedeelde versie: een beschrijver zonder label() én
        // zonder labelKey vroeg daar `t(undefined)`, en dan staat er een rij
        // zonder naam in het menu.
        runtimeMock.apps = [{ id: 'uptime', runtime: true, gate: () => true, urlSegment: 'uptime' }];
        renderSidebar();
        openStudioFlyout();
        expect(screen.getByTestId('nav-studio-uptime').textContent).toContain('uptime');
    });

    it('a runtime module whose id equals a first-party key never wears that key\'s count', async () => {
        fetchMock.mockImplementation(async (url) => (String(url).endsWith('/api/studio/counts')
            ? { ok: true, json: async () => ({ counts: { agents: 5 }, makers: 1 }) }
            : { ok: false }));
        runtimeMock.apps = [{ id: 'agents', runtime: true, gate: () => true, label: () => 'Agents (module)', urlSegment: 'mod-agents' }];
        renderSidebar();
        openStudioFlyout();
        // The first-party Agents row (AI group) shows its number…
        const ai = screen.getByTestId('flyout-group-ai');
        expect((await screen.findByTestId('nav-studio-agents-count')).textContent).toBe('5');
        expect(ai.querySelector('[data-testid="nav-studio-agents-count"]')).toBeTruthy();
        // …the module (Add-ons group) shows none: it has no countKey, and its
        // id must not fall back onto the first-party key.
        const modules = screen.getByTestId('flyout-group-modules');
        expect(modules.textContent).toContain('Agents (module)');
        expect(modules.querySelector('[data-testid$="-count"]')).toBeNull();
        expect(screen.getAllByTestId('nav-studio-agents-count').length).toBe(1);
    });

    it('renders the per-section count once /api/studio/counts answers, and nothing for an omitted key', async () => {
        fetchMock.mockImplementation(async (url) => (String(url).endsWith('/api/studio/counts')
            ? { ok: true, json: async () => ({ counts: { automations: 9, agents: 5, knowledge: 0 }, makers: 3 }) }
            : { ok: false }));
        renderSidebar();
        openStudioFlyout();
        expect((await screen.findByTestId('nav-studio-aiTasks-count')).textContent).toBe('9');
        expect(screen.getByTestId('nav-studio-agents-count').textContent).toBe('5');
        // Zero is a number too — "Knowledge 0" is information.
        expect(screen.getByTestId('nav-studio-knowledge-count').textContent).toBe('0');
        // A key the server left out (a kind this caller may not see) renders
        // no number at all — absent until known, never a dash or a skeleton.
        expect(screen.queryByTestId('nav-studio-apps-count')).toBeNull();
        expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith('/api/studio/counts'))).toBe(true);
    });

    it('does not poll counts for a user without a Studio row', () => {
        renderSidebar({ user: { permissions: ['use_notebooks'] } });
        expect(screen.queryByTestId('nav-studio')).toBeNull();
        expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith('/api/studio/counts'))).toBe(false);
    });

    it('navigates to studio/<urlSegment> and closes the panel when a section is picked', () => {
        const onNavigate = vi.fn();
        renderSidebar({ onNavigate });
        openStudioFlyout();
        fireEvent.click(screen.getByTestId('nav-studio-skills'));
        expect(onNavigate).toHaveBeenLastCalledWith('studio/skills');
        expect(screen.queryByTestId('flyout-studio')).toBeNull();
        openStudioFlyout();
        fireEvent.click(screen.getByTestId('nav-studio-aiTasks'));
        expect(onNavigate).toHaveBeenLastCalledWith('studio/automations');
        openStudioFlyout();
        fireEvent.click(screen.getByTestId('nav-studio-meetingNotes'));
        expect(onNavigate).toHaveBeenLastCalledWith('studio/meeting-notes');
    });

    it('toggles via the row, opens on hover, closes on Escape, keeps the tour anchor', () => {
        const { container } = renderSidebar();
        const row = container.querySelector('[data-tour="nav-studio"]');
        expect(row).toBeTruthy();
        // Click toggles.
        fireEvent.click(row);
        expect(screen.getByTestId('flyout-studio')).toBeTruthy();
        fireEvent.click(row);
        expect(screen.queryByTestId('flyout-studio')).toBeNull();
        // Hovering the wrapper opens too (React derives onMouseEnter from
        // native mouseover, which is what fireEvent.mouseOver dispatches).
        fireEvent.mouseOver(row.parentElement);
        expect(screen.getByTestId('flyout-studio')).toBeTruthy();
        // Escape dismisses.
        fireEvent.keyDown(document, { key: 'Escape' });
        expect(screen.queryByTestId('flyout-studio')).toBeNull();
    });

    it('steps aside for the Studio rail on a Studio page, handing over the rows it resolved (H1)', () => {
        // The flyout's active-section marking was only ever reachable on
        // /app/studio — `active` is `currentPage === 'studio' && …` — and that
        // is exactly where the rail now stands instead. So the assertion moves
        // with the chrome: the rail marks the active row, and what belongs
        // here is that the sidebar hands over at all, with the same gated
        // sections it had resolved.
        renderSidebar({ currentPage: 'studio', studioRoute: { section: 'skills', id: null } });
        expect(screen.getByTestId('studio-rail')).toBeTruthy();
        expect(screen.queryByTestId('sidebar')).toBeNull();
        expect(screen.getByTestId('rail-skills').getAttribute('aria-current')).toBe('page');
        expect(screen.getByTestId('rail-agents').getAttribute('aria-current')).toBeNull();
    });

    it('keeps the ordinary sidebar on the Approvals slice, which is a member screen', () => {
        // /app/studio/approvals is a Studio address with a non-Studio
        // audience: an approval bell is the way in, the section is
        // hiddenFromNav, and the rail would not even list it.
        renderSidebar({ currentPage: 'studio', studioRoute: { section: 'approvals', id: null } });
        expect(screen.queryByTestId('studio-rail')).toBeNull();
        expect(screen.getByTestId('sidebar')).toBeTruthy();
    });

    it('keeps the ordinary sidebar for someone who never had a Studio row', () => {
        // No admin rights, no manage_* permissions → canSeeStudio is false.
        // A deep link still renders the section; the chrome stays the one
        // they know.
        renderSidebar({
            currentPage: 'studio',
            studioRoute: { section: 'agents', id: null },
            user: { isAdmin: false, permissions: [] },
            hasPermission: () => false,
        });
        expect(screen.queryByTestId('studio-rail')).toBeNull();
        expect(screen.getByTestId('sidebar')).toBeTruthy();
    });
});

describe('Sidebar — the top-level Approvals row', () => {
    beforeEach(resetSidebarMocks);

    it('is listed on any approval, pending or not, and navigates to the section', async () => {
        // It is the ONLY entrance since the Studio panel stopped listing the
        // section, so it must not depend on something being PENDING: the
        // decided ones are a record people go looking for.
        serve({ facets: { status: { approved: 2, rejected: 1 } } });
        const onNavigate = vi.fn();
        renderSidebar({ onNavigate });
        const row = await screen.findByTestId('nav-approvals');
        // Nothing waiting → no badge, but the row is there.
        expect(row.textContent).not.toMatch(/\d/);
        fireEvent.click(row);
        expect(onNavigate).toHaveBeenLastCalledWith('studio/approvals');
    });

    it('badges what is waiting on this person', async () => {
        serve({ facets: { status: { pending: 3, approved: 1 } } });
        renderSidebar();
        const row = await screen.findByTestId('nav-approvals');
        expect(row.textContent).toContain('3');
    });

    it('stays out of the menu for someone who has never been in an approval', async () => {
        serve({ facets: { status: {} } });
        renderSidebar();
        // Let the poll resolve — the row must not appear afterwards either.
        await waitFor(() => expect(storeMock.data['sidebar_has_approvals']).toBe('0'));
        expect(screen.queryByTestId('nav-approvals')).toBeNull();
    });

    it('asks org-wide before taking the row away from an org admin', async () => {
        // An admin's own inbox being empty is not an empty section: they browse
        // the whole organisation's record, and that is the row's whole point
        // for them.
        serve({ facets: { status: {} }, orgFacets: { status: { approved: 4 } } });
        renderSidebar({ user: { orgRole: 'org_admin', permissions: [] } });
        expect(await screen.findByTestId('nav-approvals')).toBeTruthy();
    });

    it('does not ask org-wide for an ordinary member', async () => {
        serve({ facets: { status: {} }, orgFacets: { status: { approved: 4 } } });
        const seen = [];
        const base = fetchMock.impl;
        fetchMock.impl = (url) => { seen.push(String(url)); return base(url); };
        renderSidebar({
            user: { orgRole: 'member', permissions: ['use_approvals'] },
            hasPermission: (p) => p === 'use_approvals',
        });
        await waitFor(() => expect(seen.some(u => u.includes('scope=mine'))).toBe(true));
        expect(seen.some(u => u.includes('scope=org'))).toBe(false);
        expect(screen.queryByTestId('nav-approvals')).toBeNull();
    });

    it('renders straight away from the remembered answer, before the poll lands', () => {
        // No reshuffle on every load: the row is drawn in the shape it had last
        // time and only corrected if the answer actually changed.
        storeMock.data['sidebar_has_approvals'] = '1';
        renderSidebar();
        expect(screen.getByTestId('nav-approvals')).toBeTruthy();
    });

    it('goes away when the org role does not grant use_approvals', () => {
        // The licence says this installation sells approvals; the role says
        // whether this person is one of the people who handle them.
        serve({ facets: { status: { pending: 2 } } });
        renderSidebar({ hasPermission: (p) => p !== 'use_approvals' });
        expect(screen.queryByTestId('nav-approvals')).toBeNull();
    });

    it('goes away without the approvals licence', () => {
        licenseMock.hasFeature = (f) => f !== 'approvals';
        storeMock.data['sidebar_has_approvals'] = '1';
        renderSidebar();
        expect(screen.queryByTestId('nav-approvals')).toBeNull();
    });
});

describe('Sidebar — Apps flyout (published apps)', () => {
    beforeEach(() => {
        resetSidebarMocks();
        studioAppsApi.listAccessible.mockResolvedValue({
            apps: [
                { id: 'a1', name: 'Quote intake', description: 'Turn a PO into a quote', isPublished: true, icon: 'FileText', accentColor: '#0F766E' },
                { id: 'a3', name: 'Draft thing', isPublished: false },
            ],
        });
        studioAppsApi.listMine.mockResolvedValue({ apps: [{ id: 'a2', name: 'Order lookup', is_published: true }] });
    });

    it('lists published apps (accessible ∪ own, drafts excluded) under All apps', async () => {
        renderSidebar();
        await openAppsFlyout();
        expect(await screen.findByTestId('nav-app-a1')).toBeTruthy();
        expect(screen.getByTestId('nav-app-a2')).toBeTruthy();
        expect(screen.queryByTestId('nav-app-a3')).toBeNull();
        expect(screen.getByTestId('nav-apps-all')).toBeTruthy();
        // The app's own description renders under its name.
        expect(screen.getByText('Turn a PO into a quote')).toBeTruthy();
    });

    it('navigates to the directory and to a single app', async () => {
        const onNavigate = vi.fn();
        renderSidebar({ onNavigate });
        await openAppsFlyout();
        await screen.findByTestId('nav-app-a1');
        fireEvent.click(screen.getByTestId('nav-apps-all'));
        expect(onNavigate).toHaveBeenLastCalledWith('apps');
        await openAppsFlyout();
        fireEvent.click(await screen.findByTestId('nav-app-a1'));
        expect(onNavigate).toHaveBeenLastCalledWith('apps/a1');
    });

    it('goes away when the org role does not grant use_apps', async () => {
        renderSidebar({ hasPermission: (p) => p !== 'use_apps' });
        // Wait out the published-apps load — the row must not appear after it.
        await waitFor(() => expect(storeMock.data['sidebar_has_apps']).toBe('1'));
        expect(screen.queryByTestId('nav-apps')).toBeNull();
    });

    it('is not listed at all when nothing is published for this person', async () => {
        // Drafts do not count — the row IS the published-apps directory, and a
        // builder still reaches App Studio through Studio → Apps.
        studioAppsApi.listAccessible.mockResolvedValue({ apps: [{ id: 'a3', name: 'Draft thing', isPublished: false }] });
        studioAppsApi.listMine.mockResolvedValue({ apps: [] });
        renderSidebar();
        await waitFor(() => expect(storeMock.data['sidebar_has_apps']).toBe('0'));
        expect(screen.queryByTestId('nav-apps')).toBeNull();
    });

    it('keeps the row through a failed load rather than emptying the menu', async () => {
        storeMock.data['sidebar_has_apps'] = '1';
        studioAppsApi.listAccessible.mockRejectedValue(new Error('offline'));
        studioAppsApi.listMine.mockRejectedValue(new Error('offline'));
        renderSidebar();
        expect(screen.getByTestId('nav-apps')).toBeTruthy();
        await waitFor(() => expect(storeMock.data['sidebar_has_apps']).toBe('1'));
        expect(screen.getByTestId('nav-apps')).toBeTruthy();
    });
});

describe('Sidebar — the Forms row', () => {
    beforeEach(resetSidebarMocks);

    it('is listed once the organisation has published a form, and lists it', async () => {
        serve({ forms: [{ id: 'f1', title: 'Leave request', description: 'Ask for time off', live: true }] });
        renderSidebar();
        fireEvent.click(await screen.findByTestId('nav-forms'));
        expect(screen.getByTestId('nav-forms-all')).toBeTruthy();
        expect(screen.getByTestId('nav-form-f1')).toBeTruthy();
    });

    it('goes away when the org role does not grant use_forms', async () => {
        serve({ forms: [{ id: 'f1', title: 'Leave request', live: true }] });
        renderSidebar({ hasPermission: (p) => p !== 'use_forms' });
        await waitFor(() => expect(storeMock.data['sidebar_has_forms']).toBe('1'));
        expect(screen.queryByTestId('nav-forms')).toBeNull();
    });

    it('stays out of the menu when the organisation has published none', async () => {
        serve({ forms: [] });
        renderSidebar();
        await waitFor(() => expect(storeMock.data['sidebar_has_forms']).toBe('0'));
        expect(screen.queryByTestId('nav-forms')).toBeNull();
    });
});

describe('Sidebar — the Studio row', () => {
    beforeEach(resetSidebarMocks);

    it('opens the first section that actually passed its gate', () => {
        licenseMock.hasFeature = () => false;
        const onNavigate = vi.fn();
        renderSidebar({
            onNavigate,
            user: { isAdmin: true, permissions: [] },
            hasPermission: (p) => p === 'manage_agents',
        });
        fireEvent.click(screen.getByTestId('nav-studio'));
        fireEvent.click(screen.getByTestId('nav-studio-agents'));
        expect(onNavigate).toHaveBeenLastCalledWith('studio/agents');
    });

    it('is not listed when the org role grants no Studio section', () => {
        // A Member: no builder permission, so every section's gate says no even
        // on a full licence, and a row opening an empty panel is worse than no
        // row. Their consumer rows (Approvals, Apps, Forms) are unaffected.
        renderSidebar({
            user: { orgRole: 'member', permissions: ['use_notebooks', 'use_datatables', 'use_approvals'] },
            hasPermission: (p) => ['use_notebooks', 'use_datatables', 'use_approvals'].includes(p),
        });
        expect(screen.queryByTestId('nav-studio')).toBeNull();
    });

    it('is not listed when no section passes its gate', () => {
        // The permission says this person may build; the sections say there is
        // nothing here to build with. A row opening an empty panel is worse
        // than no row.
        registryMock.apps = [];
        renderSidebar();
        expect(screen.queryByTestId('nav-studio')).toBeNull();
    });
});
