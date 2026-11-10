import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderWithClient } from '@/test/render';
import { jsonAnswer } from '@/test/http';
import type { AppDefinition } from '../../inspector/appDefinition';
import PublicPageTab from './PublicPageTab';

/**
 * The public page tab against the real routes' shapes (a stubbed fetch): the
 * settings write the definition's `publicAccess` block through the editor's
 * commit, the reach panel names what a visitor gets, and the URL list mints,
 * copies and revokes through the public-pages routes.
 */

const DEF: AppDefinition = {
    homeScreenId: 'scr_home01',
    screens: [
        { id: 'scr_home01', name: 'Start', sections: [{ id: 'sec_a00001', children: [{ id: 'cmp_btn001', type: 'button', onClick: 'act_send01' }] }] },
        { id: 'scr_back01', name: 'Back office', sections: [] },
    ],
    actions: { act_send01: { kind: 'toast', message: 'Thanks' } },
};

type Route = (method: string, path: string) => { status: number; body: unknown } | null;
const fetchMock = vi.fn();
const rel = (u: unknown) => String(u).replace(/^https?:\/\/[^/]+/, '');

function routeFetch(route: Route) {
    fetchMock.mockImplementation(async (url: unknown, init?: RequestInit) => {
        const hit = route(String(init?.method || 'GET'), rel(url));
        return jsonAnswer(hit ? hit.body : { error: 'not found' }, hit ? hit.status : 404);
    });
}

const PAGE = { token: 'tok123', url: 'https://example.test/p/tok123', createdAt: '2026-11-01T00:00:00Z', lastSeenAt: null, visits: 4 };
const SCHEMA = {
    model: { tables: [
        { id: 'tbl_req001', key: 'requests', name: 'Requests', access: { default: 'app', roles: { public: { create: true } } } },
        { id: 'tbl_cus001', key: 'customers', name: 'Customers', access: { default: 'app' } },
    ] },
    modelVersion: 1,
};

function defaultRoutes(pages: typeof PAGE[] = [], blockers: unknown[] = []): Route {
    return (method, path) => {
        if (path.endsWith('/schema')) return { status: 200, body: SCHEMA };
        if (path.endsWith('/members')) return { status: 200, body: { members: [] } };
        if (method === 'GET' && path.endsWith('/public-pages')) return { status: 200, body: { pages, publicAccess: null, blockers } };
        return null;
    };
}

function Harness({ initial, onCommit, readOnly = false }: { initial: AppDefinition; onCommit?: (d: AppDefinition) => void; readOnly?: boolean }) {
    const [def, setDef] = useState(initial);
    return <PublicPageTab appId="app_1" definition={def} audience="org" readOnly={readOnly} onCommit={(d) => { setDef(d); onCommit?.(d); }} />;
}

beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => { vi.unstubAllGlobals(); });

describe('settings', () => {
    it('turning the page on writes the canonical block, and off removes the key', async () => {
        routeFetch(defaultRoutes());
        const commits: AppDefinition[] = [];
        renderWithClient(<Harness initial={DEF} onCommit={(d) => commits.push(d)} />);
        await userEvent.click(screen.getByRole('checkbox', { name: /open a public page/i }));
        expect(commits.at(-1)?.publicAccess).toEqual({ entryScreenId: 'scr_home01', screenIds: ['scr_home01'], roleKey: 'public' });

        await userEvent.click(within(screen.getByTestId('public-page-screens')).getByRole('checkbox', { name: /back office/i }));
        expect((commits.at(-1)?.publicAccess as { screenIds: string[] }).screenIds).toEqual(['scr_home01', 'scr_back01']);

        await userEvent.click(screen.getByRole('checkbox', { name: /open a public page/i }));
        expect('publicAccess' in (commits.at(-1) as object)).toBe(false);
    });

    it('a look knob is written only once it differs from the app', async () => {
        routeFetch(defaultRoutes());
        const commits: AppDefinition[] = [];
        renderWithClient(<Harness initial={{ ...DEF, publicAccess: { entryScreenId: 'scr_home01', screenIds: ['scr_home01'], roleKey: 'public' } }} onCommit={(d) => commits.push(d)} />);
        const look = screen.getByTestId('public-page-look');
        await userEvent.selectOptions(within(look).getByRole('combobox', { name: 'Typeface' }), 'poppins');
        expect((commits.at(-1)?.publicAccess as { design?: unknown }).design).toEqual({ font: 'poppins' });
        await userEvent.selectOptions(within(look).getByRole('combobox', { name: 'Typeface' }), '');
        expect('design' in (commits.at(-1)?.publicAccess as object)).toBe(false);
    });

    it('a managed app shows the settings read-only', () => {
        routeFetch(defaultRoutes());
        renderWithClient(<Harness initial={{ ...DEF, publicAccess: { entryScreenId: 'scr_home01', screenIds: ['scr_home01'], roleKey: 'public' } }} readOnly />);
        expect(screen.getByRole('checkbox', { name: /open a public page/i })).toBeDisabled();
        expect(within(screen.getByTestId('public-page-screens')).getByRole('checkbox', { name: /back office/i })).toBeDisabled();
    });
});

