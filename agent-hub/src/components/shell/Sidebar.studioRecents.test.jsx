import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render as rtlRender, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';

/**
 * The Studio flyout's second level: hovering a section opens a further panel to
 * its right listing what you were last working on there.
 *
 * The three things worth pinning: a section with nothing to offer must NOT open
 * an empty box (hovering the menu would flash panels everywhere), a row must
 * deep-link to the item and not just the section, and a section whose list
 * endpoint fails must leave the level-1 flyout completely usable — this is a
 * navigation menu, and a 403 on one list is not a reason to break it.
 */

const { licenseMock, fetchMock, storeMock } = vi.hoisted(() => ({
    licenseMock: { hasFeature: () => true },
    fetchMock: { impl: async () => ({ ok: false }) },
    storeMock: { data: {} },
}));

vi.mock('../../hooks/useTranslation', () => {
    const useTranslation = () => ({ t: (key, fallback) => fallback || key, locale: 'en' });
    return { default: useTranslation, useTranslation };
});
vi.mock('../appearance/ThemeContext', () => ({ useTheme: () => ({}) }));
vi.mock('../licensing/LicenseContext', () => ({
    useLicenseContext: () => ({ hasFeature: (f) => licenseMock.hasFeature(f), deploymentMode: 'cloud' }),
}));
vi.mock('../licensing/EntitlementsContext', () => ({ useEntitlements: () => ({ can: () => true }) }));
vi.mock('../../utils/helpers', () => ({
    API_BASE: '',
    authFetch: vi.fn((url) => fetchMock.impl(url)),
}));
vi.mock('../../utils/scopedStorage', () => ({
    default: {
        getItem: (k) => storeMock.data[k] ?? null,
        setItem: (k, v) => { storeMock.data[k] = v; },
    },
}));
vi.mock('./NotificationCenter', () => ({ default: () => null }));
vi.mock('./NavLink', () => ({ default: ({ children, ...p }) => <a {...p}>{children}</a> }));
vi.mock('../icons/AppIcon', () => ({ default: ({ name }) => <span data-appicon={name} /> }));
vi.mock('../../moduleRuntime/registry', () => ({ useRuntimeStudioApps: () => [] }));
vi.mock('../admin/Studio/AppStudio/studioAppsApi', () => ({
    studioAppsApi: {
        listAccessible: vi.fn(async () => ({ apps: [] })),
        listMine: vi.fn(async () => ({ apps: [] })),
    },
}));

import Sidebar from './Sidebar.jsx';
import { queryWrapper } from '../../test/queryWrapper';

// The hooks under this tree read through React Query, so every render needs
// a client above it — a fresh one per render, never the app singleton.
const render = (ui, options) => rtlRender(ui, { wrapper: queryWrapper(), ...options });

const AGENTS = [
    { id: 'ag1', name: 'Sales assistent', description: 'Helps with quotes', updated_at: '2026-08-10T10:00:00Z' },
    { id: 'ag2', name: 'PO-intake bot', description: 'Reads purchase orders', updated_at: '2026-08-09T10:00:00Z' },
];

/** Answer /agents/all with `rows`, and miss on everything else. */
const serveAgents = (rows = AGENTS) => {
    fetchMock.impl = async (url) => (String(url).includes('/agents/all')
        ? { ok: true, json: async () => rows }
        : { ok: false });
};

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
    />,
);

const openStudioFlyout = () => fireEvent.click(screen.getByTestId('nav-studio'));
// The wrapper around the section row is what carries the hover handler.
const hoverSection = (id) => fireEvent.mouseOver(screen.getByTestId(`nav-studio-${id}`).parentElement);

beforeEach(() => {
    cleanup();
    licenseMock.hasFeature = () => true;
    fetchMock.impl = async () => ({ ok: false });
    storeMock.data = {};
});

