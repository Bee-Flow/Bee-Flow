/**
 * The runner behind every chat surface, without React: what it publishes and
 * when, how a turn ends, and that a replaced turn cannot reach into its
 * successor. The hooks' own tests (useChatStream.test.ts) cover the same
 * machine through renderHook.
 */

import { ApiError } from '@/core/api/client';
import type { SseFrame } from '@/core/api/sse';

import { DIRECT_FRAMES, emptyStreamingTurn, type StreamingTurn } from './adapters/direct';
import { emptyMeetingTurn, MEETING_FRAMES, type MeetingTurn } from './adapters/meeting';
import { FLUSH_INTERVAL_MS, TurnRunner, type TurnStreamConfig } from './turnRunner';

const mockStreamSse = jest.fn();
jest.mock('@/core/api/sse', () => ({
    streamSse: (...args: unknown[]) => mockStreamSse(...args),
}));

const frame = (event: string, data: unknown = {}): SseFrame => ({ event, data });

function sourceOf(frames: SseFrame[]) {
    mockStreamSse.mockImplementation(async function* () {
        for (const f of frames) yield f;
    });
}

/** Yields `first`, then waits for the abort signal. */
function hangingAfter(first: SseFrame) {
    mockStreamSse.mockImplementation(async function* (_path: string, opts: { signal: AbortSignal }) {
        yield first;
        await new Promise<never>((_, reject) => {
            opts.signal.addEventListener('abort', () => reject(new Error('aborted')));
        });
    });
}

function runner(overrides: Partial<TurnStreamConfig<MeetingTurn>> = {}) {
    const onStreaming = jest.fn();
    const config: TurnStreamConfig<MeetingTurn> = {
        empty: emptyMeetingTurn,
        adapter: MEETING_FRAMES,
        onDone: jest.fn(),
        ...overrides,
    };
    return { run: new TurnRunner(config, onStreaming), config, onStreaming };
}

beforeEach(() => {
    mockStreamSse.mockReset();
    jest.useRealTimers();
});

describe('a turn that completes', () => {
    it('publishes the finished turn, reports it once, and says when it streamed', async () => {
        sourceOf([frame('content', { text: 'Hel' }), frame('content', { text: 'lo' }), frame('done')]);
        const { run, config, onStreaming } = runner();

        await run.run('/x', { q: 1 });

        expect(run.store.getState()).toEqual({ text: 'Hello', error: null, done: true });
        expect(config.onDone).toHaveBeenCalledTimes(1);
        expect(config.onDone).toHaveBeenCalledWith({ text: 'Hello', error: null, done: true });
        expect(onStreaming.mock.calls).toEqual([[true], [false]]);
        expect(mockStreamSse).toHaveBeenCalledWith('/x', expect.objectContaining({ body: { q: 1 } }));
    });

    it('hands onDone a copy, so a later turn cannot rewrite it', async () => {
        sourceOf([frame('content', { text: 'a' }), frame('done')]);
        const { run, config } = runner();
        await run.run('/x', {});
        const reported = (config.onDone as jest.Mock).mock.calls[0]?.[0];
        expect(reported).not.toBe(run.current());
    });

    it('stops reading at the first error frame', async () => {
        const handedOut: string[] = [];
        mockStreamSse.mockImplementation(async function* () {
            for (const f of [frame('content', { text: 'x' }), frame('error', { error: 'no' }), frame('content')]) {
                handedOut.push(f.event);
                yield f;
            }
        });
        const { run } = runner();
        await run.run('/x', {});
        expect(handedOut).toEqual(['content', 'error']);
        expect(run.store.getState()).toMatchObject({ error: 'no', done: true });
    });
});

describe('batching', () => {
    it('shows the seeded turn at once and the tokens no more often than a flush', async () => {
        jest.useFakeTimers();
        hangingAfter(frame('content', { text: 'Hello' }));
        const { run } = runner();

        const finished = run.run('/x', {}, { text: 'seed' });
        expect(run.store.getState().text).toBe('seed');

        await Promise.resolve();
        await Promise.resolve();
        // The token is folded but not yet published…
        expect(run.current().text).toBe('seedHello');
        expect(run.store.getState().text).toBe('seed');
        // …until the flush.
        jest.advanceTimersByTime(FLUSH_INTERVAL_MS);
        expect(run.store.getState().text).toBe('seedHello');

        run.stop();
        await finished;
    });

    it('publishes an update outside a frame immediately', () => {
        const { run } = runner();
        run.update((turn) => {
            turn.text = 'now';
        });
        expect(run.store.getState().text).toBe('now');
    });
});

