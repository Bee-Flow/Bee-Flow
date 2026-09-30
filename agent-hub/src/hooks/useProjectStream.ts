import { useEffect, useRef } from 'react';
import { API_BASE, authFetch } from '../utils/helpers';

/**
 * Live subscription to a project's event feed.
 *
 * Modelled directly on components/admin/Studio/Executions/useRunStream.js — the
 * resilience shape there (backoff with jitter, polling fallback, pause while the
 * tab is hidden) already solves this problem, and a second, subtly different
 * implementation would only be a second set of bugs.
 *
 * ── What is different: the cursor ───────────────────────────────────────────
 *
 * Run events are fire-and-forget; project events are not. "You never miss a
 * message" is the promise, so every durable frame carries `id: <seq>` and this
 * hook tracks the highest one it has seen. On reconnect it sends
 * `?since=<cursor>` and the server replays exactly the gap. That makes a
 * dropped connection a latency problem rather than a correctness one.
 *
 * The `ready` frame names the cursor the server started from. A fresh client
 * adopts it: without that, a client that reconnected before its first durable
 * frame sent `since=0` again, the server read that as "start at HEAD", and
 * everything in between was lost.
 *
 * TRANSIENT frames (typing, presence, streaming snapshots, co-editing frames)
 * deliberately carry no `id:`, so they never move the cursor. Otherwise a
 * reconnecting client would faithfully replay "Anna is typing" from ten
 * minutes ago.
 *
 * ── Degraded mode ───────────────────────────────────────────────────────────
 *
 * After three failed connections the hook polls the activity feed (mapped onto
 * the same event kinds) and keeps probing the stream in the background, so a
 * proxy hiccup does not leave the page on 15-second polling until the next
 * reload.
 *
 * Uses fetch streaming rather than EventSource, for the same reason useRunStream
 * does: EventSource cannot set the X-Session-Token header, and putting a token
 * in the query string would land it in access logs.
 */

/** One frame off the feed. `kind` is the event name; the payload's shape is
 *  the consuming screen's business. */
export type ProjectEventHandler = (kind: string, event: unknown) => void;

/** Transport state: a live stream, degraded polling, or stopped for good. */
export type ProjectStreamStatus = 'connecting' | 'live' | 'polling' | 'stopped';

export interface ProjectStreamReady {
    since: number;
    distributed?: boolean;
    /** False for the first connection of this subscription, true afterwards. */
    reconnect: boolean;
}

export interface UseProjectStreamOptions {
    projectId: string | null | undefined;
    enabled?: boolean;
    onEvent?: ProjectEventHandler;
    /** Also receive the frames of this co-edited document (doc.update, doc.awareness, …). */
    doc?: string | null;
    /** Where that document's frames resume; read again at every (re)connect. */
    docSince?: number | (() => number);
    /** Every (re)connection's `ready` frame. */
    onReady?: (ready: ProjectStreamReady) => void;
    onStatus?: (status: ProjectStreamStatus) => void;
    /** After every successful poll of the activity feed while degraded. The feed
     *  logs only some changes (not task edits or chat messages), so the caller
     *  re-reads what it shows here. */
    onPoll?: () => void;
    /** Poll the activity feed while the stream is down (default true). A
     *  document subscription turns it off: activity says nothing about content. */
    pollActivity?: boolean;
    /** A new value opens the stream again (the server let go of the document
     *  part): the cursor and the caller's docSince carry over, nothing is lost. */
    reconnectKey?: string | number;
}

const POLL_MS = 15_000;
const PROBE_MS = 30_000;
const MAX_BACKOFF_MS = 30_000;
const SEEN_POLLED_CAP = 500;

interface ActivityItem { id?: string | number; action?: string; details?: unknown; [key: string]: unknown }

/** Parse one SSE frame into its id, event name and JSON payload. */
function parseFrame(frame: string): { id: string | null; kind: string; payload: unknown } | null {
    let id: string | null = null;
    let kind = 'message';
    const dataLines: string[] = [];
    for (const line of frame.split('\n')) {
        if (line.startsWith('id: ')) id = line.slice(4).trim();
        else if (line.startsWith('event: ')) kind = line.slice(7).trim();
        else if (line.startsWith('data: ')) dataLines.push(line.slice(6));
        // ': ping' comment frames fall through and are ignored.
    }
    if (dataLines.length === 0) return null;
    try { return { id, kind, payload: JSON.parse(dataLines.join('\n')) }; } catch { return null; }
}

