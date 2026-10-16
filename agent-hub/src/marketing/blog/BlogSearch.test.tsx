import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import BlogSearch from './BlogSearch';
import { parseSearchIndex, searchEntries, searchIndexUrl, type SearchEntry } from './searchIndex';
import type { BlogIndexPayload } from './blogFormat';

const entries: SearchEntry[] = [
    { k: 'post', t: 'Self-hosting guide', d: 'Run it yourself', u: '/blog/self-hosting', g: ['Guides'] },
    { k: 'post', t: 'Release notes', d: 'What changed in hosting', u: '/blog/release', g: [] },
    { k: 'page', t: 'Pricing', d: 'Plans', u: '/pricing', g: [] },
];

const blog: BlogIndexPayload = {
    view: 'index', locale: 'en', defaultLocale: 'en', basePath: '/blog', title: 'Blog', description: '', labels: {},
    posts: [], page: 1, pageCount: 1, total: 0, tag: null, tags: [],
};

afterEach(() => { vi.unstubAllGlobals(); });

describe('searchIndex', () => {
    it('ranks title hits first, needs every word, honours kinds', () => {
        expect(searchEntries(entries, 'hosting', ['post']).map((e) => e.u)).toEqual(['/blog/self-hosting', '/blog/release']);
        expect(searchEntries(entries, 'hosting guides', ['post']).map((e) => e.u)).toEqual(['/blog/self-hosting']);
        expect(searchEntries(entries, 'pricing', ['post'])).toEqual([]);
        expect(searchEntries(entries, '   ', ['post', 'page'])).toEqual([]);
    });

    it('drops malformed entries and off-site links from a tampered index', () => {
        const parsed = parseSearchIndex({ locale: 'en', entries: [entries[0], { k: 'post' }, { ...entries[1], u: 'https://evil.test/x' }, { ...entries[1], u: '//evil.test' }] });
        expect(parsed.entries).toHaveLength(1);
        expect(parseSearchIndex('nope').entries).toEqual([]);
    });

    it('prefixes the index url with the locale unless it is the default', () => {
        expect(searchIndexUrl('en', 'en')).toBe('/search-index.json');
        expect(searchIndexUrl('nl', 'en')).toBe('/nl/search-index.json');
    });
});

describe('BlogSearch', () => {
    it('loads the index on first use and lists matching posts as links', async () => {
        const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ locale: 'en', entries }) });
        vi.stubGlobal('fetch', fetchMock);
        const user = userEvent.setup();
        render(<BlogSearch blog={blog} />);
        await user.type(screen.getByRole('searchbox', { name: 'Search posts' }), 'guide');
        expect(await screen.findByRole('link', { name: 'Self-hosting guide' })).toHaveAttribute('href', '/blog/self-hosting');
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(fetchMock.mock.calls[0][0]).toBe('/search-index.json');
    });

    it('says so when nothing matches', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ locale: 'en', entries }) }));
        const user = userEvent.setup();
        render(<BlogSearch blog={blog} />);
        await user.type(screen.getByRole('searchbox'), 'zzz');
        expect(await screen.findByText('No posts match your search.')).toBeInTheDocument();
    });
});
