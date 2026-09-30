/**
 * The notebook calls against server/routes/notebooks.js: every path and
 * method the phone uses is a route there, every body key is one the route's
 * closed schema lists, and the answers read as the handlers write them.
 */

import fs from 'node:fs';
import path from 'node:path';

import { api } from '@/core/api/client';

import {
    addTextSource,
    addUrlSource,
    cancelSource,
    deleteSource,
    getNotebook,
    notebookSourceTarget,
    renameSource,
    retrySource,
    saveNotebookDocument,
    updateNotebook,
} from './endpoints';

jest.mock('@/core/api/client', () => {
    const actual = jest.requireActual('@/core/api/client');
    return { ...actual, api: { get: jest.fn(), post: jest.fn(), put: jest.fn(), patch: jest.fn(), delete: jest.fn() } };
});

const mocked = api as unknown as Record<'get' | 'post' | 'put' | 'patch' | 'delete', jest.Mock>;
const ROUTES = fs.readFileSync(path.resolve(__dirname, '../../../../../server/routes/notebooks.js'), 'utf8');

/** The keys of one `bodyOf({ … }, '…')` schema in the route file. */
function schemaKeys(name: string): string[] {
    const start = ROUTES.indexOf(`const ${name} = bodyOf({`);
    if (start < 0) throw new Error(`${name} not found`);
    const end = ROUTES.indexOf('}, ', start);
    return [...ROUTES.slice(start, end).matchAll(/(?:bodyOf\(\{\s*|\n {4})([a-zA-Z]+):/g)].map((m) => m[1] as string);
}

beforeEach(() => jest.clearAllMocks());

describe('every call is a route on the server', () => {
    it.each([
        ['get', '/:id'],
        ['put', '/:id'],
        ['delete', '/:id'],
        ['get', '/:id/conversation'],
        ['post', '/:id/sources/file'],
        ['post', '/:id/sources/url'],
        ['post', '/:id/sources/text'],
        ['post', '/:id/sources/:sid/retry'],
        ['post', '/:id/sources/:sid/cancel'],
        ['get', '/:id/sources/:sid/content'],
        ['patch', '/:id/sources/:sid'],
        ['delete', '/:id/sources/:sid'],
    ])('router.%s(%s)', (method, route) => {
        expect(ROUTES).toContain(`router.${method}('${route}', requireAuth`);
    });

    it('uploads to the multer field and cap the route declares', () => {
        const target = notebookSourceTarget('nb 1');
        expect(target.path).toBe('/api/notebooks/nb%201/sources/file');
        expect(ROUTES).toContain(`upload.single('${target.field}')`);
        expect(ROUTES).toContain(`limits: { fileSize: ${target.maxBytes / (1024 * 1024)} * 1024 * 1024 }`);
    });
});

describe('saving the notes', () => {
    it('sends only keys the update schema lists — documentContent, not documentMd', () => {
        const keys = schemaKeys('UpdateBody');
        expect(keys).toEqual(expect.arrayContaining(['name', 'pinned', 'documentContent', 'expectedVersion']));
        expect(keys).not.toContain('documentMd');
    });

    it('asserts the version it loaded, and reads the new one back', async () => {
        mocked.put.mockResolvedValue({ success: true, version: 8 });
        await expect(saveNotebookDocument('nb1', '# Plan', 7)).resolves.toEqual({ version: 8 });
        expect(mocked.put).toHaveBeenCalledWith('/api/notebooks/nb1', { documentContent: '# Plan', expectedVersion: 7 });
        // The save answers the new version; a stale one is a 409 whose code the
        // phone reads (thrown as an HttpError, answered as `{ error, code }`).
        expect(ROUTES).toContain('res.json({ success: true, version: r.version });');
        expect(ROUTES).toContain("new HttpError(409, 'version_conflict'");
    });

    it('leaves the version out for a final save, and copes with a server that does not say', async () => {
        mocked.put.mockResolvedValue({ success: true });
        await expect(saveNotebookDocument('nb1', '', null)).resolves.toEqual({ version: null });
        expect(mocked.put).toHaveBeenCalledWith('/api/notebooks/nb1', { documentContent: '' });
    });

    it('renames and pins through the same route', async () => {
        mocked.put.mockResolvedValue({ success: true, version: 3 });
        await updateNotebook('nb1', { name: 'Q3' });
        expect(mocked.put).toHaveBeenCalledWith('/api/notebooks/nb1', { name: 'Q3' });
    });
});

describe('sources', () => {
    it('adds a link and a text with the keys the schemas list', async () => {
        expect(schemaKeys('UrlBody')).toEqual(['url']);
        expect(schemaKeys('TextBody')).toEqual(['text', 'name']);
        mocked.post.mockResolvedValue({ success: true, source: { id: 's1', status: 'processing', stage: 'queued' } });
        const added = await addUrlSource('nb1', 'https://example.com');
        expect(mocked.post).toHaveBeenCalledWith('/api/notebooks/nb1/sources/url', { url: 'https://example.com' });
        expect(added).toMatchObject({ id: 's1', status: 'processing', stage: 'queued' });
        await addTextSource('nb1', 'Body', 'Notes');
        expect(mocked.post).toHaveBeenLastCalledWith('/api/notebooks/nb1/sources/text', { text: 'Body', name: 'Notes' });
    });

    it('renames with the key the schema lists and keeps the name the server kept', async () => {
        expect(schemaKeys('RenameBody')).toEqual(['name']);
        mocked.patch.mockResolvedValue({ success: true, name: 'Clean name' });
        await expect(renameSource('nb1', 's/1', '  Clean   name ')).resolves.toBe('Clean name');
        expect(mocked.patch).toHaveBeenCalledWith('/api/notebooks/nb1/sources/s%2F1', { name: '  Clean   name ' });
    });

    it('retries, cancels and removes by path', async () => {
        mocked.post.mockResolvedValue({ success: true });
        mocked.delete.mockResolvedValue({ success: true });
        await retrySource('nb1', 's1');
        await cancelSource('nb1', 's1');
        await deleteSource('nb1', 's1');
        expect(mocked.post.mock.calls.map((c) => c[0])).toEqual([
            '/api/notebooks/nb1/sources/s1/retry',
            '/api/notebooks/nb1/sources/s1/cancel',
        ]);
        expect(mocked.delete).toHaveBeenCalledWith('/api/notebooks/nb1/sources/s1');
    });
});

describe('reading a notebook', () => {
    it('reads every field the store maps', async () => {
        const store = fs.readFileSync(path.resolve(__dirname, '../../../../../server/stores/notebookStore.js'), 'utf8');
        const mapper = store.slice(store.indexOf('function mapNotebookRow(r)'), store.indexOf('function mapSourceRow(r)'));
        const keys = [...mapper.matchAll(/^\s{8}([a-zA-Z]+):/gm)].map((m) => m[1] as string);
        expect(keys).toEqual(expect.arrayContaining(['documentContent', 'documentMd', 'documentFormat', 'version']));
        mocked.get.mockResolvedValue({
            notebook: Object.fromEntries(keys.map((k) => [k, k === 'version' ? 4 : k === 'documentMd' ? '# x' : ''])),
            sources: [{ id: 's1', status: 'processing', stage: 'extracting', hasContent: false }],
        });
        const detail = await getNotebook('nb1');
        expect(detail?.notebook).toEqual(expect.objectContaining({ version: 4, documentMd: '# x' }));
        expect(Object.keys(detail?.notebook ?? {})).toEqual(expect.arrayContaining(keys));
        expect(detail?.sources[0]).toMatchObject({ status: 'processing', stage: 'extracting' });
    });
});
