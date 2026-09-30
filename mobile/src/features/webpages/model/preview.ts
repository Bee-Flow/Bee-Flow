/**
 * What the page screen's Preview shows, and the one document the WebView
 * loads to show it.
 *
 * The web previews a page by composing its files into an iframe with
 * `sandbox="allow-scripts allow-forms"` and NO `allow-same-origin`
 * (agent-hub WebpagePreview.jsx, "Running shielded"), with a preview token
 * baked in so the page's live bridges (window.beeflowDB, beeflowAI, …) work.
 * The phone shows the same document in the same frame:
 *
 *   - every light-runtime page, plain HTML or React, is built by the SERVER
 *     (GET /api/webpages/:id/draft-document: the web's composer, React bundled
 *     with esbuild, the token baked in) and put in the iframe's `srcdoc` —
 *     the live draft, rebuilt when a builder turn lands;
 *   - a page on the full runtime (its own server container) shows its PUBLIC
 *     address's content document (/w/<slug>/content) while it is public;
 *   - otherwise there is nothing the phone can render, and the screen says so.
 *
 * The WebView loads a tiny wrapper document with no script of its own, whose
 * one child is that sandboxed iframe. The page reaches the server only as the
 * web's preview does — its bridges send the baked token to
 * /api/webpages-preview/<page>/… — and never as the person: the frame has an
 * opaque origin, and the WebView carries no cookies into it (third-party
 * cookies are off). The wrapper around the PUBLIC content sits on the
 * server's origin, because that document may only be framed by 'self'; it
 * still has no script.
 */

import type { Webpage } from './types';

export type PreviewSource =
    | { kind: 'draft' }
    | { kind: 'published'; path: string }
    | { kind: 'unavailable'; reason: 'full' };

export type PreviewDevice = 'mobile' | 'desktop';

/** The web's desktop width (WebpagePreview.jsx PREVIEW_DEVICES.desktop). */
export const DESKTOP_WIDTH = 1440;

export function previewSource(webpage: Webpage): PreviewSource {
    if (webpage.runtime !== 'full') return { kind: 'draft' };
    // The slug outlives switching public off (only publicShareId is cleared),
    // and the address then answers 404 (publicViewer.js resolveShareOr404).
    if (webpage.slug && webpage.publicShareId) {
        return { kind: 'published', path: `/w/${encodeURIComponent(webpage.slug)}/content` };
    }
    return { kind: 'unavailable', reason: 'full' };
}

/** Nothing built yet: every slot empty and no project files. */
export function isUnbuilt(webpage: Webpage, extraFileCount: number): boolean {
    return webpage.htmlSize + webpage.cssSize + webpage.jsSize === 0 && extraFileCount === 0;
}

function escapeAttribute(value: string): string {
    return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * The wrapper the WebView loads: a full-bleed sandboxed iframe, either around
 * a composed document (`srcdoc`) or around the public content address (`src`).
 * The sandbox is the web's, word for word; `referrerpolicy` is the public
 * viewer's.
 */
export function frameDocument(frame: { srcdoc: string } | { src: string }, device: PreviewDevice): string {
    const viewport = device === 'desktop' ? `width=${DESKTOP_WIDTH}` : 'width=device-width,initial-scale=1';
    const content = 'srcdoc' in frame ? `srcdoc="${escapeAttribute(frame.srcdoc)}"` : `src="${escapeAttribute(frame.src)}"`;
    return [
        '<!DOCTYPE html><html><head><meta charset="utf-8">',
        `<meta name="viewport" content="${viewport}">`,
        '<style>html,body{margin:0;height:100%;background:#fff}',
        'iframe{display:block;border:0;width:100%;height:100%}</style></head><body>',
        `<iframe sandbox="allow-scripts allow-forms" referrerpolicy="no-referrer" ${content}></iframe>`,
        '</body></html>',
    ].join('');
}

/** `https://host:port` of a server URL, or null. */
export function originOf(url: string | null): string | null {
    const match = url ? /^https?:\/\/[^/?#]+/i.exec(url) : null;
    return match ? match[0].toLowerCase() : null;
}

export type NavigationDecision = 'load' | 'external' | 'block';

/**
 * What a navigation inside the preview may do.
 *
 *   - the wrapper itself (about:blank / about:srcdoc, or the server's root
 *     when it wraps the public page) loads;
 *   - the public content document loads in its frame, and only there;
 *   - every other web or mail address is somewhere the page LEAVES to, so it
 *     opens in the system browser, never inside the app;
 *   - anything else (javascript:, file:, intent:, data:) is refused.
 */
export function decideNavigation(url: string, isTopFrame: boolean, serverOrigin: string | null): NavigationDecision {
    // nosemgrep: ajinabraham.njsscan.dos.regex_dos.regex_dos -- an anchored alternation of two literals with no quantifier
    if (/^about:(blank|srcdoc)$/i.test(url)) return 'load';
    // The wrapper around a public page sits on the server's origin (see
    // hooks/usePreviewDocument.ts). The page cannot navigate the top frame —
    // its sandbox has no allow-top-navigation — so this is only ever the app's
    // own load of the wrapper.
    if (isTopFrame && serverOrigin !== null && url.toLowerCase() === `${serverOrigin}/`) return 'load';
    // nosemgrep: ajinabraham.njsscan.dos.regex_dos.regex_dos -- the regex below is anchored and its one quantifier, [^/]+, stops at the next /, so it cannot backtrack
    const origin = originOf(url);
    if (origin) {
        // nosemgrep: ajinabraham.njsscan.dos.regex_dos.regex_dos -- anchored, and its one quantifier, [^/]+, stops at the next /, so it cannot backtrack
        const isPublicContent = serverOrigin !== null && origin === serverOrigin && /^\/w\/[^/]+\/content(\?|$)/.test(url.slice(origin.length));
        return isPublicContent && !isTopFrame ? 'load' : 'external';
    }
    // nosemgrep: ajinabraham.njsscan.dos.regex_dos.regex_dos -- an anchored alternation of two literals with no quantifier
    return /^(mailto|tel):/i.test(url) ? 'external' : 'block';
}
