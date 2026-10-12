import { QueryClient } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { testQueryClient, queryWrapper } from '../../test/queryWrapper';

const { client } = vi.hoisted(() => ({ client: {} as Record<'get' | 'post' | 'put' | 'patch' | 'delete', ReturnType<typeof vi.fn>> }));
vi.mock('../client', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../client')>()),
    apiClient: client,
    default: client,
}));

import { ApiError } from '../client';
import { useUpdateTask, type ProjectTask } from './projectTasks';
import { projectKeys, retryUnlessRefused, useAttachResource, useProjectQuery } from './projects';

beforeEach(() => {
    for (const m of ['get', 'post', 'put', 'patch', 'delete'] as const) client[m] = vi.fn();
});

describe('retryUnlessRefused', () => {
    it('does not try again after a refusal that will not change, but does after a network or server failure', () => {
        expect(retryUnlessRefused(0, new ApiError('gone', { status: 404 }))).toBe(false);
        expect(retryUnlessRefused(0, new ApiError('no', { status: 403 }))).toBe(false);
        expect(retryUnlessRefused(0, new ApiError('slow', { status: 429 }))).toBe(true);
        expect(retryUnlessRefused(0, new ApiError('boom', { status: 503 }))).toBe(true);
        expect(retryUnlessRefused(0, new Error('offline'))).toBe(true);
        expect(retryUnlessRefused(2, new Error('offline'))).toBe(false);
    });

    it('shows a removed or deleted project at once, after a single request', async () => {
        client.get.mockRejectedValue(new ApiError('Not found', { status: 404 }));
        const { result } = renderHook(() => useProjectQuery('p1'), { wrapper: queryWrapper() });
        await waitFor(() => expect(result.current.isError).toBe(true));
        expect(client.get).toHaveBeenCalledTimes(1);
    });
});

describe('useAttachResource', () => {
    it('re-reads the pickers\' lists of my own items, which say which project an item is filed in', async () => {
        client.put.mockResolvedValue({});
        const qc = testQueryClient();
        const spy = vi.spyOn(qc, 'invalidateQueries');
        const { result } = renderHook(() => useAttachResource('p1'), { wrapper: queryWrapper(qc) });
        await act(async () => { await result.current.mutateAsync({ kind: 'document', id: 'd1', attach: true }); });
        const keys = spy.mock.calls.map(c => (c[0] as { queryKey: unknown[] }).queryKey);
        expect(keys).toContainEqual(['project-content', 'mine']);
    });
});

describe('useUpdateTask', () => {
    const task = (id: string, sortOrder: number): ProjectTask => ({
        id, title: id, description: '', status: 'todo', priority: 'normal', labels: [], checklist: [], sortOrder, source: null,
        assigneeIds: [], links: [], dueDate: null, createdBy: 'u1', completedAt: null, createdAt: '', updatedAt: '',
    });
    const setup = () => {
        const qc: QueryClient = testQueryClient();
        qc.setQueryData(projectKeys.tasks('p1'), { tasks: [task('a', 1000), task('b', 2000)], role: 'editor' });
        return { qc, hook: renderHook(() => useUpdateTask('p1'), { wrapper: queryWrapper(qc) }) };
    };

    it('leaves other queries under the tasks key (the meeting suggestions) alone when a card moves', async () => {
        const { qc, hook } = setup();
        let release: (v: unknown) => void = () => {};
        qc.fetchQuery({ queryKey: [...projectKeys.tasks('p1'), 'suggestions', 'm1'], queryFn: () => new Promise((r) => { release = r; }) }).catch(() => {});
        client.patch.mockResolvedValue({ task: task('a', 1) });
        await act(async () => { await hook.result.current.mutateAsync({ id: 'a', patch: { status: 'doing', beforeId: null } }); });
        const suggestions = qc.getQueryCache().find({ queryKey: [...projectKeys.tasks('p1'), 'suggestions', 'm1'] })!;
        expect(suggestions.state.fetchStatus).toBe('fetching');
        release({});
    });

    it('refetches once, after the last of several moves has settled, not over a newer move', async () => {
        const { qc, hook } = setup();
        const spy = vi.spyOn(qc, 'invalidateQueries');
        const done: Array<(v: unknown) => void> = [];
        client.patch.mockImplementation(() => new Promise((r) => { done.push(r); }));
        let first!: Promise<unknown>; let second!: Promise<unknown>;
        act(() => {
            first = hook.result.current.mutateAsync({ id: 'a', patch: { status: 'doing', beforeId: null } });
            second = hook.result.current.mutateAsync({ id: 'b', patch: { status: 'doing', beforeId: null } });
        });
        await waitFor(() => expect(done).toHaveLength(2));
        await act(async () => { done[0]({ task: task('a', 1) }); await first; });
        expect(spy).not.toHaveBeenCalled();
        await act(async () => { done[1]({ task: task('b', 2) }); await second; });
        expect(spy).toHaveBeenCalledTimes(1);
    });
});
