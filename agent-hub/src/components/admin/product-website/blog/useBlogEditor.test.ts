import { notifyManager } from '@tanstack/react-query';
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { queryWrapper } from '@/test/queryWrapper';

import type { AdminPost, AdminPostSummary } from './blogApi';
import useBlogEditor from './useBlogEditor';

// Under fake timers the query would hand its answer to React on a 0 ms timer; a
// microtask keeps the answer inside the tick that produced it.
notifyManager.setScheduler(queueMicrotask);


const post = (over: Partial<AdminPost> = {}): AdminPost => ({
    id: 'p1', slug: 'hello', title: 'Hello', excerpt: '', body: 'Body', coverImage: '', coverAlt: '', authorName: 'Sam',
    tags: ['News'], status: 'draft', publishedAt: null, seo: { metaTitle: '', metaDescription: '', ogImage: '', noIndex: false },
    createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', ...over,
});
const row = (over: Partial<AdminPostSummary> = {}): AdminPostSummary => ({
    id: 'p1', slug: 'hello', title: 'Hello', excerpt: '', status: 'draft', publishedAt: null, updatedAt: null, coverImage: '',
    tags: [], translatedLocales: [], ...over,
});

interface Call { method: string; url: string; body: unknown }
let calls: Call[] = [];
type Reply = { status?: number; body: unknown };
let routes: (call: Call) => Reply | Promise<Reply>;

const sent = (method: string) => calls.filter(c => c.method === method);
const settle = () => act(async () => { await vi.advanceTimersByTimeAsync(0); });
const wait = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

/** The server most cases talk to: site s1 has one post, p1, with a Dutch translation. */
function server(over: Partial<Record<string, (call: Call) => Reply>> = {}) {
    routes = (call) => {
        const key = `${call.method} ${call.url}`;
        if (over[key]) return over[key](call);
        if (call.method === 'GET' && call.url.endsWith('/posts')) return { body: { posts: [row()] } };
        if (call.method === 'GET') return { body: { post: post(), translations: { nl: { title: 'Hallo' } } } };
        if (call.method === 'PUT' && call.url.includes('/locale/')) return { body: { ok: true } };
        if (call.method === 'PUT') return { body: { post: post({ ...(call.body as Partial<AdminPost>), updatedAt: '2026-02-02T00:00:00Z' }) } };
        if (call.method === 'POST') return { body: { post: post({ id: 'p2', slug: 'new', title: (call.body as { title: string }).title }) } };
        return { body: { ok: true } };
    };
}

const mount = (props: { siteId?: string | null; enabled?: boolean; onSaved?: () => void } = {}) => renderHook(
    (p: { siteId?: string | null; enabled?: boolean }) => useBlogEditor({ siteId: 's1', enabled: true, ...props, ...p }),
    { wrapper: queryWrapper(), initialProps: {} },
);

beforeEach(() => {
    vi.useFakeTimers();
    calls = [];
    server();
    // The requests are seen at the browser's fetch, under the session and CSRF headers authFetch adds.
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
        const call: Call = { method: (init?.method || 'GET').toUpperCase(), url: String(url).replace(/^.*(?=\/api\/cms\/)/, ''), body: init?.body ? JSON.parse(String(init.body)) : undefined };
        calls.push(call);
        const { status = 200, body } = await routes(call);
        return { ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body) } as unknown as Response;
    });
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('useBlogEditor: the post list', () => {
    it('loads when the Blog view opens, not before, and not again when it reopens', async () => {
        const { result, rerender } = mount({ enabled: false });
        await settle();
        expect(calls).toEqual([]);
        expect(result.current.loaded).toBe(false);
        rerender({ enabled: true });
        await settle();
        expect(calls.map(c => `${c.method} ${c.url}`)).toEqual(['GET /api/cms/sites/s1/posts']);
        expect(result.current).toMatchObject({ loaded: true, error: null, posts: [{ id: 'p1' }] });
        rerender({ enabled: false });
        rerender({ enabled: true });
        await settle();
        expect(sent('GET')).toHaveLength(1);
    });

    it('a refused load reports the server text and counts as loaded; reload asks again and clears it', async () => {
        server({ 'GET /api/cms/sites/s1/posts': () => ({ status: 403, body: { error: 'No access to this site.' } }) });
        const { result } = mount();
        await settle();
        expect(result.current).toMatchObject({ loaded: true, error: 'No access to this site.', posts: [] });
        server();
        await act(() => result.current.reload());
        expect(result.current).toMatchObject({ error: null, posts: [{ id: 'p1' }] });
        expect(sent('GET')).toHaveLength(2);
    });

    it('a site switch sends pending edits to the old site, then shows the new site with no post open', async () => {
        server({ 'GET /api/cms/sites/s2/posts': () => ({ body: { posts: [row({ id: 'q1', title: 'Other' })] } }) });
        const { result, rerender } = mount();
        await settle();
        await act(() => result.current.selectPost('p1'));
        act(() => result.current.updatePost({ title: 'Edited' }));
        rerender({ siteId: 's2' });
        await settle();
        expect(sent('PUT').map(c => c.url)).toEqual(['/api/cms/sites/s1/posts/p1']);
        expect(calls.some(c => c.method === 'GET' && c.url === '/api/cms/sites/s2/posts')).toBe(true);
        expect(result.current).toMatchObject({ loaded: true, post: null, activePostId: null, posts: [{ id: 'q1' }] });
    });
});

