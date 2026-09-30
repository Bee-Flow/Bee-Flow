/**
 * A streamed chat turn as a hook: a TurnRunner owned by the component, its
 * `streaming` flag as state, and its live turn as a store that only the
 * components that need a field subscribe to (see useTurn).
 *
 * The config is handed to the runner after every render, so a screen that
 * passes fresh callbacks neither restarts the stream nor changes `run`'s
 * identity.
 */

import { useEffect, useState } from 'react';
import { useStore } from 'zustand';
import type { StoreApi } from 'zustand/vanilla';

import { TurnRunner, type TurnStreamConfig } from './turnRunner';
import type { TurnBase } from './types';

/** The read side of a turn store — what a subscriber needs, nothing it could write. */
export type TurnSource<S> = Pick<StoreApi<S>, 'getState' | 'getInitialState' | 'subscribe'>;

/** Subscribe to one slice of a live turn; re-renders only when that slice changes. */
export function useTurn<S, U>(source: TurnSource<S>, select: (turn: S) => U): U {
    return useStore(source, select);
}

export interface TurnStream<S> {
    store: TurnSource<S>;
    streaming: boolean;
    /** Open `path` with `body` and fold its frames. Resolves once the turn ends. */
    run: (path: string, body: unknown, seed?: Partial<S>) => Promise<void>;
    /** Stop the turn; whatever arrived is kept. */
    stop: () => void;
    /** Back to an empty turn. */
    reset: () => void;
    /** Change the live turn outside a frame and publish it now. */
    update: (change: (turn: S) => void) => void;
    /** The authoritative live turn, ahead of the store by up to one flush. */
    current: () => S;
}

export function useTurnStream<S extends TurnBase>(config: TurnStreamConfig<S>): TurnStream<S> {
    const [streaming, setStreaming] = useState(false);
    const [runner] = useState(() => new TurnRunner<S>(config, setStreaming));
    useEffect(() => {
        runner.configure(config);
    });
    useEffect(() => () => runner.dispose(), [runner]);

    const [api] = useState(() => ({
        store: runner.store,
        run: (path: string, body: unknown, seed?: Partial<S>) => runner.run(path, body, seed),
        stop: () => runner.stop(),
        reset: () => runner.reset(),
        update: (change: (turn: S) => void) => runner.update(change),
        current: () => runner.current(),
    }));

    return { ...api, streaming };
}
