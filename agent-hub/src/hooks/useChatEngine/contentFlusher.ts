import type { Dispatch, RefObject, SetStateAction } from 'react';
import type { ChatMessage } from './types';

/** A frame handle: a rAF id in a browser, a timer handle in the fallback. */
type FrameHandle = ReturnType<typeof setTimeout> | number;

// rAF helpers with a setTimeout fallback for non-browser environments. Resolved
// at call time (not module load) so they pick up the real/mocked global.
const _raf = (cb: (t: number) => void): FrameHandle => (typeof requestAnimationFrame === 'function')
    ? requestAnimationFrame(cb)
    : setTimeout(() => cb(Date.now()), 16);
const _caf = (id: FrameHandle) => (typeof cancelAnimationFrame === 'function')
    ? cancelAnimationFrame(id as number)
    : clearTimeout(id as ReturnType<typeof setTimeout>);

/**
 * Per-stream content flusher. Coalesces high-frequency 'content' tokens into at
 * most one setMessages per animation frame (~60fps) instead of one per token,
 * which previously re-rendered the whole message list on every token.
 *
 * The accumulated text lives in `contentRef` (always current — appended
 * synchronously by the caller); the flusher only controls WHEN that text is
 * committed to React state. Callers MUST flushNow() before any handler that
 * reads committed content (done/finalize/interrupt) and cancel() on abort so a
 * late frame can't resurrect text after the stream ended.
 */
export interface ContentFlusher {
    /** Mark new content available and ensure a frame is scheduled. */
    schedule: (name?: string, avatar?: string) => void;
    /** Commit any buffered content synchronously (before terminal events). */
    flushNow: () => void;
    /** Drop any buffered content + scheduled frame (on replace/abort). */
    cancel: () => void;
}

export function createContentFlusher(
    setMessages: Dispatch<SetStateAction<ChatMessage[]>>,
    activeIdRef: RefObject<string | null>,
    contentRef: RefObject<string>,
): ContentFlusher {
    let rafId: FrameHandle | null = null;
    let pending = false;
    let latestName: string | undefined;
    let latestAvatar: string | undefined;

    const flush = () => {
        rafId = null;
        if (!pending) return;
        pending = false;
        const content = contentRef.current;
        setMessages(prev => prev.map(m =>
            m.id === activeIdRef.current ? {
                ...m,
                content,
                // First content settles the pre-LLM phase indicator (mirrors the
                // original per-token behaviour).
                currentPhase: m.currentPhase ? null : m.currentPhase,
                respondingAgentName: latestName ?? m.respondingAgentName,
                respondingAgentAvatar: latestAvatar ?? m.respondingAgentAvatar,
            } : m
        ));
    };

    return {
        // `name`/`avatar` carry the last-seen responder identity into the
        // coalesced flush.
        schedule(name?: string, avatar?: string) {
            if (name) latestName = name;
            if (avatar) latestAvatar = avatar;
            pending = true;
            if (rafId == null) rafId = _raf(flush);
        },
        flushNow() {
            if (rafId != null) { _caf(rafId); rafId = null; }
            if (pending) flush();
        },
        cancel() {
            if (rafId != null) { _caf(rafId); rafId = null; }
            pending = false;
        },
    };
}
