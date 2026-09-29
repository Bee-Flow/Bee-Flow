/**
 * The streaming turn for notebook chat and template chat.
 *
 * These are two separate server runtimes — server/routes/ai/notebookChat.js
 * and server/routes/ai/templateChat.js, mounted under `/ai` by routes/ai.js —
 * but they emit an overlapping set of frames and neither is the direct-chat
 * stream, so they share a hook rather than borrowing useChatStream (which
 * hardcodes /ai/chat/direct/stream and models a swarm and a DLP round-trip
 * that neither of these has).
 *
 * Three notebook-only frames matter here and have no equivalent in direct chat:
 *
 *   notebook_doc_update   — the model rewrote the notebook's document. Carries
 *                           the new HTML and the CAS `version`; adopting that
 *                           version is what stops the next save from a false
 *                           409.
 *   notebook_source_added — a research tool saved its result as a new source.
 *                           The sources list must pick it up mid-answer, or it
 *                           appears only after a manual refresh.
 *   history_locked        — the encrypted conversation blob could not be opened
 *                           with this session's key, so the server refused to
 *                           persist the turn. The composer has to lock, not
 *                           silently drop everything the person types next.
 *
 * Token batching is the same trade as in useChatStream: tokens arrive faster
 * than a frame, and setState per token pegs the JS thread exactly while
 * somebody is trying to scroll.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import type { NotebookSource } from './types';
import { streamSse } from '../../api/sse';
import { toKbSources } from '../chat/kbSources';
import type { KbSource, ToolActivity } from '../chat/types';

const FLUSH_INTERVAL_MS = 50;

export interface LibraryTurn {
    text: string;
    thinking: string;
    thinkingActive: boolean;
    phase: string | null;
    tools: ToolActivity[];
    /** Retrieved chunks the answer cites. */
    sources: KbSource[];
    modelId: string | null;
    /** The server stopped for a policy reason. Not an error — its own UI. */
    blocked: { reason: string; detail?: string } | null;
    /** Set by `history_locked`; the composer disables itself on it. */
    locked: boolean;
    error: string | null;
    done: boolean;
}

const EMPTY: LibraryTurn = {
    text: '',
    thinking: '',
    thinkingActive: false,
    phase: null,
    tools: [],
    sources: [],
    modelId: null,
    blocked: null,
    locked: false,
    error: null,
    done: false,
};

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
    const [turn, setTurn] = useState<LibraryTurn>(EMPTY);
    const [streaming, setStreaming] = useState(false);

    // The authoritative turn lives in a ref; state is a throttled projection.
    const live = useRef<LibraryTurn>({ ...EMPTY });
    const dirty = useRef(false);
    const flusher = useRef<ReturnType<typeof setInterval> | null>(null);
    const abort = useRef<AbortController | null>(null);

    // Held in a ref so a re-rendered parent cannot restart the stream. Synced
    // in an effect rather than during render: the callbacks are only ever read
    // from inside the async loop, which runs long after the commit.
    const cb = useRef(callbacks);
    useEffect(() => {
        cb.current = callbacks;
    });

    const publish = useCallback(() => {
        if (!dirty.current) return;
        dirty.current = false;
        setTurn({ ...live.current });
    }, []);

    useEffect(
        () => () => {
            abort.current?.abort();
            if (flusher.current) clearInterval(flusher.current);
        },
        [],
    );

    const reset = useCallback(() => {
        live.current = { ...EMPTY };
        dirty.current = false;
        setTurn({ ...EMPTY });
    }, []);

    const stop = useCallback(() => {
        abort.current?.abort();
    }, []);

    const send = useCallback(
        async (path: string, body: Record<string, unknown>) => {
            abort.current?.abort();
            const controller = new AbortController();
            abort.current = controller;

            live.current = { ...EMPTY };
            dirty.current = true;
            setTurn({ ...live.current });
            setStreaming(true);
            if (!flusher.current) flusher.current = setInterval(publish, FLUSH_INTERVAL_MS);

            const mark = () => {
                dirty.current = true;
            };

            try {
                for await (const frame of streamSse(path, { body, signal: controller.signal })) {
                    apply(live.current, frame.event, frame.data, mark, cb.current);
                    if (live.current.done || live.current.error) break;
                }
            } catch (err) {
                if (controller.signal.aborted) {
                    // Stop pressed, or the screen went away. Keep what arrived.
                    live.current.done = true;
                } else {
                    live.current.error =
                        (err as Error)?.message || 'The connection to the server was lost.';
                }
                mark();
            } finally {
                live.current.done = true;
                mark();
                if (flusher.current) {
                    clearInterval(flusher.current);
                    flusher.current = null;
                }
                publish();
                setStreaming(false);
                abort.current = null;
                cb.current.onDone?.({ ...live.current });
            }
        },
        [publish],
    );

    return { turn, streaming, send, stop, reset };
}

