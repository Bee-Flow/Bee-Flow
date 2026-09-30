/**
 * What a finished builder turn changes on the phone: the rewritten bodies go
 * into the cached copy (no download), the preview's document is built again,
 * and only the parts it touched refresh.
 */

import { emptyWebpageTurn } from '@/shared/stream';
import { testQueryClient } from '@/shared/testing/renderWithProviders';

import { applyTurn, liveFiles, persistChat } from './useWebpageChat';
import { saveChat } from '../api/buildEndpoints';
import { getWebpageFiles } from '../api/endpoints';
import { webpageKeys } from '../api/keys';
import { newEntry } from '../model/chat';

jest.mock('@/core/api/client', () => ({ ...jest.requireActual('@/core/api/client'), api: {} }));
jest.mock('../api/buildEndpoints', () => ({
    ...jest.requireActual('../api/buildEndpoints'),
    saveChat: jest.fn(() => Promise.resolve()),
}));
jest.mock('../api/endpoints', () => ({
    ...jest.requireActual('../api/endpoints'),
    getWebpageFiles: jest.fn(),
}));

function client() {
    const queryClient = testQueryClient();
    queryClient.setQueryData(webpageKeys.files('wp1'), { html: 'old', css: 'c', js: 'j' });
    const invalidate = jest.spyOn(queryClient, 'invalidateQueries').mockResolvedValue();
    return { queryClient, invalidate };
}

const keysOf = (spy: jest.SpyInstance) =>
    spy.mock.calls.map(([filters]) => (filters as { queryKey: unknown }).queryKey);

describe('applyTurn', () => {
    it('writes new slot bodies into the cache and refreshes the page', () => {
        const { queryClient, invalidate } = client();
        applyTurn(queryClient, 'wp1', { ...emptyWebpageTurn(), slots: { html: 'new' } });
        expect(queryClient.getQueryData(webpageKeys.files('wp1'))).toEqual({ html: 'new', css: 'c', js: 'j' });
        expect(keysOf(invalidate)).toEqual([webpageKeys.document('wp1'), webpageKeys.detail('wp1'), webpageKeys.all]);
    });

    it('rebuilds the preview when a project file changed', () => {
        const { queryClient, invalidate } = client();
        applyTurn(queryClient, 'wp1', { ...emptyWebpageTurn(), extraPaths: ['src/App.jsx'] });
        expect(keysOf(invalidate)[0]).toEqual(webpageKeys.document('wp1'));
    });

    it('refreshes only the sources after research, and nothing after a plain answer', () => {
        const { queryClient, invalidate } = client();
        applyTurn(queryClient, 'wp1', { ...emptyWebpageTurn(), sourcesAdded: 1 });
        expect(keysOf(invalidate)).toEqual([webpageKeys.sources('wp1')]);
        invalidate.mockClear();
        applyTurn(queryClient, 'wp1', { ...emptyWebpageTurn(), text: 'Hello' });
        expect(invalidate).not.toHaveBeenCalled();
    });
});

describe('persistChat', () => {
    it('stores the transcript and gives the cached page detail the same rows', () => {
        // The next visit mounts the transcript from this cache; an older list
        // there would be saved back over the turns in between.
        const queryClient = testQueryClient();
        queryClient.setQueryData(webpageKeys.detail('wp1'), { webpage: {}, chatMessages: [{ id: 'old' }] });
        const entries = [newEntry({ id: 'm1', role: 'user', content: 'Hi', createdAt: '2026-01-01T00:00:00Z' })];
        persistChat(queryClient, 'wp1', entries);
        const rows = (saveChat as jest.Mock).mock.calls[0][1];
        expect(rows).toEqual([expect.objectContaining({ id: 'm1', role: 'user', content: 'Hi' })]);
        expect(queryClient.getQueryData(webpageKeys.detail('wp1'))).toEqual({ webpage: {}, chatMessages: rows });
    });
});

describe('liveFiles', () => {
    it('reads the bodies from the server even when a fresh-looking copy is cached', async () => {
        const queryClient = testQueryClient();
        queryClient.setQueryData(webpageKeys.files('wp1'), { html: 'cached', css: '', js: '' });
        (getWebpageFiles as jest.Mock).mockResolvedValue({ html: 'live', css: '', js: '' });
        await expect(liveFiles(queryClient, 'wp1')).resolves.toEqual({ html: 'live', css: '', js: '' });
    });
});
