import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render as rtlRender, screen, fireEvent, cleanup } from '@testing-library/react';

/**
 * The Forms row in the sidebar — where a published form is actually found.
 *
 * The directory at /app/forms is the full list; this menu is the shortcut, and
 * it has to choose: at most five, "the ones YOU open" first (formRecents),
 * newest-published as the fallback.
 *
 * Since the role/visibility merge the row is also LISTED only once the
 * organisation has published a form (or it was listed last time — the answer
 * is remembered per browser, see readNavHas in sidebarTokens), and only when
 * the org role grants use_forms. The cases below serve a published form and
 * wait for the row rather than assuming it is there on first paint.
 *
 * Characterisation only (FRM-0).
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

const form = (id, title, over = {}) => ({
    id, title, url: `/f/${id}`, description: `About ${title}`,
    live: true, submissions: 0, createdAt: '2026-01-01T00:00:00Z', ...over,
});

/** Answer the org-forms endpoint with `rows`, and miss on everything else. */
const serveForms = (rows) => {
    fetchMock.impl = async (url) => (String(url).includes('/api/automation/forms')
        ? { ok: true, json: async () => ({ forms: rows }) }
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

// The row waits for the published-forms answer before it joins the menu, so
// the click has to wait for it too.
const openForms = async () => fireEvent.click(await screen.findByTestId('nav-forms'));

describe('Sidebar — the Forms row', () => {
    beforeEach(() => {
        cleanup();
        licenseMock.hasFeature = () => true;
        fetchMock.impl = async () => ({ ok: false });
        storeMock.data = {};
    });

    it('opens the menu on a click rather than navigating — All forms is the way in', async () => {
        serveForms([form('f1', 'Offerte-controle')]);
        const onNavigate = vi.fn();
        renderSidebar({ onNavigate });
        await openForms();

        // wart: the row reads as a nav item and behaves as a menu. On a
        // desktop the only way to the directory is the first child of the
        // flyout; the row's own onClick is reached on phones alone (NavRow
        // falls back to it when there is no flyout).
        expect(screen.getByTestId('flyout-forms')).toBeTruthy();
        expect(onNavigate).not.toHaveBeenCalled();

        fireEvent.click(screen.getByTestId('nav-forms-all'));
        expect(onNavigate).toHaveBeenCalledWith('forms');
    });

    it('lists the organisation\'s published forms under an All forms row', async () => {
        serveForms([form('f1', 'Offerte-controle'), form('f2', 'Aanmelden')]);
        renderSidebar();
        await openForms();

        expect(await screen.findByTestId('nav-form-f1')).toBeTruthy();
        expect(screen.getByTestId('nav-form-f2')).toBeTruthy();
        expect(screen.getByTestId('nav-forms-all')).toBeTruthy();
        expect(screen.getByText('Every form published in your organisation')).toBeTruthy();
    });

    it('offers at most five, newest first, and leaves the rest to All forms', async () => {
        serveForms(['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((id, i) => form(id, `Form ${id}`, {
            createdAt: `2026-0${i + 1}-01T00:00:00Z`,
        })));
        renderSidebar();
        await openForms();

        await screen.findByTestId('nav-form-g');
        expect(screen.queryByTestId('nav-form-a')).toBeNull();
        expect(screen.queryByTestId('nav-form-b')).toBeNull();
        expect(['c', 'd', 'e', 'f', 'g'].every(id => screen.getByTestId(`nav-form-${id}`))).toBe(true);
    });

    it('replaces the description with a warning when the automation behind a form is not live', async () => {
        serveForms([form('f1', 'Offerte-controle', { live: false })]);
        renderSidebar();
        await openForms();

        await screen.findByTestId('nav-form-f1');
        expect(screen.getByText('Not live — the automation is paused or still a draft')).toBeTruthy();
        expect(screen.queryByText('About Offerte-controle')).toBeNull();
    });

    it('opens a form in this tab and remembers the visit for next time', async () => {
        serveForms([form('f1', 'Offerte-controle')]);
        const onNavigate = vi.fn();
        renderSidebar({ onNavigate });
        await openForms();

        fireEvent.click(await screen.findByTestId('nav-form-f1'));
        expect(onNavigate).toHaveBeenCalledWith('forms/f1');
        expect(JSON.parse(storeMock.data.formRecents)).toHaveProperty('f1');
    });

    it('names an untitled form rather than rendering a blank row', async () => {
        serveForms([form('f1', '')]);
        renderSidebar();
        await openForms();
        expect(await screen.findByText('Untitled form')).toBeTruthy();
    });

    it('keeps the row usable when the forms list cannot be fetched', async () => {
        // A failed load must not take the row away: it is drawn from the last
        // remembered answer ("there were forms") and only corrected by a load
        // that actually answered.
        storeMock.data.sidebar_has_forms = '1';
        fetchMock.impl = async () => ({ ok: false });
        const onNavigate = vi.fn();
        renderSidebar({ onNavigate });
        await openForms();

        expect(await screen.findByTestId('nav-forms-all')).toBeTruthy();
        fireEvent.click(screen.getByTestId('nav-forms-all'));
        expect(onNavigate).toHaveBeenCalledWith('forms');
    });

    it('is absent altogether on an install without the automations licence', async () => {
        serveForms([form('f1', 'Offerte-controle')]);
        licenseMock.hasFeature = (f) => f !== 'automations';
        renderSidebar();
        expect(screen.queryByTestId('nav-forms')).toBeNull();
    });
});
