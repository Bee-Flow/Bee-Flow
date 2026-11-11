import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { jsonAnswer } from '@/test/http';
import AppRunPage, { RunSurface } from './AppRunPage';

/**
 * A URL per screen of a running app (#/s/<screenId>?p.<key>=…).
 *
 * Only the network is stubbed. Everything above it is real: the api client,
 * AppShell's nav, the action runner's navigate, RunSurface's one navigation
 * callback and the browser history of jsdom. Back and Forward are the real
 * history.back()/forward(), which fire popstate the way a browser does.
 */

interface Viewer { id: string; name: string; email: string; isOwner: boolean; roleKey: string | null }
const MEMBER: Viewer = { id: 'u-1', name: 'Vera Viewer', email: 'vera@example.test', isOwner: false, roleKey: 'member' };
const OWNER: Viewer = { ...MEMBER, isOwner: true, roleKey: null };

function screenOf(id: string, name: string, children: unknown[], extra: Record<string, unknown> = {}) {
    return {
        id, name, icon: null, showInNav: true, maxWidth: 'medium', ...extra,
        sections: [{ id: `sec_${id.slice(4)}`, style: { padding: 4, gap: 3, background: 'none' }, children }],
    };
}

function heading(id: string, text: string) {
    return { id, type: 'heading', visible: true, props: { text, level: 2 }, style: { span: 12 } };
}

const DEFINITION = {
    schemaVersion: 2,
    meta: { name: 'Route probe', description: '', icon: 'LayoutGrid' },
    theme: { primary: '#0F766E', radius: 'md', density: 'comfortable', fontScale: 'md', appearance: 'auto' },
    homeScreenId: 'scr_main01',
    screens: [
        screenOf('scr_main01', 'Main', [
            heading('cmp_hmain1', 'Main screen'),
            { id: 'cmp_gobtn1', type: 'button', visible: true, onClick: 'act_go0001', props: { label: 'Open record', variant: 'secondary', role: 'button' }, style: { span: 3 } },
            { id: 'cmp_gobtn2', type: 'button', visible: true, onClick: 'act_go0002', props: { label: 'Open count', variant: 'secondary', role: 'button' }, style: { span: 3 } },
        ]),
        screenOf('scr_list01', 'List', [heading('cmp_hlist1', 'List screen')]),
        screenOf('scr_detail1', 'Detail', [
            { id: 'cmp_recid1', type: 'text', visible: true, props: { text: 'no-record', muted: false }, computed: { text: 'screen.params.recordId' }, style: { span: 12 } },
            // A number param plus one: 43 when the param is still a number, "421" once it became text.
            { id: 'cmp_count1', type: 'text', visible: true, props: { text: 'no-count', muted: false }, computed: { text: 'screen.params.count + 1' }, style: { span: 12 } },
        ], { showInNav: false }),
        screenOf('scr_admin1', 'Admin', [heading('cmp_hadm01', 'Admin screen')], { visibleToRoles: ['admin'] }),
    ],
    actions: {
        act_go0001: { kind: 'navigate', screenId: 'scr_detail1', params: { recordId: { kind: 'static', value: 'rec_42' } } },
        act_go0002: { kind: 'navigate', screenId: 'scr_detail1', params: { count: { kind: 'formula', expr: '41 + 1' } } },
    },
};

let runtimeLoads = 0;

