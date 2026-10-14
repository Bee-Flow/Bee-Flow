import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import SitemapView from './SitemapView';
import { authFetch } from '../../../utils/helpers';

vi.mock('../../../utils/helpers', () => ({ API_BASE: '', authFetch: vi.fn() }));
vi.mock('../../../hooks/useTranslation', () => ({
    useTranslation: () => ({
        t: (key: string, fallback?: unknown, params?: Record<string, unknown>) => {
            let s = typeof fallback === 'string' ? fallback : key;
            for (const [k, v] of Object.entries(params || {})) s = s.replace(`{${k}}`, String(v));
            return s;
        },
    }),
}));

const fetchMock = vi.mocked(authFetch);
const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body }) as unknown as Response;

const payload = {
    site: {
        pages: [
            { id: 'p1', title: 'Home', slug: 'home', isHomepage: true },
            { id: 'p2', title: 'About', slug: 'about' },
        ],
        header: { nav: [{ id: 'n1', label: 'About', link: { kind: 'page', pageId: 'p2' } }] },
        footer: {},
    },
    pages: [{ id: 'p1', blocks: [] }, { id: 'p2', blocks: [] }],
};

beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockImplementation(async () => ok(payload));
});
afterEach(cleanup);

describe('SitemapView', () => {
    it('draws the pages with their badges and counts', async () => {
        render(<SitemapView siteId="s1" activePageId="p1" />);
        const counts = '2 pages · 1 chrome link · 0 internal links';
        expect(await screen.findByText((_, el) => el?.tagName === 'SPAN' && el.textContent === counts)).toBeTruthy();
        expect(screen.getAllByText('Home')).toHaveLength(2); // the title and the Home badge
        expect(screen.getByText('In nav')).toBeTruthy();
        expect(screen.getByText('Header / Footer')).toBeTruthy();
    });

    it('takes a page out of the nav from its settings flyout and tells the host', async () => {
        const user = userEvent.setup();
        const onMutated = vi.fn();
        render(<SitemapView siteId="s1" activePageId={null} onMutated={onMutated} />);
        await user.click(await screen.findByRole('button', { name: 'Edit page About' }));
        const toggle = screen.getByRole('switch');
        expect(toggle.getAttribute('aria-checked')).toBe('true');
        await user.click(toggle);
        await waitFor(() => expect(onMutated).toHaveBeenCalled());
        const put = fetchMock.mock.calls.find(([, opts]) => (opts as RequestInit | undefined)?.method === 'PUT');
        const body = JSON.parse(String((put?.[1] as RequestInit).body));
        expect(body.site.header.nav).toEqual([]);
    });
});
