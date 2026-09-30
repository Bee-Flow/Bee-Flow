// The document canvas: a sheet of paper you can type on, in a sandboxed frame.
//
// WHY srcDoc AND NOT src. The composed document (/api/studio-documents/:id/preview)
// needs the session, which an iframe `src` does not reliably carry (the
// Nextcloud embed's partitioned storage, the sandbox's opaque origin), so the
// HTML is fetched with the session and handed to the frame as srcDoc.
//
// WHY THE FRAME IS SANDBOXED when the server already sanitised. Two failures
// have to line up before anything executes: something has to survive the
// sanitiser AND the frame has to have an origin worth reaching.
// `sandbox="allow-scripts"` without `allow-same-origin` removes the second.
//
// The protocol with the frame is server/services/documentEditBridge.js; the
// parsing is canvasBridge.ts. A PRESENTATION in the frame is the slide viewer
// (no edit bridge; `setDraft` shows unsaved outline changes, `goto` moves to
// a slide).

import React, { forwardRef, useCallback, useEffect, useEffectEvent, useImperativeHandle, useMemo, useRef, useState } from 'react';
import type { CommentAnchor } from '../../api/queries/comments';
import useTranslation from '../../hooks/useTranslation';
import { deskColour, parseFrameMessage, type FrameKey, type FrameMessage, type FramePeer, type FrameStats, type OutlineItem } from './canvasBridge';
import { usePreviewHtml } from './documentQueries';

export interface InsertParameter { key: string; type?: string; fields?: Array<{ key: string }> }

export interface CanvasHandle {
    flush(): Promise<void>;
    invalidate(): void;
    insert(parameter: string | InsertParameter): void;
    section(id: string): void;
    setDraft(html: string): void;
    goto(index: number): void;
    scrollTo(index: number): void;
    find(query: string, step?: number): void;
    patchSections(sections: Record<string, string>): Promise<{ applied: string[]; missing: string[] }>;
    setAnchors(list: Array<{ id: string; anchor: CommentAnchor }>, activeId?: string | null): void;
    reveal(anchor: CommentAnchor): void;
}

export interface DocumentCanvasProps {
    documentId: string;
    editing: boolean;
    reloadKey: number;
    peers?: FramePeer[];
    onDirty: (html: string) => void;
    onError?: (message: string) => void;
    onDeckReady?: (slideCount: number) => void;
    onCaret?: (sectionId: string | null) => void;
    onOutline?: (items: OutlineItem[]) => void;
    onStats?: (stats: FrameStats) => void;
    onSelection?: (anchor: CommentAnchor | null) => void;
    onFound?: (result: { count: number; index: number }) => void;
    onKey?: (key: FrameKey) => void;
}

type PatchResult = { applied: string[]; missing: string[] };
type Post = (message: Record<string, unknown>) => void;

const FLUSH_TIMEOUT_MS = 5000;
const PATCH_TIMEOUT_MS = 3000;

/** The frame, whether its bridge is up, and messages held until it is. */
function useFrame() {
    const iframeRef = useRef<HTMLIFrameElement | null>(null);
    const readyRef = useRef(false);
    const queued = useRef<Array<Record<string, unknown>>>([]);
    const send = useCallback((message: Record<string, unknown>) => {
        // '*' is the only usable target for an opaque-origin frame.
        try { iframeRef.current?.contentWindow?.postMessage(message, '*'); } catch { /* frame gone */ }
    }, []);
    const post = useCallback<Post>((message) => {
        if (readyRef.current && iframeRef.current?.contentWindow) send(message);
        else queued.current.push(message);
    }, [send]);
    const drain = useCallback(() => { for (const m of queued.current.splice(0)) send(m); }, [send]);
    // One object for the life of the canvas, so effects that use it run when
    // their own inputs change, not on every render.
    return useMemo(() => ({ iframeRef, readyRef, queued, send, post, drain }), [send, post, drain]);
}

type Frame = ReturnType<typeof useFrame>;

