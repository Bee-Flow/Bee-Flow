import React, { useCallback, useEffect, useEffectEvent, useRef, useState, forwardRef, useImperativeHandle } from 'react';
import { previewUrl } from './documentsApi';
import { authFetch } from '../../utils/helpers';

/**
 * The document canvas: a sheet of paper you can type on.
 *
 * WHY srcDoc AND NOT src. The composed document is served from
 * /api/studio-documents/:id/preview, which needs the session. An iframe `src`
 * carries whatever cookie the browser feels like sending, and in the
 * Nextcloud embed (partitioned storage) that is nothing at all, while a
 * sandboxed frame's opaque origin makes the request cross-site for SameSite
 * purposes anyway. authFetch knows all of that — cookie, X-Session-Token
 * fallback, embed quirks — so the HTML is FETCHED and handed to the frame as
 * srcDoc. That is also what WebpagePreview does, for the same reasons.
 *
 * WHY THE FRAME IS STILL SANDBOXED when the server already sanitised. Two
 * independent failures have to line up before anything executes: something has
 * to survive DOMPurify AND the frame has to have an origin worth reaching.
 * `sandbox="allow-scripts"` with no `allow-same-origin` removes the second, so
 * the edit bridge still runs while the document has no access to the app.
 *
 * THE EDIT CONTRACT (server/services/documentCompose.js owns the other half):
 *   parent → frame  { __beeflowDocEdit, editing }
 *   frame  → parent { __beeflowDocReady }
 *   frame  → parent { __beeflowDocDirty, html }   — debounced in the frame
 *
 * A PRESENTATION in the frame is the slide viewer (documentRenderer, mode
 * 'screen'): no edit bridge — the outline is typed beside the canvas — and
 * two messages of its own:
 *   frame  → parent { __beeflowDeckReady, slideCount }
 *   parent → frame  { __beeflowDeckGoto, index }
 * The editor previews unsaved outline/look changes by handing this canvas
 * freshly rendered HTML through `setDraft`, so the frame never round-trips a
 * keystroke through a save.
 */