describe('Studio flyout — recently edited panel', () => {
    it('opens beside the section and lists your agents, newest first', async () => {
        serveAgents();
        renderSidebar();
        openStudioFlyout();
        expect(screen.queryByTestId('subflyout-agents')).toBeNull();
        hoverSection('agents');
        expect(await screen.findByTestId('subflyout-agents')).toBeTruthy();
        expect(screen.getByTestId('nav-recent-agents-ag1')).toBeTruthy();
        expect(screen.getByTestId('nav-recent-agents-ag2')).toBeTruthy();
    });

    it('shows a description under the title, not a date', async () => {
        serveAgents();
        renderSidebar();
        openStudioFlyout();
        hoverSection('agents');
        await screen.findByTestId('subflyout-agents');
        expect(screen.getByText('Helps with quotes')).toBeTruthy();
        expect(screen.queryByText(/ago$/)).toBeNull();
    });

    it('truncates a long description rather than filling the panel', async () => {
        const long = 'Hey there! I am your super friendly Nextcloud expert, here to help you with anything and everything about Nextcloud, from setup to troubleshooting to best practices!';
        serveAgents([{ id: 'ag1', name: 'Nextcloud_Buddy', description: long, updated_at: '2026-08-10T10:00:00Z' }]);
        renderSidebar();
        openStudioFlyout();
        hoverSection('agents');
        await screen.findByTestId('subflyout-agents');
        const row = screen.getByTestId('nav-recent-agents-ag1');
        expect(row.textContent).not.toContain('best practices');
        expect(row.textContent).toContain('…');
    });

    it('falls back to a relative time for a section with no descriptions', async () => {
        fetchMock.impl = async (url) => (String(url).includes('/api/transcriptions')
            ? { ok: true, json: async () => ({ transcriptions: [{ id: 'm1', title: 'Standup', updatedAt: new Date().toISOString() }] }) }
            : { ok: false });
        renderSidebar();
        openStudioFlyout();
        hoverSection('meetingNotes');
        await screen.findByTestId('subflyout-meetingNotes');
        expect(screen.getByTestId('nav-recent-meetingNotes-m1').textContent).toMatch(/just now/);
    });

    it('deep-links to the item, not merely to the section', async () => {
        serveAgents();
        const onNavigate = vi.fn();
        renderSidebar({ onNavigate });
        openStudioFlyout();
        hoverSection('agents');
        await screen.findByTestId('subflyout-agents');
        fireEvent.click(screen.getByTestId('nav-recent-agents-ag2'));
        expect(onNavigate).toHaveBeenLastCalledWith('studio/agents/ag2');
    });

    it('offers a way out to the whole section', async () => {
        serveAgents();
        const onNavigate = vi.fn();
        renderSidebar({ onNavigate });
        openStudioFlyout();
        hoverSection('agents');
        await screen.findByTestId('subflyout-agents');
        fireEvent.click(screen.getByTestId('nav-recent-agents-all'));
        expect(onNavigate).toHaveBeenLastCalledWith('studio/agents');
    });

    it('picking an item closes both levels', async () => {
        serveAgents();
        renderSidebar();
        openStudioFlyout();
        hoverSection('agents');
        await screen.findByTestId('subflyout-agents');
        fireEvent.click(screen.getByTestId('nav-recent-agents-ag1'));
        expect(screen.queryByTestId('subflyout-agents')).toBeNull();
        expect(screen.queryByTestId('flyout-studio')).toBeNull();
    });

    it('Escape closes both levels', async () => {
        serveAgents();
        renderSidebar();
        openStudioFlyout();
        hoverSection('agents');
        await screen.findByTestId('subflyout-agents');
        fireEvent.keyDown(document, { key: 'Escape' });
        expect(screen.queryByTestId('subflyout-agents')).toBeNull();
        expect(screen.queryByTestId('flyout-studio')).toBeNull();
    });

    /**
     * The reason a panel is only advertised once it HAS rows: every section
     * starts empty, and a box that opens blank and then fills is worse than one
     * that appears when it has something to say.
     */
    it('opens no panel for a section with nothing in it', async () => {
        renderSidebar();
        openStudioFlyout();
        hoverSection('skills');
        await waitFor(() => expect(screen.getByTestId('nav-studio-skills')).toBeTruthy());
        expect(screen.queryByTestId('subflyout-skills')).toBeNull();
    });

    it('a failing section list leaves the flyout itself entirely usable', async () => {
        const onNavigate = vi.fn();
        fetchMock.impl = async () => { throw new Error('403'); };
        renderSidebar({ onNavigate });
        openStudioFlyout();
        hoverSection('skills');
        await waitFor(() => expect(screen.queryByTestId('subflyout-skills')).toBeNull());
        fireEvent.click(screen.getByTestId('nav-studio-skills'));
        expect(onNavigate).toHaveBeenLastCalledWith('studio/skills');
    });

    it('fetches a section once, on first hover — not eight lists up front', async () => {
        const seen = [];
        fetchMock.impl = async (url) => {
            seen.push(String(url));
            return { ok: true, json: async () => ({ automations: [{ id: 'r1', title: 'Offerte', updatedAt: '2026-08-01T10:00:00Z' }] }) };
        };
        renderSidebar();
        openStudioFlyout();
        // Nothing is requested for a section nobody has looked at.
        expect(seen.filter(u => u.endsWith('/api/automation'))).toHaveLength(0);
        hoverSection('aiTasks');
        await screen.findByTestId('subflyout-aiTasks');
        hoverSection('aiTasks');
        await waitFor(() => expect(seen.filter(u => u.endsWith('/api/automation'))).toHaveLength(1));
    });

    it('an item you opened outranks one that was merely updated later', async () => {
        storeMock.data.studioRecents = JSON.stringify({ agents: { ag2: Date.now() } });
        serveAgents();
        renderSidebar();
        openStudioFlyout();
        hoverSection('agents');
        const panel = await screen.findByTestId('subflyout-agents');
        const ids = [...panel.querySelectorAll('[data-testid^="nav-recent-agents-"]')]
            .map(el => el.getAttribute('data-testid'));
        // ag1 has the newer updated_at; ag2 wins because it is the one YOU opened.
        expect(ids[0]).toBe('nav-recent-agents-ag2');
    });
});
