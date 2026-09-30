/**
 * The streaming turn for notebook chat and template chat.
 *
 * These are two separate server runtimes — server/routes/ai/notebookChat.js
 * and server/routes/ai/templateChat.js, mounted under `/ai` by routes/ai.js —
 * with an overlapping vocabulary that is not the direct-chat one. They share
 * the stream stack (shared/stream) with every other chat surface; the frames
 * this runtime sends, and the three that are notebook-only, are in the
 * library adapter (shared/stream/adapters/library.ts).
 *
 * This hook keeps its old shape — `turn` as state — because the notebook
 * screen draws the whole turn; it subscribes to the published turn, which the
 * runner batches the same way as everywhere else.
 */

import { useEffect, useRef, useState } from 'react';

import {
    emptyLibraryTurn,
    libraryFrames,
    useTurn,
    useTurnStream,
    type LibraryTurn,
} from '@/shared/stream';

import type { NotebookSource } from '../model/types';

export type { LibraryTurn } from '@/shared/stream';

export interface LibraryStreamCallbacks {
    onDone?: (turn: LibraryTurn) => void;
    /** A notebook document rewrite: HTML body, optional title, CAS version. */
    onDocumentUpdate?: (content: string, title?: string, version?: number) => void;
    /** A tool saved a research result into the notebook's sources. */
    onSourceAdded?: (source: NotebookSource) => void;
    onUnhandled?: (event: string, data: unknown) => void;
}

export interface UseLibraryChatStream {
    turn: LibraryTurn;
    streaming: boolean;
    /** `path` is the full client path; `body` is the runtime's own payload. */
    send: (path: string, body: Record<string, unknown>) => Promise<void>;
    stop: () => void;
    reset: () => void;
}

export function useLibraryChatStream(callbacks: LibraryStreamCallbacks = {}): UseLibraryChatStream {
    // Held in a ref so a re-rendered parent cannot restart the stream. Synced
    // in an effect rather than during render: the callbacks are only ever read
    // from inside the async loop, which runs long after the commit.
    const cb = useRef(callbacks);
    useEffect(() => {
        cb.current = callbacks;
    });

    const [adapter] = useState(() =>
        libraryFrames(() => ({
            onDocumentUpdate: (content, title, version) => cb.current.onDocumentUpdate?.(content, title, version),
            // The row is the server's; the notebook's own reader narrows it.
            onSourceAdded: (source) => cb.current.onSourceAdded?.(source as NotebookSource),
        })),
    );

    const stream = useTurnStream<LibraryTurn>({
        empty: emptyLibraryTurn,
        adapter,
        onDone: (turn) => cb.current.onDone?.(turn),
        onUnhandled: (event, data) => cb.current.onUnhandled?.(event, data),
    });
    const turn = useTurn(stream.store, (published) => published);

    return {
        turn,
        streaming: stream.streaming,
        send: (path, body) => stream.run(path, body),
        stop: stream.stop,
        reset: stream.reset,
    };
}
