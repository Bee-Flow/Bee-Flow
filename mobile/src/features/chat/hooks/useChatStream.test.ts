/**
 * The streaming turn, driven by a fake SSE source.
 *
 * What is pinned is the hook's contract with the screen rather than the
 * reducer's per-event arithmetic (shared/stream has those tests): tokens
 * accumulate into the published turn's `text`, the server-assigned id and
 * title land where the screen reads them, a hard
 * error ends the turn without consuming what follows, a DLP question holds
 * the turn open until `resolveDlp` answers it (and comes down when the server
 * stops waiting, or answers too late with a 404), a user stop keeps what
 * arrived, and a dropped connection becomes an error the caller can show.
 *
 * `renderHook` and `unmount` are ASYNC in @testing-library/react-native 14,
 * and every `act` is awaited — an act left un-awaited stalls React's queue and
 * the NEXT test renders nothing. So the assertions read the flushed
 * projection rather than a value the 50ms flusher has not published yet.
 */

import { act, renderHook } from '@testing-library/react-native';

import { api, ApiError } from '@/core/api/client';
import type { SseFrame } from '@/core/api/sse';

import { DlpQuestionExpired } from './dlpResolver';
import { useChatStream } from './useChatStream';
import type { SendTurnPayload } from '../model/types';

const mockStreamSse = jest.fn();
jest.mock('@/core/api/sse', () => ({
    streamSse: (...args: unknown[]) => mockStreamSse(...args),
}));
jest.mock('@/core/api/client', () => ({
    ...jest.requireActual('@/core/api/client'),
    api: { post: jest.fn(async () => null) },
}));

/** A stream that yields the given frames and then ends, counting what it handed out. */
function sourceOf(frames: SseFrame[]) {
    const handedOut: string[] = [];
    mockStreamSse.mockImplementation(async function* () {
        for (const frame of frames) {
            handedOut.push(frame.event);
            yield frame;
        }
    });
    return handedOut;
}

/** A stream that yields one frame and then hangs until the caller aborts. */
function hangingSourceAfter(frame: SseFrame) {
    mockStreamSse.mockImplementation(async function* (_path: string, opts: { signal: AbortSignal }) {
        yield frame;
        await new Promise<never>((_, reject) => {
            opts.signal.addEventListener('abort', () => reject(new Error('aborted')));
        });
    });
}

/** Let the stream deliver what it has and the flusher publish it. */
async function settle(): Promise<void> {
    await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 80));
    });
}

const PAYLOAD: SendTurnPayload = {
    message: 'Hello',
    modelTier: 'standard',
    attachments: [],
    webSearchEnabled: false,
    memoryWriteEnabled: false,
    timezone: 'Europe/Amsterdam',
};

const frame = (event: string, data: unknown = {}): SseFrame => ({ event, data });

beforeEach(() => {
    mockStreamSse.mockReset();
    (api.post as jest.Mock).mockClear();
});

describe('a turn that completes', () => {
    it('accumulates the answer and reports the id and title the server assigned', async () => {
        sourceOf([
            frame('conversation_created', { conversationId: 'c1' }),
            frame('content', { text: 'Hel' }),
            frame('content', { text: 'lo' }),
            frame('title', { title: 'Greetings' }),
            frame('done', { conversationId: 'c1' }),
        ]);
        const onDone = jest.fn();
        const { result } = await renderHook(() => useChatStream({ onDone }));

        await act(async () => {
            await result.current.send(PAYLOAD);
        });

        expect(result.current.store.getState()).toMatchObject({
            text: 'Hello',
            conversationId: 'c1',
            title: 'Greetings',
            done: true,
            error: null,
        });
        expect(result.current.streaming).toBe(false);
        expect(onDone).toHaveBeenCalledTimes(1);
        expect(onDone.mock.calls[0]?.[0]).toMatchObject({ text: 'Hello', conversationId: 'c1' });
        expect(mockStreamSse).toHaveBeenCalledWith(
            '/ai/chat/direct/stream',
            expect.objectContaining({ body: PAYLOAD }),
        );
    });

    it('reports an event it does not model instead of dropping it', async () => {
        sourceOf([frame('event_from_next_year', { a: 1 }), frame('done')]);
        const onUnhandled = jest.fn();
        const { result } = await renderHook(() => useChatStream({ onUnhandled }));

        await act(async () => {
            await result.current.send(PAYLOAD);
        });

        expect(onUnhandled).toHaveBeenCalledWith('event_from_next_year', { a: 1 });
    });

    it('starts from the conversation id the payload names', async () => {
        sourceOf([frame('done')]);
        const { result } = await renderHook(() => useChatStream());

        await act(async () => {
            await result.current.send({ ...PAYLOAD, conversationId: 'existing' });
        });

        expect(result.current.store.getState().conversationId).toBe('existing');
    });
});