/**
 * Activity items (newest first) as stream events, oldest first, skipping the
 * ones already delivered. `seen` is updated and kept to a bounded size.
 */
function polledEvents(items: ActivityItem[], seen: Set<string>): Array<[string, Record<string, unknown>]> {
    const out: Array<[string, Record<string, unknown>]> = [];
    for (const item of items.slice().reverse()) {
        const key = item.id != null ? String(item.id) : null;
        if (key && seen.has(key)) continue;
        if (key) {
            seen.add(key);
            if (seen.size > SEEN_POLLED_CAP) seen.delete(seen.values().next().value as string);
        }
        if (item.action) out.push([item.action, { ...item, kind: item.action, payload: item.details ?? {}, polled: true }]);
    }
    return out;
}

/**
 * Read SSE frames off a response body until it ends or `onFrame` returns
 * false. Frames are separated by a blank line; a chunk can split one, so the
 * tail is held until the next read completes it. Resolves true when the body
 * ended, false when the reader asked to stop.
 */
async function readFrames(body: ReadableStream<Uint8Array>, onFrame: (frame: string) => boolean, stopped: () => boolean): Promise<boolean> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
        const { done, value } = await reader.read();
        if (done || stopped()) return true;
        buffer += decoder.decode(value, { stream: true });
        let sep;
        while ((sep = buffer.indexOf('\n\n')) !== -1) {
            const frame = buffer.slice(0, sep);
            buffer = buffer.slice(sep + 2);
            if (!onFrame(frame)) return false;
        }
    }
}

