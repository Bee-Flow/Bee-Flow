/**
 * The document the Preview's WebView loads (see model/preview.ts for what it
 * is and why). A light-runtime page — plain HTML or React — is the document
 * the server built from the draft (GET /:id/draft-document), in the sandboxed
 * frame's `srcdoc`. A builder turn invalidates it, so the preview shows the
 * new page when the turn lands.
 */

import { apiUrl, getServerUrl } from '@/core/api/server';

import { useDraftDocument } from './queries';
import { frameDocument, originOf, previewSource, type PreviewDevice, type PreviewSource } from '../model/preview';
import type { WebpageDetail } from '../model/types';

export type PreviewDocument =
    | { status: 'loading' }
    | { status: 'error'; error: Error; retry: () => void }
    | { status: 'unavailable'; reason: 'full' }
    /** A React page with no entry file yet. */
    | { status: 'empty' }
    /** React source in a page set to plain HTML. */
    | { status: 'stranded' }
    | { status: 'build_error'; message: string }
    /**
     * `baseUrl` is set only around the public content document: its CSP says
     * `frame-ancestors 'self'`, so the wrapper must sit on the server's
     * origin to be allowed to frame it. The wrapper has no script, and the
     * frame stays sandboxed with an opaque origin either way.
     */
    | { status: 'ready'; html: string; published: boolean; baseUrl?: string };

function useDraft(pageId: string, source: PreviewSource, device: PreviewDevice): PreviewDocument | null {
    const query = useDraftDocument(pageId, source.kind === 'draft');
    if (source.kind !== 'draft') return null;
    if (query.isError) return { status: 'error', error: query.error, retry: () => void query.refetch() };
    const doc = query.data;
    if (!doc) return { status: 'loading' };
    if (doc.status === 'ready' && doc.html) {
        return { status: 'ready', html: frameDocument({ srcdoc: doc.html }, device), published: false };
    }
    if (doc.status === 'empty' || doc.status === 'stranded') return { status: doc.status };
    return { status: 'build_error', message: doc.buildError ?? '' };
}

export function usePreviewDocument(pageId: string, detail: WebpageDetail, device: PreviewDevice): PreviewDocument {
    const source = previewSource(detail.webpage);
    const draft = useDraft(pageId, source, device);
    if (draft) return draft;
    if (source.kind === 'unavailable') return { status: 'unavailable', reason: source.reason };
    if (source.kind === 'published') {
        const html = frameDocument({ src: apiUrl(source.path) }, device);
        const origin = serverOrigin();
        return { status: 'ready', html, published: true, ...(origin ? { baseUrl: `${origin}/` } : {}) };
    }
    return { status: 'loading' };
}

/**
 * The server's origin: the one address the preview may load pages from, and
 * the one the draft's bridges call (the server bakes the address the phone
 * reached it at).
 */
export function serverOrigin(): string | null {
    return originOf(getServerUrl());
}
