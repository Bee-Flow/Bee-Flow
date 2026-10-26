// A Studio document's preview HTML in a sandboxed frame.
//
// srcDoc, not src: the HTML comes from an authenticated JSON read (the frame
// could not carry the session), and `sandbox="allow-scripts"` WITHOUT
// allow-same-origin gives it an opaque origin: the deck viewer's own script
// (fit to width, keyboard paging) runs, but nothing in the frame can reach the
// app, its storage or its session. The server sanitised the markup and put a
// CSP in it as well (appDocuments/deps.mts), so two things would have to fail.
//
// `slide` scrolls a deck to that frame (0 = the cover), the same message the
// Documents editor sends (core/documents/render/deckHtml.js SCREEN_DECK_SCRIPT).

import { useEffect, useRef, useState } from 'react';

export default function DocumentFrame({ html, title, slide = null, className = '' }: { html: string; title: string; slide?: number | null; className?: string }) {
    const ref = useRef<HTMLIFrameElement | null>(null);
    // Ready FOR this html: a new document in the same frame is not ready until it says so.
    const [readyFor, setReadyFor] = useState<string | null>(null);
    const ready = readyFor === html;
    useEffect(() => {
        const onMessage = (e: MessageEvent) => {
            if (e.source && e.source === ref.current?.contentWindow && (e.data as { __beeflowDeckReady?: boolean })?.__beeflowDeckReady === true) setReadyFor(html);
        };
        window.addEventListener('message', onMessage);
        return () => window.removeEventListener('message', onMessage);
    }, [html]);
    useEffect(() => {
        if (!ready || slide === null || slide < 0) return;
        // '*' is the only target an opaque-origin frame accepts.
        ref.current?.contentWindow?.postMessage({ __beeflowDeckGoto: true, index: slide }, '*'); // nosemgrep: javascript.browser.security.wildcard-postmessage-configuration.wildcard-postmessage-configuration -- sandboxed srcDoc frame has an opaque origin
    }, [ready, slide]);
    return (
        <iframe
            ref={ref}
            title={title}
            srcDoc={html}
            sandbox="allow-scripts"
            referrerPolicy="no-referrer"
            className={`block h-full w-full border-0 bg-white ${className}`}
            data-document-frame="true"
        />
    );
}
