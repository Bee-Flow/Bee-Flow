/**
 * Sources, versions and the stored chat: the paths and bodies each route in
 * server/routes/webpages/{sources,versions,chat}.js takes, and what comes back.
 */

import { api } from '@/core/api/client';

import {
    addTextSource,
    addUrlSource,
    cancelSource,
    clearChat,
    createVersion,
    deleteSource,
    deleteVersion,
    listSources,
    listVersions,
    restoreVersion,
    retrySource,
    saveChat,
    sourceUploadTarget,
} from './buildEndpoints';

jest.mock('@/core/api/client', () => {
    const actual = jest.requireActual('@/core/api/client');
    return {
        ...actual,
        api: { ...actual.api, get: jest.fn(), post: jest.fn(), put: jest.fn(), delete: jest.fn() },
    };
});

const get = api.get as jest.Mock;
const post = api.post as jest.Mock;
const put = api.put as jest.Mock;
const del = api.delete as jest.Mock;

beforeEach(() => jest.clearAllMocks());

describe('sources', () => {
    it('lists them, with a url source’s address out of its metadata', async () => {
        get.mockResolvedValue({
            sources: [
                {
                    id: 's1',
                    type: 'url',
                    name: 'example.com/',
                    status: 'ready',
                    metadata: { url: 'https://example.com/' },
                },
                { id: '', type: 'text' },
            ],
        });
        const [source, ...rest] = await listSources('wp1');
        expect(rest).toEqual([]);
        expect(source?.url).toBe('https://example.com/');
        expect(get).toHaveBeenCalledWith('/api/webpages/wp1/sources', { signal: undefined });
    });

    it('adds a url or a text, trimmed', async () => {
        post.mockResolvedValue({ success: true, source: { id: 's2', type: 'text', status: 'processing' } });
        await addUrlSource('wp1', ' https://x.nl ');
        expect(post).toHaveBeenCalledWith('/api/webpages/wp1/sources/url', { url: 'https://x.nl' });
        const added = await addTextSource('wp1', 'Our brand is blue.', '  ');
        expect(post).toHaveBeenLastCalledWith('/api/webpages/wp1/sources/text', { text: 'Our brand is blue.' });
        expect(added.status).toBe('processing');
    });

    it('retries, cancels and removes one by id', async () => {
        await retrySource('wp1', 's1');
        await cancelSource('wp1', 's1');
        await deleteSource('wp1', 's1');
        expect(post).toHaveBeenCalledWith('/api/webpages/wp1/sources/s1/retry');
        expect(post).toHaveBeenCalledWith('/api/webpages/wp1/sources/s1/cancel');
        expect(del).toHaveBeenCalledWith('/api/webpages/wp1/sources/s1');
    });

    it('uploads a file under the router’s multer field and limit', () => {
        expect(sourceUploadTarget('wp1')).toMatchObject({
            path: '/api/webpages/wp1/sources/file',
            field: 'file',
            maxBytes: 50 * 1024 * 1024,
        });
    });
});

describe('versions', () => {
    it('pages with limit and offset', async () => {
        get.mockResolvedValue({ versions: [{ id: 'v1', seq: 3 }], hasMore: true, coverage: { coversProject: false } });
        const page = await listVersions('wp1', 50);
        expect(get).toHaveBeenCalledWith('/api/webpages/wp1/versions', {
            signal: undefined,
            query: { limit: 50, offset: 50 },
        });
        expect(page).toMatchObject({ hasMore: true, coversProject: false });
    });

    it('snapshots, restores and deletes', async () => {
        post.mockResolvedValue({ success: true, files: { html: 'old', css: '', js: '' } });
        await createVersion('wp1', '  ');
        expect(post).toHaveBeenCalledWith('/api/webpages/wp1/versions', {});
        expect(await restoreVersion('wp1', 'v1')).toEqual({ html: 'old', css: '', js: '' });
        expect(post).toHaveBeenLastCalledWith('/api/webpages/wp1/versions/v1/restore');
        await deleteVersion('wp1', 'v1');
        expect(del).toHaveBeenCalledWith('/api/webpages/wp1/versions/v1');
    });
});

describe('the stored chat', () => {
    it('always sends `messages`, and clears with DELETE', async () => {
        await saveChat('wp1', []);
        expect(put).toHaveBeenCalledWith('/api/webpages/wp1/chat', { messages: [] });
        await clearChat('wp1');
        expect(del).toHaveBeenCalledWith('/api/webpages/wp1/chat');
    });
});