const DocumentCanvas = forwardRef(function DocumentCanvas({
    documentId,
    editing,
    reloadKey,
    onDirty,
    onError,
    onDeckReady,
    t,
}, ref) {
    const iframeRef = useRef(null);
    const [srcDoc, setSrcDoc] = useState('');
    const [loading, setLoading] = useState(true);
    const readyRef = useRef(false);
    const requests = useRef(new Map());
    const queuedMessages = useRef([]);
    const postWhenReady = message => {
        if (readyRef.current) iframeRef.current?.contentWindow?.postMessage(message, '*');
        else queuedMessages.current.push(message);
    };
    useImperativeHandle(ref, () => ({
        flush: () => new Promise((resolve, reject) => {
            const requestId = crypto.randomUUID();
            const timer = setTimeout(() => {
                requests.current.delete(requestId);
                queuedMessages.current = queuedMessages.current.filter(m => m.requestId !== requestId);
                reject(new Error('The editor did not respond. Please retry.'));
            }, 5000);
            requests.current.set(requestId, () => {clearTimeout(timer);resolve();});
            postWhenReady({__beeflowDocFlush:true,requestId});
        }),
        invalidate: () => { readyRef.current = false; },
        insert: parameter => postWhenReady({__beeflowDocInsert:true,
            ...(typeof parameter === 'string' ? {key:parameter} : {key:parameter.key,...(parameter.type==='list'?{fields:(parameter.fields || []).map(f=>f.key)}:{})})}),
        section: id => postWhenReady({__beeflowDocSection:true,id}),
        // A presentation drafted but not saved: the server rendered it, the
        // frame shows it. Same sandbox, same CSP-composed bytes.
        setDraft: html => { readyRef.current = false; setSrcDoc(String(html || '')); setLoading(false); },
        goto: index => { try { iframeRef.current?.contentWindow?.postMessage({ __beeflowDeckGoto: true, index }, '*'); } catch { /* frame gone */ } },
    }), []);

    const tr = t || ((_k, fallback) => fallback);
    const reportLoadError = useEffectEvent(() => onError?.(tr('documents.canvas.load_failed', 'Could not load the document preview.')));

    const postEditing = useCallback((on) => {
        const win = iframeRef.current && iframeRef.current.contentWindow;
        if (!win) return;
        // '*' is the only usable target for an opaque-origin frame.
        try { win.postMessage({ __beeflowDocEdit: true, editing: !!on }, '*'); } catch { /* frame gone */ }
    }, []);

    // ── Load the composed document ───────────────────────────────────
    useEffect(() => {
        let cancelled = false;
        readyRef.current = false;
        setLoading(true);
        (async () => {
            try {
                // Always request the edit bridge: it starts inert and is
                // toggled by message, so switching modes never reloads the
                // frame — a reload would throw away unsaved typing.
                const res = await authFetch(previewUrl(documentId, { edit: true }));
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                const html = await res.text();
                if (!cancelled) setSrcDoc(html);
            } catch {
                if (!cancelled) reportLoadError();
            } finally {
                if (!cancelled) setLoading(false);
            }
        })();
        return () => { cancelled = true; };
    }, [documentId, reloadKey]);

    // ── Listen to the frame ──────────────────────────────────────────
    useEffect(() => {
        const onMessage = (e) => {
            // The frame is sandboxed without allow-same-origin, so e.origin is
            // the string "null" and useless as a guard. Identity of the source
            // window is the real check — the same one WebpagePreview makes.
            if (!iframeRef.current || e.source !== iframeRef.current.contentWindow) return;
            const d = e.data;
            if (!d || typeof d !== 'object') return;
            if (d.__beeflowDocReady === true) {
                readyRef.current = true;
                // Apply whatever mode is current now that the bridge is up.
                postEditing(editing);
                for (const message of queuedMessages.current.splice(0)) iframeRef.current.contentWindow.postMessage(message, '*');
                return;
            }
            if (d.__beeflowDeckReady === true) {
                readyRef.current = true;
                onDeckReady?.(Number(d.slideCount) || 0);
                return;
            }
            if (d.__beeflowDocDirty === true && typeof d.html === 'string') {
                onDirty?.(d.html);
                if (d.requestId) { requests.current.get(d.requestId)?.(); requests.current.delete(d.requestId); }
            }
        };
        window.addEventListener('message', onMessage);
        return () => window.removeEventListener('message', onMessage);
    }, [editing, onDirty, onDeckReady, postEditing]);

    // Toggling edit mode is a message, never a reload.
    useEffect(() => {
        if (readyRef.current) postEditing(editing);
    }, [editing, postEditing]);

    return (
        <div
            className="relative w-full h-full overflow-auto"
            style={{ background: 'var(--bg-tertiary)' }}
            data-testid="document-canvas"
        >
            {loading && (
                <div className="absolute inset-0 flex items-center justify-center z-10" style={{ background: 'var(--bg-tertiary)' }}>
                    <div
                        className="w-6 h-6 border-2 border-t-transparent rounded-full animate-spin"
                        style={{ borderColor: 'var(--accent-primary)', borderTopColor: 'transparent' }}
                    />
                </div>
            )}
            <iframe
                ref={iframeRef}
                title={tr('documents.canvas.frame_title', 'Document')}
                srcDoc={srcDoc}
                sandbox="allow-scripts"
                referrerPolicy="no-referrer"
                style={{
                    width: '100%',
                    // The document paints its own A4 sheet on a grey desk
                    // (documentCompose's @media screen block), so the frame is
                    // just a window onto it and carries no chrome of its own.
                    height: '100%',
                    border: 0,
                    background: 'transparent',
                    display: 'block',
                }}
            />
        </div>
    );
});
export default DocumentCanvas;
