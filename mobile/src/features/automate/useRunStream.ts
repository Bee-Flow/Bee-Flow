/**
 * Live run events.
 *
 * `GET /api/automation/_runs/stream` is a per-user SSE feed of the runner's
 * lifecycle bus (server/core/runEventBus.js). Two things about its wire format
 * decide the shape of this hook:
 *
 *   1. It writes bare `data: {...}` frames with NO `event:` line, so every
 *      frame arrives from streamSse as `{ event: 'message' }` and the real
 *      discriminator is the payload's own `type` field.
 *   2. Its heartbeat is a comment frame (`: keepalive`) every 25s, which
 *      streamSse skips — so the stream can legitimately yield nothing for 25
 *      seconds. The idle timeout below is set well above that; anything
 *      shorter kills a healthy connection on a quiet account.
 *
 * The feed is a NOTIFICATION, never a source of truth. It says "something
 * moved"; the screens re-read the run through React Query, because the stream
 * has no history and a phone that missed thirty seconds in a lift would
 * otherwise render a run that is already finished as still going.
 */

import { useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';

import type { RunEvent, RunStatus } from './types';
import { streamSse } from '../../api/sse';


export interface RunStreamState {
    /** True between the first frame and the socket closing. */
    connected: boolean;
    /** Latest status seen per run id, for rows that want to move immediately. */
    statuses: Record<string, RunStatus>;
    /** The most recent frame of any kind — handy for a live region. */
    last: RunEvent | null;
}

export interface RunStreamOptions {
    /** Scope the feed to one automation. Omit for everything the user owns. */
    automationId?: string;
    enabled?: boolean;
    /** Fired for every frame. Keep it cheap — this runs on the JS thread. */
    onEvent?: (event: RunEvent) => void;
}

/** Comfortably past the server's 25s keepalive without being unbounded. */
const IDLE_TIMEOUT_MS = 75_000;
/** Backoff ceiling. A stream that keeps dying must not become a tight loop. */
const MAX_RETRY_DELAY_MS = 30_000;

export function useRunStream({
    automationId,
    enabled = true,
    onEvent,
}: RunStreamOptions = {}): RunStreamState {
    const [state, setState] = useState<RunStreamState>({
        connected: false,
        statuses: {},
        last: null,
    });

    // Held in a ref so a caller can pass an inline closure without tearing the
    // socket down and rebuilding it on every render. Assigned in an effect
    // rather than during render — a ref written while rendering is a value
    // React is allowed to throw away.
    const handlerRef = useRef(onEvent);
    useEffect(() => {
        handlerRef.current = onEvent;
    }, [onEvent]);

    useEffect(() => {
        if (!enabled) return;

        const controller = new AbortController();
        let cancelled = false;
        let attempt = 0;
        let retryTimer: ReturnType<typeof setTimeout> | undefined;

        const path = automationId
            ? `/api/automation/_runs/stream?automationId=${encodeURIComponent(automationId)}`
            : '/api/automation/_runs/stream';

        const consume = async () => {
            while (!cancelled) {
                try {
                    for await (const frame of streamSse(path, {
                        signal: controller.signal,
                        idleTimeoutMs: IDLE_TIMEOUT_MS,
                    })) {
                        if (cancelled) return;
                        attempt = 0;
                        const event = frame.data as RunEvent | null;
                        if (!event || typeof event !== 'object' || !event.type) continue;

                        setState((prev) => ({
                            connected: true,
                            last: event,
                            statuses:
                                event.runId && event.status
                                    ? { ...prev.statuses, [event.runId]: event.status }
                                    : prev.statuses,
                        }));
                        handlerRef.current?.(event);
                    }
                } catch {
                    // Every failure here is a network fact, not a user-facing
                    // error: the screens keep working on polled data, and the
                    // only cost of a dead stream is that updates arrive on
                    // refresh instead of instantly.
                }
                if (cancelled) return;
                setState((prev) => (prev.connected ? { ...prev, connected: false } : prev));

                // The stream ends on backgrounding too (Android freezes the
                // socket), so waiting for `active` avoids a reconnect storm
                // against a server that will not deliver anything anyway.
                if (AppState.currentState !== 'active') {
                    await waitForForeground();
                    if (cancelled) return;
                    attempt = 0;
                }
                const delay = Math.min(MAX_RETRY_DELAY_MS, 1000 * 2 ** attempt++);
                await new Promise<void>((resolve) => {
                    retryTimer = setTimeout(resolve, delay);
                });
            }
        };

        void consume();

        return () => {
            cancelled = true;
            if (retryTimer) clearTimeout(retryTimer);
            controller.abort();
        };
    }, [automationId, enabled]);

    // `connected` is derived rather than cleared in the effect above: a
    // disabled hook has no socket by definition, and saying so here avoids a
    // setState whose only job is to describe what the props already say.
    return enabled ? state : { ...state, connected: false };
}

function waitForForeground(): Promise<void> {
    return new Promise((resolve) => {
        if (AppState.currentState === 'active') {
            resolve();
            return;
        }
        const sub = AppState.addEventListener('change', (status) => {
            if (status === 'active') {
                sub.remove();
                resolve();
            }
        });
    });
}