/** Calls that wait for the frame's answer (flush, patch). */
function useReplies() {
    const flushes = useRef(new Map<string, () => void>());
    const patches = useRef<Array<(r: PatchResult) => void>>([]);
    return { flushes, patches };
}

function useCanvasHandle(ref: React.ForwardedRef<CanvasHandle>, frame: Frame, replies: ReturnType<typeof useReplies>, setDraftHtml: (html: string) => void) {
    const { t } = useTranslation();
    const { post, readyRef, queued, send } = frame;
    useImperativeHandle(ref, () => ({
        flush: () => new Promise<void>((resolve, reject) => {
            const requestId = crypto.randomUUID();
            const timer = setTimeout(() => {
                replies.flushes.current.delete(requestId);
                queued.current = queued.current.filter((m) => m.requestId !== requestId);
                reject(new Error(t('documents.canvas.no_answer', 'The editor did not respond. Please retry.')));
            }, FLUSH_TIMEOUT_MS);
            replies.flushes.current.set(requestId, () => { clearTimeout(timer); resolve(); });
            post({ __beeflowDocFlush: true, requestId });
        }),
        invalidate: () => { readyRef.current = false; },
        insert: (parameter) => post({
            __beeflowDocInsert: true,
            ...(typeof parameter === 'string' ? { key: parameter } : { key: parameter.key, ...(parameter.type === 'list' ? { fields: (parameter.fields || []).map((f) => f.key) } : {}) }),
        }),
        section: (id) => post({ __beeflowDocSection: true, id }),
        setDraft: (html) => { readyRef.current = false; setDraftHtml(String(html || '')); },
        goto: (index) => send({ __beeflowDeckGoto: true, index }),
        scrollTo: (index) => post({ __beeflowDocScrollTo: true, index }),
        find: (query, step = 1) => post({ __beeflowDocFind: true, query, step }),
        patchSections: (sections) => new Promise<PatchResult>((resolve) => {
            const timer = setTimeout(() => resolve({ applied: [], missing: Object.keys(sections) }), PATCH_TIMEOUT_MS);
            replies.patches.current.push((r) => { clearTimeout(timer); resolve(r); });
            post({ __beeflowDocPatch: true, sections });
        }),
        setAnchors: (list, activeId = null) => post({
            __beeflowDocAnchors: true, activeId,
            anchors: list.map(({ id, anchor }) => ({ id, quote: anchor.quote, sectionId: anchor.sectionId })),
        }),
        reveal: (anchor) => post({ __beeflowDocReveal: true, quote: anchor.quote, sectionId: anchor.sectionId }),
    }), [post, readyRef, queued, send, replies, setDraftHtml, t]);
}

/** What each message from the frame does. */
function dispatch(m: FrameMessage, props: DocumentCanvasProps, replies: ReturnType<typeof useReplies>, scrollY: React.MutableRefObject<number>) {
    if (m.kind === 'dirty') {
        props.onDirty(m.html);
        if (m.requestId) { replies.flushes.current.get(m.requestId)?.(); replies.flushes.current.delete(m.requestId); }
        return;
    }
    const simple: Partial<Record<FrameMessage['kind'], () => void>> = {
        caret: () => m.kind === 'caret' && props.onCaret?.(m.sectionId),
        outline: () => m.kind === 'outline' && props.onOutline?.(m.items),
        stats: () => m.kind === 'stats' && props.onStats?.(m.stats),
        selection: () => m.kind === 'selection' && props.onSelection?.(m.anchor),
        found: () => m.kind === 'found' && props.onFound?.({ count: m.count, index: m.index }),
        patched: () => m.kind === 'patched' && replies.patches.current.shift()?.({ applied: m.applied, missing: m.missing }),
        scrolled: () => { if (m.kind === 'scrolled') scrollY.current = m.y; },
        key: () => m.kind === 'key' && props.onKey?.(m.key),
    };
    simple[m.kind]?.();
}

