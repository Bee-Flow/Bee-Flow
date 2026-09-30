/**
 * What the page endpoints send. Each body is checked against the server's
 * strict schema for that route (server/routes/webpages/*.js): a key it does
 * not list is a 400.
 *
 * Deleting a webpage still sends exactly what it sent before the guard reader
 * was shared with recordings, knowledge bases and skills: the bare request
 * first, `?confirm=1` only after the guard's answer was shown.
 *
 * Run: cd mobile && ./node_modules/.bin/jest src/features/webpages/api/endpoints.test.ts
 */

import { api } from '@/core/api/client';
import { shareServerFile } from '@/core/api/shareFile';

import {
    cloneWebpage,
    createWebpage,
    deleteWebpage,
    exportWebpagePdf,
    getDraftDocument,
    getWebpage,
    getWebpageFiles,
    setWebpagePublished,
    updateWebpage,
} from './endpoints';

jest.mock('@/core/api/client', () => {
    const actual = jest.requireActual('@/core/api/client');
    return {
        ...actual,
        api: { ...actual.api, get: jest.fn(), post: jest.fn(), put: jest.fn(), patch: jest.fn(), delete: jest.fn() },
    };
});
jest.mock('@/core/api/shareFile', () => ({ shareServerFile: jest.fn() }));

const get = api.get as jest.Mock;
const post = api.post as jest.Mock;
const put = api.put as jest.Mock;
const del = api.delete as jest.Mock;

const BUNDLE = {
    webpage: { id: 'wp1', name: 'Launch', settings: { framework: 'react-mui', runtime: 'full' } },
    files: { html: '<h1>Hi</h1>', css: 'h1{}', js: '' },
    extraFiles: [{ path: 'src/App.jsx', isText: true, size: 120, mimeType: 'text/javascript' }],
    chatMessages: [{ id: 'm1', role: 'user', content: 'Build it' }],
    readOnly: false,
};

beforeEach(() => {
    jest.clearAllMocks();
    del.mockResolvedValue({ success: true });
    put.mockResolvedValue({ success: true });
});

describe('deleteWebpage', () => {
    it('sends the first request without a confirmation', async () => {
        await deleteWebpage('wp1');
        expect(del).toHaveBeenCalledWith('/api/webpages/wp1', undefined);
    });

    it('sends ?confirm=1 once the guard’s answer has been confirmed', async () => {
        await deleteWebpage('wp1', { confirmedBreaking: true });
        expect(del).toHaveBeenCalledWith('/api/webpages/wp1', { query: { confirm: '1' } });
    });
});

describe('reading a page', () => {
    it('keeps the metadata and drops the bodies from the detail', async () => {
        get.mockResolvedValue(BUNDLE);
        const detail = await getWebpage('wp1');
        expect(detail?.webpage.framework).toBe('react-mui');
        expect(detail?.webpage.runtime).toBe('full');
        expect(detail?.extraFiles).toEqual([
            { path: 'src/App.jsx', isText: true, size: 120, mimeType: 'text/javascript' },
        ]);
        expect(detail?.chatMessages).toHaveLength(1);
        expect(JSON.stringify(detail)).not.toContain('<h1>Hi</h1>');
    });

    it('reads the bodies from the same route when asked for them', async () => {
        get.mockResolvedValue(BUNDLE);
        expect(await getWebpageFiles('wp1')).toEqual({ html: '<h1>Hi</h1>', css: 'h1{}', js: '' });
        expect(get).toHaveBeenCalledWith('/api/webpages/wp1', { signal: undefined });
    });

    it('reads the draft document the server built, and never frames a ready answer without one', async () => {
        get.mockResolvedValueOnce({ status: 'ready', html: '<p>x</p>', framework: 'react-mui', expiresAt: 5, buildError: null });
        expect(await getDraftDocument('wp 1')).toEqual({ status: 'ready', html: '<p>x</p>', buildError: null, expiresAt: 5 });
        expect(get).toHaveBeenCalledWith('/api/webpages/wp%201/draft-document', { signal: undefined });
        get.mockResolvedValueOnce({ status: 'ready', html: null });
        expect((await getDraftDocument('wp1')).status).toBe('build_error');
        get.mockResolvedValueOnce({ status: 'build_error', html: null, buildError: 'Could not resolve ./Missing' });
        expect(await getDraftDocument('wp1')).toEqual({
            status: 'build_error',
            html: null,
            buildError: 'Could not resolve ./Missing',
            expiresAt: null,
        });
    });
});

describe('writing a page', () => {
    it('creates with only the fields that were filled in', async () => {
        post.mockResolvedValue({ success: true, webpage: { id: 'wp9', name: 'Bakery' } });
        expect((await createWebpage({ name: '  ', prompt: ' A bakery ' }))?.id).toBe('wp9');
        expect(post).toHaveBeenCalledWith('/api/webpages', { prompt: 'A bakery' });
        post.mockResolvedValue({ success: false });
        expect(await createWebpage({ name: 'X' })).toBeNull();
    });

    it('saves the settings it was given, and nothing else', async () => {
        await updateWebpage('wp1', { name: 'New', knowledgeBaseIds: ['kb1'] });
        expect(put).toHaveBeenCalledWith('/api/webpages/wp1', { name: 'New', knowledgeBaseIds: ['kb1'] });
    });

    it('clones and exports through the share sheet', async () => {
        post.mockResolvedValueOnce({ webpage: { id: 'wp2', name: 'Copy' } });
        expect((await cloneWebpage('wp1'))?.id).toBe('wp2');
        expect(post).toHaveBeenCalledWith('/api/webpages/wp1/clone', {});
        await exportWebpagePdf('wp1', 'Launch');
        expect(shareServerFile).toHaveBeenCalledWith('/api/webpages/wp1/export/pdf', 'Launch.pdf', 'application/pdf', {
            method: 'POST',
        });
    });
});

describe('setWebpagePublished', () => {
    const patch = api.patch as jest.Mock;

    it('asks for a new pin only on an explicit republish', async () => {
        // Without `republish` the server keeps the snapshot colleagues read,
        // so phone edits to a live page would never reach them.
        patch.mockResolvedValue({ isPublished: true });
        await setWebpagePublished('wp1', true);
        expect(patch).toHaveBeenLastCalledWith('/api/webpages/wp1/publish', { isPublished: true });
        await setWebpagePublished('wp1', true, true);
        expect(patch).toHaveBeenLastCalledWith('/api/webpages/wp1/publish', { isPublished: true, republish: true });
        patch.mockResolvedValue({ isPublished: false });
        expect(await setWebpagePublished('wp1', false)).toBe(false);
        expect(patch).toHaveBeenLastCalledWith('/api/webpages/wp1/publish', { isPublished: false });
    });
});
