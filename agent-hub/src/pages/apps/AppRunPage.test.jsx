import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import AppRunPage from './AppRunPage';
import AppsHomePage, { readAppRecents } from './AppsHomePage';
import { KITCHEN_SINK } from '../../components/admin/Studio/AppStudio/state/sampleDefinitions';
import { studioAppsApi } from '../../components/admin/Studio/AppStudio/studioAppsApi';
import { authFetch } from '../../utils/helpers';
import scopedStorage from '../../utils/scopedStorage';

// vi.mock is hoisted above the imports, so the component under test receives
// the mocked api despite the import order.
vi.mock('../../components/admin/Studio/AppStudio/studioAppsApi', () => {
    const studioAppsApi = { getRuntime: vi.fn(), listAccessible: vi.fn(), listMine: vi.fn() };
    return { studioAppsApi, default: studioAppsApi };
});

// The real network door. AppRunPage imports authFetch itself, so a claim
// about what this page does or does not send has to be measured HERE — the
// api-module mock above cannot see a call that goes around it.
vi.mock('../../utils/helpers', async (importOriginal) => {
    const actual = await importOriginal();
    return { ...actual, authFetch: vi.fn() };
});

const RUNTIME_PAYLOAD = {
    id: 'app-1',
    name: 'Kitchen sink',
    icon: 'LayoutGrid',
    accentColor: '#0F766E',
    definition: KITCHEN_SINK,
};

beforeEach(() => {
    vi.clearAllMocks();
    studioAppsApi.getRuntime.mockResolvedValue(RUNTIME_PAYLOAD);
    studioAppsApi.listAccessible.mockResolvedValue({ apps: [] });
    studioAppsApi.listMine.mockResolvedValue({ apps: [] });
    authFetch.mockResolvedValue({ ok: true, status: 200, json: async () => ({ connectors: [] }) });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: true, status: 200, json: async () => ({}) });
    document.title = 'BeeFlow';
    localStorage.clear();
    scopedStorage.setCurrentUser('viewer-1');
});

describe('AppRunPage', () => {
    it('renders the app shell with the app name and the home screen content', async () => {
        render(<AppRunPage appId="app-1" />);

        // App name in the shell top bar + a real heading from the definition.
        expect(await screen.findByText('Kitchen sink')).toBeInTheDocument();
        expect(screen.getByRole('heading', { name: 'Team dashboard' })).toBeInTheDocument();
        expect(studioAppsApi.getRuntime).toHaveBeenCalledWith('app-1', { draft: false });

        // Browser tab title follows the app while mounted. Awaited, not read
        // straight after findByText: the title is set in an effect, and React
        // flushes passive effects a tick AFTER the DOM change that findByText
        // is watching for. Reading it synchronously is a coin flip — that is
        // the intermittent 'expected BeeFlow to be Kitchen sink' this suite
        // has been showing.
        await waitFor(() => expect(document.title).toBe('Kitchen sink'));
    });

    it('restores the previous document title on unmount', async () => {
        const { unmount } = render(<AppRunPage appId="app-1" />);
        await screen.findByText('Kitchen sink');
        await waitFor(() => expect(document.title).toBe('Kitchen sink'));
        unmount();
        expect(document.title).toBe('BeeFlow');
    });

    it('requests the draft definition when draft is set', async () => {
        render(<AppRunPage appId="app-1" draft />);
        await screen.findByText('Kitchen sink');
        expect(studioAppsApi.getRuntime).toHaveBeenCalledWith('app-1', { draft: true });
    });

    it('renders the friendly empty state on 404 and retries on demand', async () => {
        const err = new Error('App not found');
        err.status = 404;
        studioAppsApi.getRuntime.mockRejectedValueOnce(err);

        render(<AppRunPage appId="app-1" />);
        expect(await screen.findByText('This app is not available to you')).toBeInTheDocument();

        // Retry: the second call succeeds and the app renders.
        fireEvent.click(screen.getByRole('button', { name: /Try again/ }));
        expect(await screen.findByText('Kitchen sink')).toBeInTheDocument();
        await waitFor(() => expect(studioAppsApi.getRuntime).toHaveBeenCalledTimes(2));
    });

    it('tells an org member outside the audience that the app is shared with specific groups', async () => {
        // The server's 403 not_in_audience: you are in the org, the app exists,
        // you are just not in the groups it went to. Inside Nextcloud the icon
        // is instance-wide, so this is the screen a colleague lands on — it
        // must say what to do, not "not found".
        const err = new Error('This app is shared with specific groups in your organisation');
        err.status = 403;
        err.code = 'not_in_audience';
        studioAppsApi.getRuntime.mockRejectedValueOnce(err);

        render(<AppRunPage appId="app-1" />);
        expect(await screen.findByText('This app is shared with specific groups')).toBeInTheDocument();
        expect(screen.getByText(/Ask the app’s owner or your administrator to share it with your group/)).toBeInTheDocument();
        expect(screen.queryByText('This app is not available to you')).not.toBeInTheDocument();
        expect(screen.getByRole('button', { name: /Try again/ })).toBeInTheDocument();
    });

    it('a plain 403 still reads as "not available" — only the coded refusal names groups', async () => {
        const err = new Error('Forbidden');
        err.status = 403;
        studioAppsApi.getRuntime.mockRejectedValueOnce(err);

        render(<AppRunPage appId="app-1" />);
        expect(await screen.findByText('This app is not available to you')).toBeInTheDocument();
        expect(screen.queryByText('This app is shared with specific groups')).not.toBeInTheDocument();
    });

    it('switches screens when a nav tab is clicked', async () => {
        const { container } = render(<AppRunPage appId="app-1" />);
        await screen.findByText('Kitchen sink');

        // Home screen first.
        expect(container.querySelector('[data-app-screen="scr_dash01"]')).not.toBeNull();

        const nav = screen.getByRole('navigation', { name: 'App screens' });
        fireEvent.click(within(nav).getByRole('button', { name: /New request/ }));

        await waitFor(() => {
            expect(container.querySelector('[data-app-screen="scr_form01"]')).not.toBeNull();
        });
        expect(screen.getByRole('heading', { name: 'New request' })).toBeInTheDocument();
        expect(screen.getByLabelText(/Subject/)).toBeInTheDocument();
    });
});