describe('a turn that fails', () => {
    it("ends on the server's error frame and reads nothing after it", async () => {
        const handedOut = sourceOf([
            frame('content', { text: 'partial' }),
            frame('error', { error: 'Model unavailable' }),
            frame('content', { text: ' never' }),
        ]);
        const { result } = await renderHook(() => useChatStream());

        await act(async () => {
            await result.current.send(PAYLOAD);
        });

        expect(result.current.store.getState()).toMatchObject({
            text: 'partial',
            error: 'Model unavailable',
            done: true,
        });
        expect(handedOut).toEqual(['content', 'error']);
    });

    it('turns a dropped connection into an error the screen can show', async () => {
        mockStreamSse.mockImplementation(async function* () {
            yield frame('content', { text: 'Hel' });
            throw new Error('The connection to the server was lost.');
        });
        const onDone = jest.fn();
        const { result } = await renderHook(() => useChatStream({ onDone }));

        await act(async () => {
            await result.current.send(PAYLOAD);
        });

        expect(result.current.store.getState().text).toBe('Hel');
        expect(result.current.store.getState().error).toBe('The connection to the server was lost.');
        expect(result.current.store.getState().done).toBe(true);
        expect(onDone).toHaveBeenCalledTimes(1);
    });
});

describe('stopping', () => {
    it('keeps what arrived and ends the turn without an error', async () => {
        hangingSourceAfter(frame('content', { text: 'Hello' }));
        const onDone = jest.fn();
        const { result } = await renderHook(() => useChatStream({ onDone }));

        let finished: Promise<void> | undefined;
        await act(async () => {
            finished = result.current.send(PAYLOAD);
        });
        await settle();
        expect(result.current.store.getState().text).toBe('Hello');
        expect(result.current.streaming).toBe(true);

        await act(async () => {
            result.current.stop();
            await finished;
        });

        expect(result.current.store.getState()).toMatchObject({ text: 'Hello', done: true, error: null });
        expect(result.current.streaming).toBe(false);
        expect(onDone).toHaveBeenCalledTimes(1);
    });
});

describe('a data-loss-prevention question', () => {
    it('holds the decision until resolveDlp answers on the side channel', async () => {
        hangingSourceAfter(frame('dlp_preview', { decisionId: 'd1', summary: 'Two names found' }));
        const { result } = await renderHook(() => useChatStream());

        let finished: Promise<void> | undefined;
        await act(async () => {
            finished = result.current.send(PAYLOAD);
        });
        await settle();
        expect(result.current.store.getState().dlpDecision).toMatchObject({
            decisionId: 'd1',
            summary: 'Two names found',
            kind: 'chat_text',
            findings: [],
        });

        await act(async () => {
            await result.current.resolveDlp('redact', true);
        });

        expect(api.post).toHaveBeenCalledWith(
            '/api/chat/dlp-decision',
            { decisionId: 'd1', choice: 'redact', rememberForConversation: true },
            { retry: false },
        );
        expect(result.current.store.getState().dlpDecision).toBeNull();

        await act(async () => {
            result.current.stop();
            await finished;
        });
    });

    it('takes the review down when the server stops waiting, and says why', async () => {
        sourceOf([
            frame('dlp_preview', { decisionId: 'd1' }),
            frame('dlp_blocked', { reason: 'timeout', findings: [] }),
            frame('done', {}),
        ]);
        const { result } = await renderHook(() => useChatStream());
        await act(async () => {
            await result.current.send(PAYLOAD);
        });
        expect(result.current.store.getState()).toMatchObject({
            dlpDecision: null,
            blocked: { reason: 'Data-loss prevention stopped this message.', detail: 'Blocked: DLP decision timed out.' },
        });
    });

    it('takes the review down when the answer comes too late, instead of leaving it up to fail again', async () => {
        hangingSourceAfter(frame('dlp_preview', { decisionId: 'd1' }));
        (api.post as jest.Mock).mockRejectedValueOnce(
            new ApiError('Decision not found, expired, or not owned by this user.', { status: 404 }),
        );
        const { result } = await renderHook(() => useChatStream());

        let finished: Promise<void> | undefined;
        await act(async () => {
            finished = result.current.send(PAYLOAD);
        });
        await settle();

        let thrown: unknown;
        await act(async () => {
            await result.current.resolveDlp('allow').catch((err: unknown) => (thrown = err));
        });
        expect(thrown).toBeInstanceOf(DlpQuestionExpired);
        expect(result.current.store.getState().dlpDecision).toBeNull();

        await act(async () => {
            result.current.stop();
            await finished;
        });
    });

    it('does nothing when there is no pending decision', async () => {
        const { result } = await renderHook(() => useChatStream());
        await act(async () => {
            await result.current.resolveDlp('allow');
        });
        expect(api.post).not.toHaveBeenCalled();
    });
});

describe('reset', () => {
    it('clears the turn back to empty', async () => {
        sourceOf([frame('content', { text: 'x' }), frame('done')]);
        const { result } = await renderHook(() => useChatStream());
        await act(async () => {
            await result.current.send(PAYLOAD);
        });
        await act(async () => { result.current.reset(); });
        expect(result.current.store.getState()).toMatchObject({ text: '', done: false, conversationId: null });
    });
});