function renderPage(viewer: Viewer = MEMBER, definition: unknown = DEFINITION) {
    const payload = { id: 'app-1', name: 'Route probe', icon: null, accentColor: null, definition, viewer };
    vi.stubGlobal('fetch', vi.fn(async (url: unknown) => {
        if (String(url).includes('/app-1/runtime')) {
            runtimeLoads += 1;
            return jsonAnswer(payload);
        }
        return jsonAnswer({ connectors: [], records: [] });
    }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
    return render(<QueryClientProvider client={client}><AppRunPage appId="app-1" /></QueryClientProvider>);
}

function shownScreen(container: HTMLElement) {
    return container.querySelector('[data-app-screen]')?.getAttribute('data-app-screen') ?? null;
}

async function traverse(step: 'back' | 'forward') {
    await act(async () => {
        const moved = new Promise((resolve) => { window.addEventListener('popstate', resolve, { once: true }); });
        if (step === 'back') window.history.back(); else window.history.forward();
        await moved;
    });
}

beforeEach(() => {
    window.history.replaceState(null, '', '/app/apps/app-1');
    runtimeLoads = 0;
});

afterEach(() => vi.unstubAllGlobals());

describe('AppRunPage — a URL per screen', () => {
    it('opens on the home screen and leaves the URL alone until the viewer moves', async () => {
        const { container } = renderPage();
        await screen.findByRole('heading', { name: 'Main screen' });
        expect(shownScreen(container)).toBe('scr_main01');
        expect(window.location.hash).toBe('');
    });

    it('a nav click writes the screen into the URL; Back and Forward move between screens', async () => {
        const user = userEvent.setup();
        const { container } = renderPage();
        await screen.findByRole('heading', { name: 'Main screen' });

        const nav = screen.getByRole('navigation', { name: 'App screens' });
        await user.click(within(nav).getByRole('button', { name: /List/ }));
        await screen.findByRole('heading', { name: 'List screen' });
        expect(window.location.hash).toBe('#/s/scr_list01');
        // The path and query are the host's and stay as they were.
        expect(window.location.pathname).toBe('/app/apps/app-1');

        await traverse('back');
        await waitFor(() => expect(shownScreen(container)).toBe('scr_main01'));
        expect(window.location.hash).toBe('');

        await traverse('forward');
        await waitFor(() => expect(shownScreen(container)).toBe('scr_list01'));
    });

    it('clicking the screen you are on adds no history step', async () => {
        const user = userEvent.setup();
        renderPage();
        await screen.findByRole('heading', { name: 'Main screen' });
        const nav = screen.getByRole('navigation', { name: 'App screens' });
        await user.click(within(nav).getByRole('button', { name: /List/ }));
        const length = window.history.length;
        await user.click(within(nav).getByRole('button', { name: /List/ }));
        expect(window.history.length).toBe(length);
    });

    it('a navigate action carries its params in the URL, and Back restores them exactly', async () => {
        const user = userEvent.setup();
        const { container } = renderPage();
        await user.click(await screen.findByText('Open count'));
        expect(await screen.findByText('43')).toBeTruthy();
        expect(window.location.hash).toBe('#/s/scr_detail1?p.count=42');

        const nav = screen.getByRole('navigation', { name: 'App screens' });
        await user.click(within(nav).getByRole('button', { name: /List/ }));
        await screen.findByRole('heading', { name: 'List screen' });

        // Back to the detail screen: the param is the number it was, not "42".
        await traverse('back');
        await waitFor(() => expect(shownScreen(container)).toBe('scr_detail1'));
        expect(await screen.findByText('43')).toBeTruthy();
    });

    it('a link opens its screen with its params, with one load and no detour via home', async () => {
        window.history.replaceState(null, '', '/app/apps/app-1#/s/scr_detail1?p.recordId=rec_7');
        const { container } = renderPage();
        expect(await screen.findByText('rec_7')).toBeTruthy();
        expect(shownScreen(container)).toBe('scr_detail1');
        expect(screen.queryByRole('heading', { name: 'Main screen' })).toBeNull();
        expect(runtimeLoads).toBe(1);
    });

    it('a link to a screen the viewer’s role may not see opens the home screen and drops the fragment', async () => {
        window.history.replaceState(null, '', '/app/apps/app-1#/s/scr_admin1');
        const { container } = renderPage(MEMBER);
        await screen.findByRole('heading', { name: 'Main screen' });
        expect(shownScreen(container)).toBe('scr_main01');
        expect(screen.queryByRole('heading', { name: 'Admin screen' })).toBeNull();
        await waitFor(() => expect(window.location.hash).toBe(''));
    });

    it('a viewer without a role is refused the gated screen too (fails closed)', async () => {
        window.history.replaceState(null, '', '/app/apps/app-1#/s/scr_admin1');
        const { container } = renderPage({ ...MEMBER, roleKey: null });
        await screen.findByRole('heading', { name: 'Main screen' });
        expect(shownScreen(container)).toBe('scr_main01');
    });

    it('the owner may open the gated screen from a link', async () => {
        window.history.replaceState(null, '', '/app/apps/app-1#/s/scr_admin1');
        renderPage(OWNER);
        expect(await screen.findByRole('heading', { name: 'Admin screen' })).toBeTruthy();
        expect(window.location.hash).toBe('#/s/scr_admin1');
    });

    it('a link to a screen that does not exist opens the home screen', async () => {
        window.history.replaceState(null, '', '/app/apps/app-1#/s/scr_nope01');
        const { container } = renderPage();
        await screen.findByRole('heading', { name: 'Main screen' });
        expect(shownScreen(container)).toBe('scr_main01');
        await waitFor(() => expect(window.location.hash).toBe(''));
    });

    it('Back onto an entry the role gate refuses shows the home screen, as a cold link would', async () => {
        const user = userEvent.setup();
        const { container } = renderPage();
        await screen.findByRole('heading', { name: 'Main screen' });
        // An entry naming the gated screen, then a real navigation on top of it.
        window.history.pushState(null, '', '/app/apps/app-1#/s/scr_admin1');
        const nav = screen.getByRole('navigation', { name: 'App screens' });
        await user.click(within(nav).getByRole('button', { name: /List/ }));
        await screen.findByRole('heading', { name: 'List screen' });

        await traverse('back');
        await waitFor(() => expect(shownScreen(container)).toBe('scr_main01'));
        expect(window.location.hash).toBe('');
    });

    it('a fragment that is not a screen route is left as it is', async () => {
        window.history.replaceState(null, '', '/app/apps/app-1#top');
        const { container } = renderPage();
        await screen.findByRole('heading', { name: 'Main screen' });
        expect(shownScreen(container)).toBe('scr_main01');
        expect(window.location.hash).toBe('#top');
    });

    it('keeps the host query (the Nextcloud app-menu embed, a draft preview) when it writes a screen', async () => {
        window.history.replaceState(null, '', '/app/apps/app-1?draft=1');
        const user = userEvent.setup();
        renderPage();
        await screen.findByRole('heading', { name: 'Main screen' });
        const nav = screen.getByRole('navigation', { name: 'App screens' });
        await user.click(within(nav).getByRole('button', { name: /List/ }));
        await screen.findByRole('heading', { name: 'List screen' });
        expect(window.location.search).toBe('?draft=1');
        expect(window.location.hash).toBe('#/s/scr_list01');
    });
});

describe('RunSurface without urlRoute', () => {
    function Host({ onNavigate }: { onNavigate: (id: string) => void }) {
        return (
            <RunSurface
                appId="app-1"
                draft={false}
                definition={DEFINITION as unknown as React.ComponentProps<typeof RunSurface>['definition']}
                screenId="scr_main01"
                viewer={MEMBER}
                onNavigate={onNavigate}
            />
        );
    }

    it('never touches the URL: hosts that did not ask keep today’s behaviour', async () => {
        const user = userEvent.setup();
        const onNavigate = vi.fn();
        vi.stubGlobal('fetch', vi.fn(async () => jsonAnswer({ connectors: [], records: [] })));
        const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
        render(<QueryClientProvider client={client}><Host onNavigate={onNavigate} /></QueryClientProvider>);
        await screen.findByRole('heading', { name: 'Main screen' });
        const length = window.history.length;
        const nav = screen.getByRole('navigation', { name: 'App screens' });
        await user.click(within(nav).getByRole('button', { name: /List/ }));
        expect(onNavigate).toHaveBeenCalledWith('scr_list01');
        expect(window.location.hash).toBe('');
        expect(window.history.length).toBe(length);
    });
});