// ── APPS-05: the open signal behind the directory's "Recently used" ──
// The stamp lives at the destination rather than on the tile that was clicked,
// so a bookmark and a colleague's link count exactly like a tile does. It stays
// on this device, in per-user scoped storage — nothing is sent to the server.
describe('AppRunPage recording an open', () => {
    it('records an app that actually opened', async () => {
        render(<AppRunPage appId="app-1" />);
        await screen.findByText('Kitchen sink');
        await waitFor(() => expect(readAppRecents()['app-1']).toBeGreaterThan(0));
    });

    it('does not record a draft preview', async () => {
        render(<AppRunPage appId="app-1" draft />);
        await screen.findByText('Kitchen sink');
        // The builder inspecting their own unpublished work is not a reader
        // reaching for a tool, so it may not colour their shortcuts.
        expect(readAppRecents()).toEqual({});
    });

    it('does not record a load that failed', async () => {
        const err = new Error('App not found');
        err.status = 404;
        studioAppsApi.getRuntime.mockRejectedValue(err);

        render(<AppRunPage appId="app-1" />);
        await screen.findByText('This app is not available to you');
        // A 404 is not an open — offering it back as a shortcut would send the
        // reader straight into the same dead end.
        expect(readAppRecents()).toEqual({});
    });

    it('sends nothing to the server for the sake of the recents list', async () => {
        render(<AppRunPage appId="app-1" />);
        await screen.findByText('Kitchen sink');
        await waitFor(() => expect(readAppRecents()['app-1']).toBeGreaterThan(0));

        // Measured at the network door, not on the api module: the page
        // imports authFetch directly, so a "who opened what" call could walk
        // straight past a mocked api object. Whether a per-person attendance
        // log should exist is a question this product has not asked out loud
        // yet, and until it does, opening an app writes nothing anywhere but
        // this device.
        const requests = [
            ...authFetch.mock.calls.map(([url, options]) => [String(url), options]),
            ...globalThis.fetch.mock.calls.map(([url, options]) => [String(url), options]),
        ];
        for (const [url, options] of requests) {
            const method = String(options?.method || 'GET').toUpperCase();
            expect(`${method} ${url}`).not.toMatch(/open|recent|usage|visit|seen/i);
            // Reading is what a run page does; recording is what it must not.
            expect(method).toBe('GET');
        }
        expect(studioAppsApi.getRuntime).toHaveBeenCalledTimes(1);
    });

    // The other half of APPS-05, and the half no other test covers: the
    // helper works, but is anything in the product actually CALLING it? These
    // two screens are the whole chain — open an app, then look at the
    // directory — so losing the stamp here shows up as an empty shortcut
    // list instead of as a silently green suite.
    it('feeds the directory’s "Recently used" section, end to end', async () => {
        const { unmount } = render(<AppRunPage appId="app-1" />);
        await screen.findByText('Kitchen sink');
        await waitFor(() => expect(readAppRecents()['app-1']).toBeGreaterThan(0));
        unmount();

        studioAppsApi.listAccessible.mockResolvedValue({
            apps: [
                { id: 'app-1', name: 'Kitchen sink', isPublished: true },
                { id: 'app-2', name: 'Never Opened', isPublished: true },
            ],
        });
        render(<AppsHomePage />);
        await screen.findByText('Never Opened');

        const recent = within(await screen.findByTestId('apps-recent'));
        expect(recent.getByText('Kitchen sink')).toBeInTheDocument();
        expect(recent.queryByText('Never Opened')).not.toBeInTheDocument();
    });
});