const DocumentCanvas = forwardRef<CanvasHandle, DocumentCanvasProps>(function DocumentCanvas(props, ref) {
    const { documentId, editing, reloadKey, peers } = props;
    const { t } = useTranslation();
    const frame = useFrame();
    const replies = useReplies();
    const scrollY = useRef(0);
    const restoreY = useRef<number | null>(null);
    const [draft, setDraftHtml] = useState<string | null>(null);
    const preview = usePreviewHtml(documentId, reloadKey);
    useCanvasHandle(ref, frame, replies, setDraftHtml);

    // A reload keeps the reader where they were; another document starts at the top.
    useEffect(() => { restoreY.current = scrollY.current; setDraftHtml(null); frame.readyRef.current = false; }, [reloadKey, frame.readyRef]);
    useEffect(() => { scrollY.current = 0; restoreY.current = null; }, [documentId]);

    const onReady = useEffectEvent((deck: boolean, slideCount = 0) => {
        frame.readyRef.current = true;
        if (deck) { props.onDeckReady?.(slideCount); return; }
        frame.send({ __beeflowDocEdit: true, editing });
        frame.send({ __beeflowDocTheme: true, desk: deskColour(), fit: true });
        if (peers?.length) frame.send({ __beeflowDocPeers: true, peers });
        if (restoreY.current) frame.send({ __beeflowDocScroll: true, y: restoreY.current });
        restoreY.current = null;
        frame.drain();
    });
    const onFrameMessage = useEffectEvent((data: unknown) => {
        const m = parseFrameMessage(data);
        if (!m) return;
        if (m.kind === 'ready' || m.kind === 'deckReady') onReady(m.kind === 'deckReady', m.kind === 'deckReady' ? m.slideCount : 0);
        else dispatch(m, props, replies, scrollY);
    });
    useEffect(() => {
        const onMessage = (e: MessageEvent) => {
            // The frame's origin is "null"; the identity of the source window is the real check.
            if (frame.iframeRef.current && e.source === frame.iframeRef.current.contentWindow) onFrameMessage(e.data);
        };
        window.addEventListener('message', onMessage);
        return () => window.removeEventListener('message', onMessage);
    }, [frame.iframeRef]);

    // Mode, and other people's sections, are messages: never a reload, which
    // would throw away unsaved typing.
    useEffect(() => { if (frame.readyRef.current) frame.send({ __beeflowDocEdit: true, editing }); }, [editing, frame]);
    const peersKey = JSON.stringify(peers || []);
    useEffect(() => { if (frame.readyRef.current) frame.send({ __beeflowDocPeers: true, peers: JSON.parse(peersKey) }); }, [peersKey, frame]);
    const reportError = useEffectEvent(() => props.onError?.(t('documents.canvas.load_failed', 'Could not load the document preview.')));
    useEffect(() => { if (preview.isError) reportError(); }, [preview.isError]);

    return <CanvasView frameRef={frame.iframeRef} srcDoc={draft ?? preview.data ?? ''} loading={draft == null && preview.isPending} />;
});

function CanvasView({ frameRef, srcDoc, loading }: { frameRef: React.RefObject<HTMLIFrameElement | null>; srcDoc: string; loading: boolean }) {
    const { t } = useTranslation();
    return (
        <div className="relative w-full h-full overflow-auto bg-[var(--bg-tertiary)]" data-testid="document-canvas">
            {loading && (
                <div className="absolute inset-0 flex items-center justify-center z-10 bg-[var(--bg-tertiary)]" role="status" aria-label={t('documents.canvas.loading', 'Loading the document…')}>
                    <div className="w-6 h-6 border-2 border-[var(--accent-primary)] border-t-transparent rounded-full animate-spin" aria-hidden="true" />
                </div>
            )}
            <iframe
                ref={frameRef}
                title={t('documents.canvas.frame_title', 'Document')}
                srcDoc={srcDoc}
                sandbox="allow-scripts"
                referrerPolicy="no-referrer"
                className="block w-full h-full border-0 bg-transparent"
                data-testid="document-frame"
            />
        </div>
    );
}

export default DocumentCanvas;