describe('reach', () => {
    it('names the screens, the wired action and only the table that grants the public role', async () => {
        routeFetch(defaultRoutes());
        renderWithClient(<Harness initial={{ ...DEF, publicAccess: { entryScreenId: 'scr_home01', screenIds: ['scr_home01'], roleKey: 'public' } }} />);
        const reach = screen.getByTestId('public-page-reach');
        expect(reach.textContent).toContain('Start (entry)');
        expect(reach.textContent).not.toContain('Back office');
        await waitFor(() => expect(reach.textContent).toContain('In Requests, a visitor can add rows'));
        expect(reach.textContent).not.toContain('Customers');
    });
});

describe('links', () => {
    it('lists, copies and revokes a URL through the routes', async () => {
        const user = userEvent.setup();
        let pages = [PAGE];
        routeFetch((method, path) => {
            if (method === 'DELETE' && path.endsWith('/public-pages/tok123')) { pages = []; return { status: 200, body: { success: true } }; }
            return defaultRoutes(pages)(method, path);
        });
        renderWithClient(<Harness initial={DEF} />);
        expect(await screen.findByText(PAGE.url)).toBeInTheDocument();
        await user.click(screen.getByRole('button', { name: `Copy ${PAGE.url}` }));
        await expect(navigator.clipboard.readText()).resolves.toBe(PAGE.url);

        await user.click(screen.getByRole('button', { name: `Revoke ${PAGE.url}` }));
        await user.click(screen.getByRole('button', { name: 'Revoke link' }));
        await waitFor(() => expect(screen.queryByText(PAGE.url)).toBeNull());
        expect(fetchMock.mock.calls.some(([u, init]) => rel(u) === '/api/studio-apps/app_1/public-pages/tok123' && init?.method === 'DELETE')).toBe(true);
    });

    it('mints a URL, and stops offering one at the limit', async () => {
        let pages: typeof PAGE[] = [];
        routeFetch((method, path) => {
            if (method === 'POST' && path.endsWith('/public-pages')) {
                pages = [...pages, { ...PAGE, token: `t${pages.length}`, url: `https://example.test/p/t${pages.length}` }];
                return { status: 201, body: { page: pages.at(-1), blockers: [] } };
            }
            return defaultRoutes(pages)(method, path);
        });
        renderWithClient(<Harness initial={DEF} />);
        const create = await screen.findByRole('button', { name: /create a public url/i });
        for (let i = 0; i < 3; i += 1) {
            await userEvent.click(create);
            await screen.findByText(`https://example.test/p/t${i}`);
        }
        await waitFor(() => expect(screen.getByRole('button', { name: /create a public url/i })).toBeDisabled());
    });

    it('says what stands in the way, and that only the owner manages links', async () => {
        routeFetch(defaultRoutes([], [{ code: 'no_public_access' }, { code: 'not_published' }]));
        const { unmount } = renderWithClient(<Harness initial={DEF} />);
        const blockers = await screen.findByTestId('public-page-blockers');
        expect(blockers.textContent).toContain('Turn the public page on above');
        expect(blockers.textContent).toContain('The app is not published');
        unmount();

        routeFetch((method, path) => (path.endsWith('/public-pages') ? { status: 403, body: { error: 'Only the owner can manage public pages' } } : defaultRoutes()(method, path)));
        renderWithClient(<Harness initial={DEF} />);
        expect(await screen.findByText(/only the owner of the app/i)).toBeInTheDocument();
    });
});
