import { act, render, screen } from '@testing-library/react';
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { projectKeys } from '../../../api/queries/projects';
import type { UseProjectStreamOptions } from '../../../hooks/useProjectStream';
import { testQueryClient, withQueryClient } from '../../../test/queryWrapper';
import { ProjectLiveProvider, useProjectLive } from './ProjectLiveContext';

const { post, stream } = vi.hoisted(() => ({ post: vi.fn(), stream: { options: null as null | UseProjectStreamOptions } }));
vi.mock('../../../api/client', async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    apiClient: { post, get: vi.fn() },
}));
vi.mock('../../../hooks/useProjectStream', () => ({
    default: (options: UseProjectStreamOptions) => { stream.options = options; },
}));

function Online() {
    return <span data-testid="online">{useProjectLive().online.join(',')}</span>;
}

function setup() {
    const client = testQueryClient();
    const spy = vi.spyOn(client, 'invalidateQueries');
    render(withQueryClient(<ProjectLiveProvider projectId="p1" currentUserId="me"><Online /></ProjectLiveProvider>, client));
    return { client, spy };
}

beforeEach(() => { post.mockReset(); post.mockResolvedValue({}); stream.options = null; });

describe('ProjectLiveProvider', () => {
    it('marks somebody online from a live event, not from a row replayed out of the activity feed', () => {
        setup();
        act(() => stream.options!.onEvent!('thread_shared', { actorId: 'u1', polled: true, createdAt: new Date().toISOString() }));
        act(() => stream.options!.onEvent!('member_added', { actorId: 'u2', createdAt: new Date(Date.now() - 10 * 60_000).toISOString() }));
        expect(screen.getByTestId('online')).toHaveTextContent('');
        act(() => stream.options!.onEvent!('presence.online', { actorId: 'u3' }));
        expect(screen.getByTestId('online')).toHaveTextContent('u3');
    });

    it('re-reads tasks, chats and threads on every poll tick of the degraded mode', () => {
        const { spy } = setup();
        act(() => stream.options!.onPoll!());
        const keys = spy.mock.calls.map(c => (c[0] as { queryKey: unknown[] }).queryKey);
        expect(keys).toEqual(expect.arrayContaining([projectKeys.tasks('p1'), projectKeys.chats('p1'), projectKeys.threads('p1'), projectKeys.myChats('p1')]));
    });

    it('re-reads lists cached before the page opened when the stream starts at now, but not a reconnect', () => {
        const client = testQueryClient();
        client.setQueryData(projectKeys.tasks('p1'), { tasks: [] });
        const old = client.getQueryCache().find({ queryKey: projectKeys.tasks('p1') })!;
        old.setState({ ...old.state, dataUpdatedAt: Date.now() - 10_000 });
        render(withQueryClient(<ProjectLiveProvider projectId="p1" currentUserId="me"><Online /></ProjectLiveProvider>, client));
        act(() => stream.options!.onReady!({ since: 5, reconnect: true }));
        expect(old.state.isInvalidated).toBe(false);
        act(() => stream.options!.onReady!({ since: 5, reconnect: false }));
        expect(old.state.isInvalidated).toBe(true);
    });

    it('stops the presence beat while the tab is hidden and beats again when it is back', () => {
        setup();
        const beats = () => post.mock.calls.filter(c => String(c[0]).endsWith('/presence')).length;
        expect(beats()).toBe(1);
        const hide = (hidden: boolean) => {
            Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
            document.dispatchEvent(new Event('visibilitychange'));
        };
        vi.useFakeTimers();
        act(() => hide(true));
        act(() => { vi.advanceTimersByTime(120_000); });
        expect(beats()).toBe(1);
        act(() => hide(false));
        expect(beats()).toBe(2);
        vi.useRealTimers();
    });
});