describe('a turn that does not complete', () => {
    it('keeps what arrived when stopped, without an error', async () => {
        hangingAfter(frame('content', { text: 'partial' }));
        const { run } = runner();
        const finished = run.run('/x', {});
        await new Promise((resolve) => setTimeout(resolve, 10));
        run.stop();
        await finished;
        expect(run.store.getState()).toEqual({ text: 'partial', error: null, done: true });
    });

    it("says the connection was lost, not the platform's words, unless the surface words it itself", async () => {
        mockStreamSse.mockImplementation(async function* () {
            yield frame('content', { text: 'a' });
            throw new Error('socket closed');
        });
        const plain = runner();
        await plain.run.run('/x', {});
        expect(plain.run.store.getState().error).toBe('The connection to the server was lost.');

        const worded = runner({ onFailure: (turn) => void (turn.error = 'Try again later') });
        await worded.run.run('/x', {});
        expect(worded.run.store.getState().error).toBe('Try again later');
    });

    it('reads the idle watchdog letting go as a lost connection, not an abort', async () => {
        mockStreamSse.mockImplementation(async function* () {
            yield* [];
            throw Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' });
        });
        const { run } = runner();
        await run.run('/x', {});
        expect(run.store.getState()).toMatchObject({ error: 'The connection to the server was lost.', done: true });
    });

    it('words a refusal before the first frame the way every other request is worded', async () => {
        mockStreamSse.mockImplementation(async function* () {
            yield* [];
            throw new ApiError('HTTP 502', { status: 502 });
        });
        const { run } = runner();
        await run.run('/x', {});
        expect(run.store.getState().error).toBe('This is not something you did. Try again in a moment.');
    });
});

describe('a DLP question when the turn ends', () => {
    function directRunner() {
        const onDone = jest.fn();
        return { run: new TurnRunner<StreamingTurn>({ empty: emptyStreamingTurn, adapter: DIRECT_FRAMES, onDone }, jest.fn()), onDone };
    }

    it.each([
        ['done', [frame('done')]],
        ['an error frame', [frame('error', { error: 'Model down' })]],
    ])('is dropped on %s: nobody can answer it any more', async (_name, tail) => {
        sourceOf([frame('dlp_preview', { decisionId: 'd1' }), ...tail]);
        const { run, onDone } = directRunner();
        await run.run('/x', {});
        expect(run.store.getState().dlpDecision).toBeNull();
        expect(onDone.mock.calls[0]?.[0]).toMatchObject({ dlpDecision: null });
    });

    it('is dropped when the socket goes or the person stops', async () => {
        hangingAfter(frame('dlp_preview', { decisionId: 'd1' }));
        const { run } = directRunner();
        const finished = run.run('/x', {});
        await new Promise((resolve) => setTimeout(resolve, 10));
        expect(run.current().dlpDecision?.decisionId).toBe('d1');
        run.stop();
        await finished;
        expect(run.store.getState().dlpDecision).toBeNull();
    });
});

describe('whether the server finished a direct turn', () => {
    function directRunner() {
        const onDone = jest.fn();
        return { run: new TurnRunner<StreamingTurn>({ empty: emptyStreamingTurn, adapter: DIRECT_FRAMES, onDone }, jest.fn()), onDone };
    }

    it('is said by `done` alone', async () => {
        sourceOf([frame('content', { text: 'All of it' }), frame('done', { conversationId: 'c1' })]);
        const { run, onDone } = directRunner();
        await run.run('/x', {});
        expect(onDone.mock.calls[0]?.[0]).toMatchObject({ done: true, completed: true, text: 'All of it' });
    });

    it('is not said by a stop, or by a socket that closed first, although both end the turn', async () => {
        hangingAfter(frame('content', { text: 'Half' }));
        const stopped = directRunner();
        const finished = stopped.run.run('/x', {});
        await new Promise((resolve) => setTimeout(resolve, 10));
        stopped.run.stop();
        await finished;
        expect(stopped.onDone.mock.calls[0]?.[0]).toMatchObject({ done: true, completed: false, text: 'Half', error: null });

        sourceOf([frame('content', { text: 'Half' })]);
        const closed = directRunner();
        await closed.run.run('/x', {});
        expect(closed.onDone.mock.calls[0]?.[0]).toMatchObject({ done: true, completed: false, text: 'Half', error: null });
    });
});

describe('a turn replaced by the next one', () => {
    it("leaves the new turn, its flusher and its streaming flag alone", async () => {
        hangingAfter(frame('content', { text: 'old' }));
        const { run, config, onStreaming } = runner();
        const first = run.run('/x', {});
        await new Promise((resolve) => setTimeout(resolve, 10));

        sourceOf([frame('content', { text: 'new' })]);
        const second = run.run('/x', {});
        await Promise.all([first, second]);

        expect(run.store.getState().text).toBe('new');
        expect(config.onDone).toHaveBeenCalledTimes(2);
        expect(onStreaming.mock.calls.at(-1)).toEqual([false]);
    });
});

describe('reset', () => {
    it('empties the published turn', async () => {
        sourceOf([frame('content', { text: 'x' }), frame('done')]);
        const { run } = runner();
        await run.run('/x', {});
        run.reset();
        expect(run.store.getState()).toEqual(emptyMeetingTurn());
    });
});
