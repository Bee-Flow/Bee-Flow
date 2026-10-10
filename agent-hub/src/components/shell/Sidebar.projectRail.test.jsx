import { render as rtlRender, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';

// On one project's pages the sidebar swaps itself for the project rail (as
// Studio does for its own); the list, the create form and phones keep the
// ordinary sidebar. The mock preamble is the one of Sidebar.studioNav.test.jsx.

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

vi.mock('../../hooks/useProjectStream', () => ({ default: () => {} }));
const { viewportMock } = vi.hoisted(() => ({ viewportMock: { isDesktop: true, isCompact: false, isMobile: false, width: 1920 } }));
vi.mock('../../hooks/useViewport', () => ({ default: () => viewportMock, useViewport: () => viewportMock }));
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
import { testQueryClient, withQueryClient } from '../../test/queryWrapper';
import { studioAppsApi } from '../admin/Studio/AppStudio/studioAppsApi';
import { ProjectLiveProvider } from '../projects/workspace/ProjectLiveContext';

const PROJECT = { id: 'p1', name: 'Product launch', kind: 'workspace', ownerId: 'me', color: '#f59e0b', icon: '🚀', role: 'owner' };

const rail = (over = {}) => ({
    projectId: 'p1', tab: 'tasks', onSelectTab: vi.fn(), onBack: vi.fn(), onOpenProject: vi.fn(),
    onOpenSearch: vi.fn(), notebooksEnabled: true, ...over,
});

const renderSidebar = (props = {}) => {
    const client = testQueryClient();
    client.setQueryData(['projects', 'p1', 'detail'], PROJECT);
    return rtlRender(withQueryClient(
        <ProjectLiveProvider projectId="p1" currentUserId="me">
            <Sidebar
                isOpen
                toggleSidebar={() => {}}
                user={{ id: 'me', isAdmin: true, permissions: ['all'] }}
                hasPermission={() => true}
                onNavigate={vi.fn()}
                currentPage="agents"
                projects={[PROJECT]}
                onDirectChat={() => {}}
                onOpenMarketplace={() => {}}
                onOpenSearch={() => {}}
                onLogout={() => {}}
                {...props}
            />
        </ProjectLiveProvider>,
        client,
    ));
};

beforeEach(() => {
    cleanup();
    Object.assign(viewportMock, { isDesktop: true, isCompact: false, isMobile: false, width: 1920 });
    fetchMock.mockReset();
    fetchMock.impl = async () => ({ ok: false });
    fetchMock.mockImplementation((url) => fetchMock.impl(url));
    storeMock.data = {};
    studioAppsApi.listAccessible.mockResolvedValue({ apps: [] });
    studioAppsApi.listMine.mockResolvedValue({ apps: [] });
});

describe('Sidebar on a project page', () => {
    it('is the project rail, with the account footer', async () => {
        renderSidebar({ currentPage: 'projects', projectRail: rail() });
        expect(await screen.findByTestId('project-rail')).toBeInTheDocument();
        expect(screen.queryByTestId('main-navigation')).toBeNull();
        expect(screen.getByTestId('sidebar-profile')).toBeInTheDocument();
    });

    it('stays the ordinary sidebar on another page that carries a project rail object', () => {
        renderSidebar({ currentPage: 'agents', projectRail: rail() });
        expect(screen.getByTestId('main-navigation')).toBeInTheDocument();
    });

    it('stays the ordinary sidebar on the projects list and on a phone', () => {
        renderSidebar({ currentPage: 'projects', projectRail: null });
        expect(screen.getByTestId('main-navigation')).toBeInTheDocument();
        cleanup();
        renderSidebar({ currentPage: 'projects', isMobile: true, projectRail: rail({ tab: null }) });
        expect(screen.getByTestId('main-navigation')).toBeInTheDocument();
    });

    it('folds its footer with the rail below 1280px, and the profile menu still opens', async () => {
        Object.assign(viewportMock, { isDesktop: false, isCompact: true, width: 1024 });
        renderSidebar({ currentPage: 'projects', projectRail: rail(), user: { id: 'me', username: 'tomkooy', displayName: 'Tom Kooy', isAdmin: true, permissions: ['all'] } });
        const rail1 = await screen.findByTestId('project-rail');
        expect(rail1).toHaveAttribute('data-folded', 'true');
        expect(screen.queryByText('Tom Kooy')).toBeNull();
        await userEvent.click(screen.getByTestId('sidebar-profile'));
        expect(await screen.findByTestId('profile-menu')).toBeInTheDocument();
    });
});
