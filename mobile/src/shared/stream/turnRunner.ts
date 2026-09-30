/**
 * Runs one streamed turn: opens the stream, folds its frames through a
 * surface adapter, and publishes the live turn into a small zustand store.
 *
 * Two mobile-specific behaviours that the web engine does not need:
 *
 *   1. Token batching. Tokens arrive faster than 60fps, and setState per
 *      token pegs the JS thread — the composer stops responding to typing at
 *      exactly the moment a user is most likely to be interacting. Frames
 *      mutate a live object; it is published at most every FLUSH_INTERVAL_MS,
 *      and only when something changed.
 *   2. A store, not state. Only the components that select a field re-render
 *      when it changes: the streaming cell for `text`, a banner for `blocked`.
 *      The screen and every finished bubble stay still while an answer streams.
 *
 * A dropped stream is survivable: whatever arrived is kept, the turn is marked
 * done, and the caller can reload the conversation to pick up the rest.
 */

import { createStore, type StoreApi } from 'zustand/vanilla';

import { streamSse } from '@/core/api/sse';

import { reduceFrame, type FrameAdapter } from './chatFrameReducer';
import { dropDlpQuestion } from './handlers';
import { describeTurnFailure } from './turnFailure';
import type { TurnBase } from './types';

/**
 * 50ms is deliberately slower than a frame: text arriving at 20 updates a
 * second still reads as "typing", and the main-thread time this gives back is
 * what keeps scrolling smooth while an answer streams.
 */
export const FLUSH_INTERVAL_MS = 50;

export interface TurnStreamConfig<S extends TurnBase> {
    /** A fresh empty turn. */
    empty: () => S;
    adapter: FrameAdapter<S>;
    /** Called once the turn finishes, successfully or not, with a copy. */
    onDone?: (turn: S) => void;
    /** Fired for any event the adapter does not account for. */
    onUnhandled?: (event: string, data: unknown) => void;
    /** A failure that was not the user stopping. Default: describeTurnFailure's words. */
    onFailure?: (turn: S, err: unknown) => void;
}

function defaultFailure(turn: TurnBase, err: unknown): void {
    turn.error = describeTurnFailure(err);
}

export class TurnRunner<S extends TurnBase> {
    readonly store: StoreApi<S>;
    private readonly empty: () => S;
    private config: TurnStreamConfig<S>;
    private live: S;
    private dirty = false;
    private flusher: ReturnType<typeof setInterval> | null = null;
    private abort: AbortController | null = null;

    constructor(
        config: TurnStreamConfig<S>,
        private readonly onStreaming: (streaming: boolean) => void,
    ) {
        this.empty = config.empty;
        this.config = config;
        this.live = config.empty();
        this.store = createStore<S>(() => config.empty());
    }

    /**
     * Swap the callbacks and adapter without restarting anything: a running
     * turn uses the new ones from its next frame. `empty` is fixed for life.
     */
    configure(next: TurnStreamConfig<S>): void {
        this.config = next;
    }

    /** The authoritative live turn — ahead of the store by up to one flush. */
    current(): S {
        return this.live;
    }

    publish = (): void => {
        if (!this.dirty) return;
        this.dirty = false;
        this.store.setState({ ...this.live }, true);
    };

    /** Change the live turn outside a frame (an optimistic answer) and publish now. */
    update(change: (turn: S) => void): void {
        change(this.live);
        this.dirty = true;
        this.publish();
    }

    reset(): void {
        this.live = this.empty();
        this.dirty = false;
        this.store.setState(this.empty(), true);
    }

    /** Stop the turn. Closing the socket is what aborts the model call server-side. */
    stop(): void {
        this.abort?.abort();
    }

    dispose(): void {
        this.abort?.abort();
        if (this.flusher) clearInterval(this.flusher);
        this.flusher = null;
    }

    async run(path: string, body: unknown, seed?: Partial<S>): Promise<void> {
        this.abort?.abort();
        const controller = new AbortController();
        this.abort = controller;
        // Captured per run, so a stream that is still unwinding after being
        // replaced can only ever touch its own turn.
        const turn: S = { ...this.empty(), ...seed };
        this.live = turn;
        this.dirty = true;
        this.publish();
        this.onStreaming(true);
        this.flusher ??= setInterval(this.publish, FLUSH_INTERVAL_MS);

        try {
            await this.fold(turn, path, body, controller.signal);
        } catch (err) {
            if (controller.signal.aborted) turn.done = true;
            else (this.config.onFailure ?? defaultFailure)(turn, err);
            this.dirty = true;
        } finally {
            turn.done = true;
            this.finish(turn, controller);
        }
    }

    private async fold(turn: S, path: string, body: unknown, signal: AbortSignal): Promise<void> {
        const { adapter, onUnhandled } = this.config;
        const sink = {
            mark: () => {
                this.dirty = true;
            },
            onUnhandled,
        };
        for await (const frame of streamSse(path, { body, signal })) {
            reduceFrame(adapter, turn, frame, sink);
            // `done` and hard errors end the turn now, not on the next tick.
            if (turn.done || turn.error) break;
        }
    }

    private finish(turn: S, controller: AbortController): void {
        // However it ended — `done`, an error frame, a stop, a dropped socket —
        // the turn is waiting on nobody now, so a question it raised is moot.
        dropDlpQuestion(turn);
        if (this.abort !== controller) {
            // Replaced by a newer run: that one owns the flusher and the flag.
            this.config.onDone?.({ ...turn });
            return;
        }
        this.dirty = true;
        if (this.flusher) clearInterval(this.flusher);
        this.flusher = null;
        this.publish();
        this.onStreaming(false);
        this.abort = null;
        this.config.onDone?.({ ...turn });
    }
}
