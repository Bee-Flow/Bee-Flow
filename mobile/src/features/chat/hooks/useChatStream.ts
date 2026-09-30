/**
 * The streaming direct-chat turn.
 *
 * A mobile-shaped counterpart to agent-hub/src/hooks/useChatEngine.js. The
 * server emits ~70 distinct SSE event names; the web app renders most of them
 * because it has a side panel, a workspace canvas and a browser-automation
 * viewport to render them into. This handles a subset (DIRECT_FRAMES in
 * shared/stream) and, just as deliberately, does not silently drop the rest —
 * `onUnhandled` reports anything unrecognised so a feature added on the server
 * shows up as a gap here instead of as nothing at all.
 *
 * The live turn is a store (`store`), not state: the screen subscribes to the
 * few fields it draws and only the streaming cell subscribes to the text. See
 * shared/stream/turnRunner.ts for the batching and the survivable disconnect.
 */

import {
    DIRECT_FRAMES,
    emptyStreamingTurn,
    useTurnStream,
    type StreamingTurn,
    type TurnSource,
} from '@/shared/stream';

import { dlpResolverFor, type DlpResolver } from './dlpResolver';
import type { SendTurnPayload } from '../model/types';

export interface UseChatStreamOptions {
    /** Called once the turn finishes, successfully or not. */
    onDone?: (turn: StreamingTurn) => void;
    /** Fired for any SSE event this hook does not model. */
    onUnhandled?: (event: string, data: unknown) => void;
}

export interface UseChatStream {
    /** The live turn. Select the fields you draw with `useTurn`. */
    store: TurnSource<StreamingTurn>;
    streaming: boolean;
    send: (payload: SendTurnPayload) => Promise<void>;
    /** Stop the turn. The server aborts the model call when the socket closes. */
    stop: () => void;
    reset: () => void;
    /**
     * Answer a blocked data-loss-prevention prompt. Until this is called the
     * server holds the turn open and nothing further arrives on the stream.
     */
    resolveDlp: DlpResolver;
}

export function useChatStream({ onDone, onUnhandled }: UseChatStreamOptions = {}): UseChatStream {
    const stream = useTurnStream<StreamingTurn>({
        empty: emptyStreamingTurn,
        adapter: DIRECT_FRAMES,
        onDone,
        onUnhandled,
    });

    const send = (payload: SendTurnPayload) =>
        stream.run('/ai/chat/direct/stream', payload, { conversationId: payload.conversationId ?? null });

    const resolveDlp = dlpResolverFor(stream);

    return {
        store: stream.store,
        streaming: stream.streaming,
        send,
        stop: stream.stop,
        reset: stream.reset,
        resolveDlp,
    };
}
