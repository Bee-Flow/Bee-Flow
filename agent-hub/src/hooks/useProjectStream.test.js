import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

/**
 * CHARACTERISATION — the project live feed as it behaves today (PRJ-0).
 *
 * "You never miss a message" is this hook's whole promise, and every mechanism
 * that delivers it is invisible on screen: the cursor that replays the gap after
 * a reconnect, the rule that transient frames must NOT move that cursor, the
 * three-strikes fall back to polling, and the hard stop on a revoked project.
 * A redesign of the project page will not touch this file — which is exactly
 * why the behaviour needs pinning somewhere.
 */

vi.mock('../utils/helpers', () => ({ API_BASE: '', authFetch: vi.fn() }));

import useProjectStream from './useProjectStream';
import { authFetch } from '../utils/helpers';

const enc = new TextEncoder();
const frame = (event, data, id) =>
    `${id !== undefined ? `id: ${id}\n` : ''}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

/** A response whose body streams `chunks` in order, then closes. */
function streamOf(chunks) {
    return {
        ok: true,
        status: 200,
        body: new ReadableStream({
            start(controller) {
                for (const c of chunks) controller.enqueue(enc.encode(c));
                controller.close();
            },
        }),
    };
}

/** A response that never closes — the normal case for a live connection. */
function openStream(chunks) {
    return {
        ok: true,
        status: 200,
        body: new ReadableStream({
            start(controller) { for (const c of chunks) controller.enqueue(enc.encode(c)); },
        }),
    };
}

const urls = () => authFetch.mock.calls.map(c => c[0]);

const mount = (opts = {}) => {
    const onEvent = vi.fn();
    const view = renderHook(() => useProjectStream({ projectId: 'p1', onEvent, ...opts }));
    return { onEvent, ...view };
};

beforeEach(() => { vi.clearAllMocks(); });
afterEach(() => { vi.useRealTimers(); });

describe('connecting', () => {
    it('opens the project feed from the very beginning', async () => {
        authFetch.mockResolvedValue(openStream([]));
        mount();
        await waitFor(() => expect(authFetch).toHaveBeenCalled());
        expect(urls()[0]).toBe('/api/projects/p1/stream?since=0');
        expect(authFetch.mock.calls[0][1].headers).toEqual({ Accept: 'text/event-stream' });
    });

    it('opens nothing at all without a project', async () => {
        authFetch.mockResolvedValue(openStream([]));
        mount({ projectId: null });
        await Promise.resolve();
        expect(authFetch).not.toHaveBeenCalled();
    });

    it('opens nothing while the caller has it switched off', async () => {
        authFetch.mockResolvedValue(openStream([]));
        mount({ enabled: false });
        await Promise.resolve();
        expect(authFetch).not.toHaveBeenCalled();
    });

    it('stays quiet while the tab is in the background', async () => {
        const spy = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
        authFetch.mockResolvedValue(openStream([]));
        mount();
        await Promise.resolve();
        expect(authFetch).not.toHaveBeenCalled();
        spy.mockRestore();
    });
});

describe('reading the feed', () => {
    it('hands each event to the caller, kind and payload apart', async () => {
        authFetch.mockResolvedValue(openStream([
            frame('thread_shared', { targetId: 'c1' }, 1),
            frame('member_added', { targetId: 'u2' }, 2),
        ]));
        const { onEvent } = mount();
        await waitFor(() => expect(onEvent).toHaveBeenCalledTimes(2));
        expect(onEvent.mock.calls[0]).toEqual(['thread_shared', { targetId: 'c1' }]);
        expect(onEvent.mock.calls[1]).toEqual(['member_added', { targetId: 'u2' }]);
    });

    it('waits for the rest of a frame that arrived split across two chunks', async () => {
        authFetch.mockResolvedValue(openStream([
            'event: thread_shared\ndata: {"targetId":"c',
            '1"}\n\n',
        ]));
        const { onEvent } = mount();
        await waitFor(() => expect(onEvent).toHaveBeenCalledWith('thread_shared', { targetId: 'c1' }));
    });

    it('swallows the keep-alive frames rather than passing them on', async () => {
        authFetch.mockResolvedValue(openStream([
            ': ping\n\n',
            frame('ping', {}),
            frame('ready', { ok: true }),
            frame('member_added', { targetId: 'u2' }, 1),
        ]));
        const { onEvent } = mount();
        await waitFor(() => expect(onEvent).toHaveBeenCalled());
        expect(onEvent).toHaveBeenCalledTimes(1);
        expect(onEvent).toHaveBeenCalledWith('member_added', { targetId: 'u2' });
    });

    it('skips a frame whose payload is not JSON instead of tearing the stream down', async () => {
        authFetch.mockResolvedValue(openStream([
            'event: member_added\ndata: not-json\n\n',
            frame('thread_shared', { targetId: 'c1' }, 1),
        ]));
        const { onEvent } = mount();
        await waitFor(() => expect(onEvent).toHaveBeenCalledWith('thread_shared', { targetId: 'c1' }));
        expect(onEvent).toHaveBeenCalledTimes(1);
    });

    it('defaults to the "message" kind for a frame with no event line', async () => {
        authFetch.mockResolvedValue(openStream(['data: {"a":1}\n\n']));
        const { onEvent } = mount();
        await waitFor(() => expect(onEvent).toHaveBeenCalledWith('message', { a: 1 }));
    });
});

describe('the cursor', () => {
    it('replays the gap from the last durable event after a reconnect', async () => {
        vi.useFakeTimers();
        authFetch
            .mockResolvedValueOnce(streamOf([frame('thread_shared', { targetId: 'c1' }, 7)]))
            .mockResolvedValue(openStream([]));
        mount();
        await vi.advanceTimersByTimeAsync(3000);
        expect(urls()[0]).toBe('/api/projects/p1/stream?since=0');
        expect(urls()[1]).toBe('/api/projects/p1/stream?since=7');
    });

    it('never lets a transient frame move the cursor — "Anna is typing" is not replayable', async () => {
        vi.useFakeTimers();
        authFetch
            .mockResolvedValueOnce(streamOf([
                frame('thread_shared', { targetId: 'c1' }, 4),
                frame('typing', { userId: 'u2' }),          // no id: transient
            ]))
            .mockResolvedValue(openStream([]));
        mount();
        await vi.advanceTimersByTimeAsync(3000);
        expect(urls()[1]).toBe('/api/projects/p1/stream?since=4');
    });

    it('keeps the highest id it saw, not the last one', async () => {
        vi.useFakeTimers();
        authFetch
            .mockResolvedValueOnce(streamOf([
                frame('a', {}, 9),
                frame('b', {}, 3),
            ]))
            .mockResolvedValue(openStream([]));
        mount();
        await vi.advanceTimersByTimeAsync(3000);
        expect(urls()[1]).toBe('/api/projects/p1/stream?since=9');
    });

    // wrat: a `ready` frame is dropped only AFTER the cursor update, while a
    // `ping` is dropped before it — so a ready with an id silently moves the
    // cursor and a ping never can. The asymmetry is undocumented in the hook.
    it('lets a ready frame carrying an id move the cursor even though it is not delivered', async () => {
        vi.useFakeTimers();
        authFetch
            .mockResolvedValueOnce(streamOf([frame('ready', { ok: true }, 12)]))
            .mockResolvedValue(openStream([]));
        const { onEvent } = mount();
        await vi.advanceTimersByTimeAsync(3000);
        expect(onEvent).not.toHaveBeenCalled();
        expect(urls()[1]).toBe('/api/projects/p1/stream?since=12');
    });

    it('starts a different project from scratch rather than carrying the cursor across', async () => {
        vi.useFakeTimers();
        authFetch
            .mockResolvedValueOnce(streamOf([frame('a', {}, 5)]))
            .mockResolvedValue(openStream([]));
        const onEvent = vi.fn();
        const { rerender } = renderHook(
            ({ projectId }) => useProjectStream({ projectId, onEvent }),
            { initialProps: { projectId: 'p1' } },
        );
        await vi.advanceTimersByTimeAsync(3000);
        rerender({ projectId: 'p2' });
        await vi.advanceTimersByTimeAsync(100);
        expect(urls().at(-1)).toBe('/api/projects/p2/stream?since=0');
    });
});

describe('when access is revoked mid-stream', () => {
    it('stops trying instead of reconnecting into a loop', async () => {
        vi.useFakeTimers();
        authFetch.mockResolvedValue(streamOf([frame('forbidden', { reason: 'removed' })]));
        mount();
        await vi.advanceTimersByTimeAsync(60_000);
        expect(authFetch).toHaveBeenCalledTimes(1);
    });

    // wrat: the forbidden branch sets `stopped = true` BEFORE calling emit, and
    // emit refuses to fire once stopped — so the one event that means "you have
    // been removed from this project" never reaches the caller. The page keeps
    // showing a project the user can no longer read, with a dead feed.
    // Hoort in stage PRJ-2 te veranderen (emit vóór stopped, plus een reactie
    // op de pagina).
    it('never actually tells the caller it was forbidden', async () => {
        vi.useFakeTimers();
        authFetch.mockResolvedValue(streamOf([frame('forbidden', { reason: 'removed' })]));
        const { onEvent } = mount();
        await vi.advanceTimersByTimeAsync(60_000);
        expect(onEvent).not.toHaveBeenCalled();
    });

    it('drops every event that was still queued behind the forbidden frame', async () => {
        vi.useFakeTimers();
        authFetch.mockResolvedValue(streamOf([
            frame('member_removed', { targetId: 'u2' }, 1),
            frame('forbidden', { reason: 'removed' }),
            frame('thread_shared', { targetId: 'c9' }, 2),
        ]));
        const { onEvent } = mount();
        await vi.advanceTimersByTimeAsync(60_000);
        expect(onEvent.mock.calls.map(c => c[0])).toEqual(['member_removed']);
    });
});

describe('when the stream cannot be established', () => {
    it('retries a failure before giving up on it', async () => {
        vi.useFakeTimers();
        authFetch.mockRejectedValue(new Error('boom'));
        mount();
        await vi.advanceTimersByTimeAsync(2000);
        expect(authFetch.mock.calls.length).toBeGreaterThan(1);
    });

    it('falls back to polling the activity endpoint after three strikes', async () => {
        vi.useFakeTimers();
        authFetch.mockRejectedValue(new Error('no sse here'));
        mount();
        await vi.advanceTimersByTimeAsync(30_000);
        expect(urls()).toContain('/api/projects/p1/activity?limit=25');
    });

    it('replays polled activity oldest-first and marks it as polled', async () => {
        vi.useFakeTimers();
        authFetch.mockImplementation(async (url) => {
            if (url.includes('/activity')) {
                return {
                    ok: true,
                    status: 200,
                    json: async () => ({
                        items: [
                            { id: 2, action: 'member_added', targetId: 'u2' },
                            { id: 1, action: 'thread_shared', targetId: 'c1' },
                        ],
                    }),
                };
            }
            throw new Error('no sse here');
        });
        const { onEvent } = mount();
        await vi.advanceTimersByTimeAsync(30_000);
        // The endpoint answers newest-first; the hook reverses it so the feed
        // reads in the order things happened.
        expect(onEvent.mock.calls[0]).toEqual(['thread_shared', { id: 1, action: 'thread_shared', targetId: 'c1', polled: true }]);
        expect(onEvent.mock.calls[1]).toEqual(['member_added', { id: 2, action: 'member_added', targetId: 'u2', polled: true }]);
    });

    it('treats a non-2xx answer as a failure, not as an empty feed', async () => {
        vi.useFakeTimers();
        // De body MOET hier een echte stream zijn. Met `body: null` zou de
        // bron al struikelen over de tweede helft van `!res.ok || !res.body`
        // en pinde deze test de statuscontrole nooit — een 502 MET body werd
        // dan als levende stream gelezen, dus nooit drie strikes en nooit de
        // polling-fallback. mockImplementation, niet mockResolvedValue: een
        // ReadableStream is maar één keer leesbaar.
        authFetch.mockImplementation(async () => ({ ok: false, status: 502, body: openStream([]).body }));
        mount();
        await vi.advanceTimersByTimeAsync(30_000);
        expect(urls()).toContain('/api/projects/p1/activity?limit=25');
    });
});

describe('tearing down', () => {
    it('stops delivering events once the caller unmounts', async () => {
        vi.useFakeTimers();
        authFetch.mockResolvedValue(streamOf([]));
        const { unmount } = mount();
        await vi.advanceTimersByTimeAsync(100);
        const before = authFetch.mock.calls.length;
        unmount();
        await vi.advanceTimersByTimeAsync(60_000);
        expect(authFetch.mock.calls.length).toBe(before);
    });
});
