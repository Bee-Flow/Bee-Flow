/**
 * "Open in a new tab" for the webpage preview.
 *
 * The page a user builds runs its own scripts, so it only ever runs inside a
 * frame with PREVIEW_SANDBOX: no `allow-same-origin`, which gives it an opaque
 * origin of its own instead of the app's. The new tab therefore holds nothing
 * but such a frame. The tab itself is an empty document this function fills in
 * with a single sandboxed iframe; the page's markup never becomes the tab's own
 * document, by URL or otherwise.
 *
 * The tab's `opener` is cleared before the frame is added, so neither the
 * frame nor anything it loads can reach the editor window through it.
 */

import { logger } from '@/utils/logger';

/** The sandbox every preview frame runs under, inline and in its own tab. */
export const PREVIEW_SANDBOX = 'allow-scripts allow-forms';

export interface PreviewTabSource {
    /** The full tier: a URL the frame loads. */
    isFull: boolean;
    fullTierUrl: string | null;
    /** Light tier: the composed document the frame shows. */
    srcDoc: string;
}

/**
 * Open a new tab that shows the preview in a sandboxed frame. Returns false
 * when there is nothing to show yet or the browser refused the tab.
 */
export function openPreviewInNewTab(source: PreviewTabSource, title: string): boolean {
    if (source.isFull && !source.fullTierUrl) return false;
    const tab = window.open('', '_blank');
    if (!tab) return false;
    try {
        tab.opener = null;
    } catch (err) {
        // A browser that will not clear it still gets the frame: the frame's
        // own origin is opaque either way.
        logger.debug('[WebpagePreview] could not clear the new tab opener', err);
    }
    const doc = tab.document;
    doc.title = title;
    doc.body.style.margin = '0';
    const frame = doc.createElement('iframe');
    frame.setAttribute('sandbox', PREVIEW_SANDBOX);
    frame.setAttribute('referrerpolicy', 'no-referrer');
    frame.title = title;
    Object.assign(frame.style, {
        position: 'fixed', top: '0', left: '0', width: '100%', height: '100%', border: '0', background: '#fff',
    });
    if (source.isFull) frame.src = source.fullTierUrl as string;
    else frame.srcdoc = source.srcDoc;
    doc.body.appendChild(frame);
    return true;
}