function asRecord(data: unknown): Record<string, unknown> {
    return data && typeof data === 'object' ? (data as Record<string, unknown>) : {};
}

function str(value: unknown): string {
    return typeof value === 'string' ? value : '';
}

/**
 * Fold one frame into the live turn. Event names come from the `send(...)`
 * calls in server/routes/ai/notebookChat.js and templateChat.js.
 */
function apply(
    turn: LibraryTurn,
    event: string,
    data: unknown,
    mark: () => void,
    cb: LibraryStreamCallbacks,
): void {
    const d = asRecord(data);

    switch (event) {
        case 'content':
            turn.text += str(d.text);
            return mark();

        // The privacy shield rewrites text it has already sent. Both of these
        // REPLACE — appending would show the unredacted span and then show it
        // again next to its redaction.
        case 'content_replace':
            turn.text = str(d.text);
            return mark();
        case 'content_redact':
            turn.text = str(d.text) || turn.text;
            return mark();

        case 'thinking':
            turn.thinking += str(d.text);
            turn.thinkingActive = true;
            return mark();
        case 'thinking_start':
            turn.thinkingActive = true;
            return mark();
        case 'thinking_stop':
            turn.thinkingActive = false;
            return mark();

        case 'phase':
            turn.phase = str(d.phase) || str(d.name) || null;
            return mark();
        case 'model_selected':
            turn.modelId = str(d.modelId) || null;
            return mark();

        case 'tool_start': {
            const tool: ToolActivity = {
                id: str(d.name) || `tool-${turn.tools.length}`,
                name: str(d.name) || 'Tool',
                status: 'running',
            };
            turn.tools = [...turn.tools, tool];
            return mark();
        }
        case 'tool_end': {
            const name = str(d.name);
            turn.tools = turn.tools.map((t) =>
                t.name === name ? { ...t, status: 'done' as const } : t,
            );
            return mark();
        }

        // notebookChat.js sends the citation shape from core/kb/citation.js.
        // KbSource calls the body `snippet`, so map rather than cast — and map
        // it in ONE place, shared with the chat and agent streams, since the
        // two that cast instead have been dropping the passage entirely.
        case 'kb_sources':
            turn.sources = toKbSources(d.sources);
            return mark();

        // ── Notebook-only ────────────────────────────────────────────────
        case 'notebook_doc_update':
            cb.onDocumentUpdate?.(
                str(d.content),
                str(d.title) || undefined,
                typeof d.version === 'number' ? d.version : undefined,
            );
            return;
        case 'notebook_source_added': {
            const source = d.source;
            if (source && typeof source === 'object') cb.onSourceAdded?.(source as NotebookSource);
            return;
        }
        case 'history_locked':
            turn.locked = true;
            turn.blocked = {
                reason: 'This notebook’s chat history is encrypted with a key this session does not have.',
                detail: 'Unlock encryption on this device to keep chatting here.',
            };
            return mark();

        // ── Refusals ─────────────────────────────────────────────────────
        case 'dlp_blocked':
            turn.blocked = {
                reason: 'Data-loss prevention stopped this message.',
                detail: str(d.reason) || str(d.message) || undefined,
            };
            return mark();
        case 'guardrail_violation':
        case 'guardrail_blocked':
            turn.blocked = {
                reason: 'A guardrail stopped this response.',
                detail: Array.isArray(d.rules) ? d.rules.join(', ') : str(d.reason) || undefined,
            };
            return mark();
        case 'unicode_smuggling_detected':
            turn.blocked = {
                reason: 'Hidden characters were removed from this message before it was sent.',
            };
            return mark();

        case 'done':
            turn.done = true;
            turn.thinkingActive = false;
            return mark();
        case 'error':
            turn.error = str(d.error) || 'The server reported an error.';
            turn.done = true;
            return mark();

        // ── Deliberately ignored ─────────────────────────────────────────
        // The heartbeat and the privacy-shield telemetry, which exists to fill
        // a desktop side panel. Listed so "we ignore this" is a decision.
        case 'ping':
        case 'document_truncated':
        case 'pii_tokenized':
        case 'privacy_payload':
        case 'privacy_token_map':
        case 'tokenisation_info':
        case 'token_savings':
            return;

        default:
            cb.onUnhandled?.(event, data);
    }
}
