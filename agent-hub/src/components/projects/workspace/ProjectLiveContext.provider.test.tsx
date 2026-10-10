import { act, render, screen } from '@testing-library/react';
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { changeKeys } from '../../../api/queries/projectChanges';
import { discoveryKeys } from '../../../api/queries/projectDiscovery';
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
    const live = useProjectLive();
    return (
        <>
            <span data-testid="online">{live.online.join(',')}</span>
            <span data-testid="viewing">{JSON.stringify(live.viewing)}</span>
            <button type="button" onClick={() => live.setViewing({ type: 'document', id: 'd1' })}>open doc</button>
            <button type="button" onClick={() => live.setViewing(null)}>close doc</button>
        </>
    );
}

function setup() {
    const client = testQueryClient();
    const spy = vi.spyOn(client, 'invalidateQueries');
    render(withQueryClient(<ProjectLiveProvider projectId="p1" currentUserId="me"><Online /></ProjectLiveProvider>, client));
    return { client, spy };
}

beforeEach(() => { post.mockReset(); post.mockResolvedValue({}); stream.options = null; });

function Status() {
    return <span data-testid="status">{useProjectLive().status}</span>;
}

describe('ProjectLiveProvider', () => {
    it('exposes the transport status', () => {
        render(withQueryClient(<ProjectLiveProvider projectId="p1" currentUserId="me"><Status /></ProjectLiveProvider>));
        expect(screen.getByTestId('status')).toHaveTextContent('connecting');
        act(() => stream.options!.onStatus!('stopped'));
        expect(screen.getByTestId('status')).toHaveTextContent('stopped');
    });

    it('marks somebody online from a live event, not from a row replayed out of the activity feed', () => {
        setup();
        act(() => stream.options!.onEvent!('thread_shared', { actorId: 'u1', polled: true, createdAt: new Date().toISOString() }));
        act(() => stream.options!.onEvent!('member_added', { actorId: 'u2', createdAt: new Date(Date.now() - 10 * 60_000).toISOString() }));
        expect(screen.getByTestId('online')).toHaveTextContent('');
        act(() => stream.options!.onEvent!('presence.online', { actorId: 'u3' }));
        expect(screen.getByTestId('online')).toHaveTextContent('u3');
    });

    it('re-reads every live list on a poll tick of the degraded mode: tasks, board, chats, threads, files, members, unread', () => {
        const { spy } = setup();
        act(() => stream.options!.onPoll!());
        const keys = spy.mock.calls.map(c => (c[0] as { queryKey: unknown[] }).queryKey);
        expect(keys).toEqual(expect.arrayContaining([
            projectKeys.tasks('p1'), [...projectKeys.detail('p1'), 'board'], projectKeys.sprints('p1'),
            projectKeys.chats('p1'), projectKeys.threads('p1'), projectKeys.myChats('p1'),
            projectKeys.files('p1'), projectKeys.members('p1'), projectKeys.resources('p1'),
            changeKeys.all('p1'), discoveryKeys.pins('p1'),
        ]));
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

describe('ProjectLiveProvider: who is viewing which item', () => {
    it('fills `viewing` from a presence.online event with a target, moves the person when they open another item, and clears them without one', () => {
        setup();
        act(() => stream.options!.onEvent!('presence.online', { actorId: 'u3', target: { type: 'document', id: 'd1' } }));
        expect(screen.getByTestId('viewing')).toHaveTextContent('{"document:d1":["u3"]}');
        act(() => stream.options!.onEvent!('presence.online', { actorId: 'u4', target: { type: 'document', id: 'd1' } }));
        expect(JSON.parse(screen.getByTestId('viewing').textContent!)).toEqual({ 'document:d1': ['u3', 'u4'] });
        act(() => stream.options!.onEvent!('presence.online', { actorId: 'u3', target: { type: 'task', id: 't1' } }));
        expect(JSON.parse(screen.getByTestId('viewing').textContent!)).toEqual({ 'document:d1': ['u4'], 'task:t1': ['u3'] });
        act(() => stream.options!.onEvent!('presence.online', { actorId: 'u3', target: null }));
        expect(JSON.parse(screen.getByTestId('viewing').textContent!)).toEqual({ 'document:d1': ['u4'] });
    });

    it('never lists the caller as viewing, and lets a viewer lapse after the presence TTL', () => {
        vi.useFakeTimers();
        setup();
        act(() => stream.options!.onEvent!('presence.online', { actorId: 'me', target: { type: 'chat', id: 'c1' } }));
        expect(screen.getByTestId('viewing')).toHaveTextContent('{}');
        act(() => stream.options!.onEvent!('presence.online', { actorId: 'u3', target: { type: 'chat', id: 'c1' } }));
        expect(screen.getByTestId('viewing')).toHaveTextContent('{"chat:c1":["u3"]}');
        act(() => { vi.advanceTimersByTime(80_000); });
        expect(screen.getByTestId('viewing')).toHaveTextContent('{}');
        vi.useRealTimers();
    });

    it('posts the open item with the heartbeat, and beats again the moment another item opens', async () => {
        setup();
        const bodies = () => post.mock.calls.filter(c => String(c[0]).endsWith('/presence')).map(c => c[1]);
        expect(bodies()).toEqual([{}]);
        act(() => screen.getByText('open doc').click());
        expect(bodies()).toEqual([{}, { target: { type: 'document', id: 'd1' } }]);
        act(() => screen.getByText('open doc').click());
        expect(bodies()).toHaveLength(2);
        act(() => screen.getByText('close doc').click());
        expect(bodies()).toEqual([{}, { target: { type: 'document', id: 'd1' } }, {}]);
    });
});
