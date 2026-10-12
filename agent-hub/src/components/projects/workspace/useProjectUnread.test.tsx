import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { queryWrapper } from '../../../test/queryWrapper';
import { useMarkSeenWhenOpen, useProjectUnread } from './useProjectUnread';
import { makeFakeApi, reply } from './workspaceTestApi';

const { fetchMock } = vi.hoisted(() => ({ fetchMock: vi.fn() }));
vi.mock('../../../utils/helpers', async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    API_BASE: '',
    authFetch: fetchMock,
}));

const group = (type: string, id: string, over: Record<string, unknown> = {}) => ({
    item: { type, id, title: id, available: true },
    lastChangedAt: new Date().toISOString(),
    changeCount: 1,
    contributors: [{ userId: 'u2', kind: 'user' }],
    stats: { wordsAdded: 3, wordsRemoved: 0, blocksChanged: 1 },
    latestVersionId: `v-${id}`,
    seenVersionId: null,
    kinds: ['edited'],
    aiAssisted: false,
    minor: false,
    unread: true,
    ...over,
});

function setup(routes: Record<string, unknown> = {}) {
    const api = makeFakeApi({
        'POST /api/projects/p1/visit': { prevVisitAt: null, visitStartedAt: new Date().toISOString() },
        'GET /api/projects/p1/changes': {
            groups: [group('document', 'd1'), group('notebook', 'n1'), group('meeting', 'gone', { item: { type: 'meeting', id: 'gone', title: null, available: false } })],
            since: 'unread', prevVisitAt: null, visitStartedAt: null,
        },
        'GET /api/projects/p1/chats': { chats: [{ id: 'c1', title: 'Standup', unread: 2, archived: false }], role: 'editor' },
        'POST /api/projects/p1/items/document/d1/seen': { ok: true },
        ...routes,
    });
    fetchMock.mockImplementation(api.fetchImpl);
    return api;
}

beforeEach(() => { fetchMock.mockReset(); });
afterEach(() => { vi.useRealTimers(); });

describe('useProjectUnread', () => {
    it('marks the items others changed and the sections they are in, plus team chats', async () => {
        const api = setup();
        const { result } = renderHook(() => useProjectUnread('p1'), { wrapper: queryWrapper() });
        await waitFor(() => expect(result.current.isUnread('document', 'd1')).toBe(true));
        expect(result.current.isUnread('notebook', 'n1')).toBe(true);
        expect(result.current.isUnread('meeting', 'gone')).toBe(false);
        expect(result.current.isUnread('document', 'other')).toBe(false);
        await waitFor(() => expect(result.current.tabs).toEqual({ documents: true, notebooks: true, chats: true }));
        expect(result.current.groupOf('document', 'd1')?.latestVersionId).toBe('v-d1');
        expect(api.callsTo('GET', '/api/projects/p1/changes')[0].query.get('since')).toBe('unread');
    });

    it('drops the mark the moment an item is seen, and tells the server', async () => {
        const seen = new Set<string>();
        let release: () => void = () => {};
        const held = new Promise<void>((r) => { release = r; });
        const api = setup({
            'GET /api/projects/p1/changes': () => ({
                groups: [group('document', 'd1'), group('notebook', 'n1')].filter((g) => !seen.has(g.item.id)),
                since: 'unread', prevVisitAt: null, visitStartedAt: null,
            }),
            // The server answers late: the mark must already be gone by then.
            'POST /api/projects/p1/items/document/d1/seen': async () => { await held; seen.add('d1'); return { ok: true }; },
        });
        const { result } = renderHook(() => useProjectUnread('p1'), { wrapper: queryWrapper() });
        await waitFor(() => expect(result.current.isUnread('document', 'd1')).toBe(true));
        act(() => result.current.markSeen('document', 'd1', 'v-shown'));
        await waitFor(() => expect(result.current.isUnread('document', 'd1')).toBe(false));
        expect(result.current.isUnread('notebook', 'n1')).toBe(true);
        release();
        await waitFor(() => expect(api.callsTo('POST', '/api/projects/p1/items/document/d1/seen')).toHaveLength(1));
        await waitFor(() => expect(api.callsTo('GET', '/api/projects/p1/changes').length).toBeGreaterThan(1));
        expect(result.current.isUnread('document', 'd1')).toBe(false);
        expect(api.callsTo('POST', '/api/projects/p1/items/document/d1/seen')[0].body).toEqual({ versionId: 'v-shown' });
    });

    it('says nothing, rather than guessing, when the marks cannot be read', async () => {
        setup({ 'GET /api/projects/p1/changes': reply(403, { error: 'Forbidden' }), 'GET /api/projects/p1/chats': reply(403, {}) });
        const { result } = renderHook(() => useProjectUnread('p1'), { wrapper: queryWrapper() });
        await waitFor(() => expect(result.current.failed).toBe(true));
        expect(result.current.tabs).toEqual({});
        expect(result.current.isUnread('document', 'd1')).toBe(false);
    });
});

describe('useMarkSeenWhenOpen', () => {
    it('marks an item seen after it has been open a moment, not on a glance', () => {
        vi.useFakeTimers();
        const markSeen = vi.fn();
        const { rerender, unmount } = renderHook(({ item }) => useMarkSeenWhenOpen({ markSeen }, item), {
            initialProps: { item: { type: 'document' as const, id: 'd1' } as { type: 'document'; id: string } | null },
        });
        vi.advanceTimersByTime(1000);
        rerender({ item: { type: 'document', id: 'd2' } });
        vi.advanceTimersByTime(2999);
        expect(markSeen).not.toHaveBeenCalled();
        vi.advanceTimersByTime(1);
        expect(markSeen).toHaveBeenCalledWith('document', 'd2');
        rerender({ item: null });
        vi.advanceTimersByTime(5000);
        expect(markSeen).toHaveBeenCalledTimes(1);
        unmount();
    });

    it('marks it seen again when a colleague changes it while it is open, but not while it stays read', () => {
        vi.useFakeTimers();
        const markSeen = vi.fn();
        const item = { type: 'document' as const, id: 'd1' };
        const { rerender, unmount } = renderHook(({ isUnread }) => useMarkSeenWhenOpen({ markSeen, isUnread: () => isUnread }, item), {
            initialProps: { isUnread: true },
        });
        vi.advanceTimersByTime(3000);
        expect(markSeen).toHaveBeenCalledTimes(1);
        rerender({ isUnread: false });
        vi.advanceTimersByTime(10000);
        expect(markSeen).toHaveBeenCalledTimes(1);
        // A colleague edits the open document: the dot is back, and goes again after a moment.
        rerender({ isUnread: true });
        vi.advanceTimersByTime(2999);
        expect(markSeen).toHaveBeenCalledTimes(1);
        vi.advanceTimersByTime(1);
        expect(markSeen).toHaveBeenCalledTimes(2);
        unmount();
    });
});