export default function useProjectStream({
    projectId, enabled = true, onEvent, doc = null, docSince, onReady, onStatus, onPoll, pollActivity = true, reconnectKey = 0,
}: UseProjectStreamOptions): void {
    const onEventRef = useRef(onEvent);
    onEventRef.current = onEvent;
    const onReadyRef = useRef(onReady);
    onReadyRef.current = onReady;
    const onStatusRef = useRef(onStatus);
    onStatusRef.current = onStatus;
    const onPollRef = useRef(onPoll);
    onPollRef.current = onPoll;
    const docSinceRef = useRef(docSince);
    docSinceRef.current = docSince;

    // Survives reconnects (and re-renders) so the gap is replayed, not skipped.
    const cursorRef = useRef(0);
    const cursorProjectRef = useRef<string | null | undefined>(undefined);

    useEffect(() => {
        if (!enabled || !projectId) return undefined;

        // A different project is a different feed — never carry a cursor across.
        // Joining a document on the same project keeps it: the reconnect that
        // adds `doc=` must not lose the project events in between.
        if (cursorProjectRef.current !== projectId) {
            cursorRef.current = 0;
            cursorProjectRef.current = projectId;
        }

        let stopped = false;
        let controller: AbortController | null = null;
        let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
        let pollTimer: ReturnType<typeof setTimeout> | null = null;
        let probeTimer: ReturnType<typeof setTimeout> | null = null;
        let failures = 0;
        let backoff = 1000;
        let polling = false;
        let connections = 0;
        const seenPolled = new Set<string>();

        const emit = (kind: string, data: unknown) => { if (!stopped) onEventRef.current?.(kind, data); };
        const status = (s: ProjectStreamStatus) => { try { onStatusRef.current?.(s); } catch { /* caller's problem */ } };
        const clearTimers = () => {
            for (const t of [reconnectTimer, pollTimer, probeTimer]) if (t) clearTimeout(t);
            reconnectTimer = null; pollTimer = null; probeTimer = null;
        };

        const streamUrl = () => {
            let url = `${API_BASE}/api/projects/${projectId}/stream?since=${cursorRef.current}`;
            if (doc) {
                const raw = typeof docSinceRef.current === 'function' ? docSinceRef.current() : docSinceRef.current;
                const since = Number.isFinite(raw) && (raw as number) > 0 ? Math.floor(raw as number) : 0;
                url += `&doc=${encodeURIComponent(doc)}&docSince=${since}`;
            }
            return url;
        };

        // ── Polling fallback ────────────────────────────────────────────
        // The activity feed, mapped onto the stream's own event shape (kind +
        // payload) so consumers need no second vocabulary. Items already
        // delivered are not delivered again on the next tick.
        const pollOnce = async () => {
            try {
                const res = await authFetch(`${API_BASE}/api/projects/${projectId}/activity?limit=25`);
                if (!res.ok) return;
                const data = await res.json();
                const items: ActivityItem[] = Array.isArray(data?.items) ? data.items : [];
                for (const [kind, event] of polledEvents(items, seenPolled)) emit(kind, event);
                if (!stopped) { try { onPollRef.current?.(); } catch { /* caller's problem */ } }
            } catch { /* keep polling */ }
        };
        const pollTick = async () => {
            if (stopped || !polling) return;
            if (pollActivity) await pollOnce();
            if (!stopped && polling) pollTimer = setTimeout(pollTick, POLL_MS);
        };

        const startPolling = () => {
            if (polling) return;
            polling = true;
            status('polling');
            pollTick();
            probeTimer = setTimeout(probe, PROBE_MS);
        };

        // While degraded, try the stream again now and then; a success ends
        // the polling, a failure only schedules the next probe.
        const probe = () => {
            probeTimer = null;
            if (stopped || !polling) return;
            startStream(true);
        };

        // ── SSE over fetch ──────────────────────────────────────────────
        const scheduleReconnect = () => {
            if (stopped) return;
            status('connecting');
            const jittered = Math.min(backoff, MAX_BACKOFF_MS) * (0.7 + Math.random() * 0.6);
            backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
            reconnectTimer = setTimeout(() => { reconnectTimer = null; if (!stopped) startStream(false); }, jittered);
        };

        const handleFrame = (frame: string): boolean => {
            const parsed = parseFrame(frame);
            if (!parsed) return true;
            const { id, kind, payload } = parsed;
            if (kind === 'ping') return true;

            // Only durable frames advance the cursor.
            if (id !== null) {
                const seq = Number(id);
                if (Number.isFinite(seq) && seq > cursorRef.current) cursorRef.current = seq;
            }

            if (kind === 'ready') {
                const since = Number((payload as { since?: unknown })?.since);
                if (Number.isFinite(since) && since > cursorRef.current) cursorRef.current = since;
                connections += 1;
                try {
                    onReadyRef.current?.({
                        since: cursorRef.current,
                        distributed: (payload as { distributed?: boolean })?.distributed,
                        reconnect: connections > 1,
                    });
                } catch { /* caller's problem */ }
                return true;
            }
            if (kind === 'forbidden') {
                // Access revoked while the stream was open. Say so FIRST (emit
                // is silent once stopped, and the page must learn that its
                // reader was removed), then stop: reconnecting would just 404
                // in a loop.
                emit('forbidden', payload);
                stopped = true;
                clearTimers();
                status('stopped');
                return false;
            }
            emit(kind, payload);
            return true;
        };

        const startStream = async (isProbe: boolean) => {
            if (stopped || (polling && !isProbe)) return;
            controller = new AbortController();
            try {
                const res = await authFetch(streamUrl(), { signal: controller.signal, headers: { Accept: 'text/event-stream' } });
                if (!res.ok || !res.body) throw new Error(`stream ${res.status}`);

                onConnected();
                const ended = await readFrames(res.body, handleFrame, () => stopped);
                if (ended && !stopped) scheduleReconnect();
            } catch {
                if (stopped || controller?.signal?.aborted) return;
                onConnectFailed(isProbe);
            }
        };

        const onConnected = () => {
            failures = 0;
            backoff = 1000;
            if (polling) {
                polling = false;
                if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
                if (probeTimer) { clearTimeout(probeTimer); probeTimer = null; }
            }
            status('live');
        };

        const onConnectFailed = (isProbe: boolean) => {
            if (isProbe || polling) {
                if (polling && !probeTimer) probeTimer = setTimeout(probe, PROBE_MS);
                return;
            }
            failures += 1;
            // Three strikes: the stream is not coming back soon (proxy,
            // corporate network, no SSE support). Degrade rather than spin.
            if (failures >= 3) { startPolling(); return; }
            scheduleReconnect();
        };

        // ── Visibility: don't hold an idle socket open ──────────────────
        const onVisibility = () => {
            if (document.hidden) {
                controller?.abort();
                clearTimers();
            } else if (!stopped) {
                failures = 0; backoff = 1000; polling = false; clearTimers();
                // The cursor is intact, so whatever happened while the tab was
                // hidden is replayed rather than lost.
                startStream(false);
            }
        };
        document.addEventListener('visibilitychange', onVisibility);

        status('connecting');
        if (!document.hidden) startStream(false);

        return () => {
            stopped = true;
            controller?.abort();
            clearTimers();
            document.removeEventListener('visibilitychange', onVisibility);
        };
    }, [projectId, enabled, doc, pollActivity, reconnectKey]);
}
