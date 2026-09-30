/**
 * The streamed endpoints over a mocked transport: the builder turn delivers
 * typed events in order and swallows the heartbeat, the data-only runtime
 * streams deliver `{ type }` frames, and the session read treats 404 as "no
 * session yet".
 */

import { api, ApiError } from '@/core/api/client';
import { streamSse, type SseFrame } from '@/core/api/sse';

import { getBuilderSession, streamBuilderTurn } from './endpointsBuilder';
import { streamAppChat, streamBrowseStep, type TypedFrame } from './endpointsStreams';
import type { BuilderEvent } from '../model/builderTypes';

jest.mock('@/core/api/client', () => ({
    ...jest.requireActual('@/core/api/client'),
    api: { get: jest.fn() },
}));
jest.mock('@/core/api/sse', () => ({ streamSse: jest.fn() }));

const get = api.get as jest.Mock;
const sse = streamSse as jest.MockedFunction<typeof streamSse>;

function framesOf(frames: SseFrame[]) {
    return (async function* gen() {
        for (const frame of frames) yield frame;
    })();
}

beforeEach(() => {
    get.mockReset();
    sse.mockReset();
});

describe('the builder', () => {
    it('reads the session and treats 404 as none', async () => {
        get.mockResolvedValueOnce({ snapshot: { sessionId: 's1', messages: [] } });
        expect((await getBuilderSession('a1'))?.sessionId).toBe('s1');
        expect(get).toHaveBeenCalledWith('/api/studio-apps/builder/session/a1', { signal: undefined });

        get.mockRejectedValueOnce(new ApiError('No builder session', { status: 404 }));
        expect(await getBuilderSession('a1')).toBeNull();

        get.mockRejectedValueOnce(new ApiError('boom', { status: 500 }));
        await expect(getBuilderSession('a1')).rejects.toMatchObject({ status: 500 });
    });

    it('streams a turn as typed events, without the heartbeat', async () => {
        sse.mockReturnValueOnce(framesOf([
            { event: 'builder_session', data: { sessionId: 's1', appId: 'a1' } },
            { event: 'ping', data: {} },
            { event: 'message', data: { content: 'Building' } },
            { event: 'done', data: { appId: 'a1', finalized: true } },
        ]));
        const events: BuilderEvent[] = [];
        const controller = new AbortController();
        await streamBuilderTurn({ message: 'Make a CRM', appId: 'a1' }, { signal: controller.signal, onEvent: (e) => events.push(e) });
        expect(sse).toHaveBeenCalledWith('/api/studio-apps/builder/stream', expect.objectContaining({
            body: { message: 'Make a CRM', appId: 'a1' },
            signal: controller.signal,
        }));
        expect(events.map((e) => e.type)).toEqual(['builder_session', 'message', 'done']);
        expect(events[2]).toEqual({ type: 'done', appId: 'a1', finalized: true });
    });
});

describe('runtime streams', () => {
    it('forwards typed browse frames and skips pings and junk', async () => {
        sse.mockReturnValueOnce(framesOf([
            { event: 'message', data: { type: 'queued' } },
            { event: 'message', data: { type: 'ping' } },
            { event: 'message', data: 'not json' },
            { event: 'message', data: { type: 'result', ok: true, result: { price: 3 } } },
        ]));
        const frames: TypedFrame[] = [];
        await streamBrowseStep('a1', 'look', { stepIndex: 1, draft: true }, { onFrame: (f) => frames.push(f) });
        expect(sse).toHaveBeenCalledWith(
            '/api/studio-apps/a1/actions/look/step/stream?draft=1',
            expect.objectContaining({ body: { stepIndex: 1, formValues: {}, vars: {} } }),
        );
        expect(frames).toEqual([{ type: 'queued' }, { type: 'result', ok: true, result: { price: 3 } }]);
    });

    it('sends a chat turn for one component', async () => {
        sse.mockReturnValueOnce(framesOf([{ event: 'message', data: { type: 'text', text: 'Hi' } }]));
        const frames: TypedFrame[] = [];
        await streamAppChat('a1', { nodeId: 'n1', messages: [{ role: 'user', content: 'Hello' }] }, { onFrame: (f) => frames.push(f) });
        expect(sse).toHaveBeenCalledWith('/api/studio-apps/a1/ai/chat', expect.objectContaining({
            body: { nodeId: 'n1', messages: [{ role: 'user', content: 'Hello' }] },
        }));
        expect(frames).toEqual([{ type: 'text', text: 'Hi' }]);
    });
});