describe('useBlogEditor: editing', () => {
    async function opened(props: Parameters<typeof mount>[0] = {}) {
        const view = mount(props);
        await settle();
        await act(() => view.result.current.selectPost('p1'));
        return view;
    }

    it('opening a post reads it with its translations', async () => {
        const { result } = await opened();
        expect(result.current).toMatchObject({ activePostId: 'p1', post: { id: 'p1', title: 'Hello' }, translations: { nl: { title: 'Hallo' } } });
        expect(sent('GET').map(c => c.url)).toEqual(['/api/cms/sites/s1/posts', '/api/cms/sites/s1/posts/p1']);
    });

    it('edits show at once, and go out as one PUT of the editable fields 700 ms after the last one', async () => {
        const onSaved = vi.fn();
        const { result } = await opened({ onSaved });
        act(() => result.current.updatePost({ title: 'One' }));
        await wait(600);
        act(() => result.current.updatePost({ title: 'Two', seo: { ...post().seo, metaTitle: 'T' } }));
        expect(result.current.post?.title).toBe('Two');
        expect(result.current.posts[0].title).toBe('Two');
        await wait(699);
        expect(sent('PUT')).toHaveLength(0);
        await wait(1);
        expect(sent('PUT')).toHaveLength(1);
        expect(sent('PUT')[0]).toMatchObject({ url: '/api/cms/sites/s1/posts/p1', body: { title: 'Two', slug: 'hello', seo: { metaTitle: 'T', noIndex: false } } });
        expect(Object.keys(sent('PUT')[0].body as object)).not.toContain('id');
        expect(result.current.saveStatus).toBe('saved');
        expect(result.current.post?.updatedAt).toBe('2026-02-02T00:00:00Z');
        expect(result.current.posts[0].updatedAt).toBe('2026-02-02T00:00:00Z');
        expect(onSaved).toHaveBeenCalledTimes(1);
    });

    it('a refused save says so and the next edit sends the work again', async () => {
        let refuse = true;
        server({ 'PUT /api/cms/sites/s1/posts/p1': (call) => (refuse
            ? { status: 409, body: { error: 'Slug already in use.' } }
            : { body: { post: post(call.body as Partial<AdminPost>) } }) });
        const { result } = await opened();
        act(() => result.current.updatePost({ slug: 'taken' }));
        await wait(700);
        expect(result.current).toMatchObject({ saveStatus: 'error', error: 'Slug already in use.' });
        refuse = false;
        act(() => result.current.updatePost({ title: 'Again' }));
        await wait(700);
        expect(sent('PUT')).toHaveLength(2);
        expect(sent('PUT')[1].body).toMatchObject({ slug: 'taken', title: 'Again' });
        expect(result.current).toMatchObject({ saveStatus: 'saved', error: null });
    });

    it('a translation edit sends the merged override and marks the row as translated', async () => {
        const { result } = await opened();
        act(() => result.current.updateTranslation('nl', { excerpt: 'Kort' }));
        await wait(700);
        expect(sent('PUT')).toEqual([{ method: 'PUT', url: '/api/cms/sites/s1/posts/p1/locale/nl', body: { override: { title: 'Hallo', excerpt: 'Kort' } } }]);
        expect(result.current.posts[0].translatedLocales).toEqual(['nl']);
    });

    it('flush sends at once, and leaving the editor sends what is pending', async () => {
        const { result, unmount } = await opened();
        act(() => result.current.updatePost({ title: 'Now' }));
        await act(() => result.current.flush());
        expect(sent('PUT')).toHaveLength(1);
        act(() => result.current.updatePost({ title: 'Leaving' }));
        unmount();
        await settle();
        expect(sent('PUT')).toHaveLength(2);
        expect(sent('PUT')[1].body).toMatchObject({ title: 'Leaving' });
    });

    it('creates a post at the top of the list and opens it; deleting the open post closes it', async () => {
        const onSaved = vi.fn();
        const { result } = await opened({ onSaved });
        await act(async () => { await result.current.createPost('Fresh'); });
        expect(sent('POST')).toEqual([{ method: 'POST', url: '/api/cms/sites/s1/posts', body: { title: 'Fresh' } }]);
        expect(result.current).toMatchObject({ activePostId: 'p2', post: { id: 'p2' }, translations: {} });
        expect(result.current.posts.map(p => p.id)).toEqual(['p2', 'p1']);
        await act(async () => { await result.current.deletePost('p2'); });
        expect(sent('DELETE').map(c => c.url)).toEqual(['/api/cms/sites/s1/posts/p2']);
        expect(result.current).toMatchObject({ activePostId: null, post: null });
        expect(result.current.posts.map(p => p.id)).toEqual(['p1']);
        expect(onSaved).toHaveBeenCalledTimes(2);
    });

    it('a refused delete keeps the post and reports the server text', async () => {
        server({ 'DELETE /api/cms/sites/s1/posts/p1': () => ({ status: 500, body: { error: 'Could not delete.' } }) });
        const { result } = await opened();
        let ok = true;
        await act(async () => { ok = await result.current.deletePost('p1'); });
        expect(ok).toBe(false);
        expect(result.current).toMatchObject({ error: 'Could not delete.', activePostId: 'p1' });
        expect(result.current.posts.map(p => p.id)).toEqual(['p1']);
    });
});
