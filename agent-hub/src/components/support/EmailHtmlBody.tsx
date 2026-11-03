import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from '../../hooks/useTranslation';
import { logger } from '../../utils/logger';
import { sanitizeEmailHtml } from './emailHtmlSanitize';
import { collapseQuotedHistory, isQuoteToggle, type QuoteController } from './emailQuoteCollapse';

/**
 * Renders an untrusted email HTML body the way Gmail/Outlook would — inside a
 * sandboxed iframe so the email's own CSS is isolated from the app and any
 * embedded <script> can never run.
 *
 * Security: sandbox WITHOUT `allow-scripts`. `allow-same-origin` only lets the
 * PARENT measure the rendered height (the srcDoc iframe stays same-origin); it
 * does NOT enable scripting inside the email. Never add `allow-scripts` here —
 * `allow-scripts` + `allow-same-origin` together would let the email strip its
 * own sandbox. The body is cleaned first (emailHtmlSanitize.ts). Remote images
 * load (matches the real email); a click on an http(s) or mailto link is opened
 * by the app in a new tab with noopener, so the sandbox needs no popup escape.
 */

const WRAPPER_STYLE = `
  <style>
    :root { color-scheme: light; }
    html, body { margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
      font-size: 14px;
      line-height: 1.5;
      color: #1a1a1a;
      background: #ffffff;
      word-break: break-word;
      overflow-wrap: anywhere;
      padding: 12px;
    }
    img { max-width: 100%; height: auto; }
    table { max-width: 100%; }
    a { color: #2563eb; }
  </style>
`;

// Make links open in a new tab (never navigate the app frame) and cap oversized
// images so a wide email can't force a horizontal scrollbar.
// html/body are forced to their content height: a mail with `height:100%` or
// `min-height:100vh` would otherwise be as tall as the iframe viewport and could never shrink.
// flow-root makes the body enclose floated content (a two-column signature), which
// measureContentHeight would otherwise cut off.
export const HEAD_INJECT = '<base target="_blank"><style>img{max-width:100%;height:auto}'
    + 'html,body{height:auto !important;min-height:0 !important}body{display:flow-root}</style>';

/**
 * Height of the mail CONTENT: the body's box plus its vertical margins. Never
 * documentElement.scrollHeight, which is at least the iframe's current height
 * and so can only grow.
 */
export function measureContentHeight(doc: Document): number {
    const body = doc.body;
    if (!body) return 0;
    let margins = 0;
    const style = doc.defaultView?.getComputedStyle(body);
    if (style) margins = (parseFloat(style.marginTop) || 0) + (parseFloat(style.marginBottom) || 0);
    return Math.ceil(body.getBoundingClientRect().height + margins);
}

/**
 * Build the iframe document. Many senders (receipts, calendar invites,
 * newsletters) already ship a COMPLETE HTML document — `<!doctype><html>
 * <head><style>…</style></head><body style="…">…`. Those must be rendered
 * as-is: wrapping them inside another document double-nests <html>/<body>,
 * which merges the email's body styles onto our wrapper and corrupts the
 * layout (stray padding, runaway height). For a full document we only inject
 * <base> + the image cap into its existing <head>; bare fragments get wrapped
 * in our minimal readable shell.
 */
function buildSrcDoc(html?: string | null, inlineImages?: Record<string, string>): string {
    const raw = sanitizeEmailHtml(resolveCidImages(html || '', inlineImages));
    if (/<html[\s>]/i.test(raw)) {
        if (/<head[\s>]/i.test(raw)) {
            return raw.replace(/<head([^>]*)>/i, `<head$1>${HEAD_INJECT}`);
        }
        return raw.replace(/<html([^>]*)>/i, `<html$1><head>${HEAD_INJECT}</head>`);
    }
    return `<!DOCTYPE html><html><head><meta charset="utf-8">${HEAD_INJECT}${WRAPPER_STYLE}</head><body>${raw}</body></html>`;
}

/** A content id as the mail writes it (`cid:<abc@x>`, maybe percent-encoded) and as the attachment row stores it. */
export function normalizeContentId(id: string): string {
    let v = id.trim();
    try { v = decodeURIComponent(v); } catch (err) { logger.debug('content id is not percent-encoded', err); }
    return v.replace(/^<|>$/g, '').trim().toLowerCase();
}

/**
 * Only the app's own data may stand in for a cid: image — a blob: URL made from
 * app data, or a same-origin URL. Anything else (an external address) is never
 * put into the mail, so a resolver cannot turn a mail into a tracking pixel.
 */
function isOwnUrl(url: string): boolean {
    if (/^blob:/i.test(url)) return true;
    try { return new URL(url, window.location.href).origin === window.location.origin; } catch { return false; }
}

const CID_SRC = /(\bsrc\s*=\s*)(["'])\s*cid:([^"']*)\2/gi;

/** Swap `src="cid:…"` for the resolved URL, before the sanitizer runs. Unknown ids stay as they are. */
export function resolveCidImages(html: string, inlineImages?: Record<string, string>): string {
    if (!inlineImages || !html) return html;
    const byId = new Map<string, string>();
    for (const [id, url] of Object.entries(inlineImages)) {
        if (typeof url === 'string' && isOwnUrl(url)) byId.set(normalizeContentId(id), url);
    }
    if (byId.size === 0) return html;
    return html.replace(CID_SRC, (whole, pre: string, quote: string, id: string) => {
        const url = byId.get(normalizeContentId(id));
        return url ? `${pre}${quote}${url.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')}${quote}` : whole;
    });
}

const OPENABLE_LINK = /^(https?:|mailto:)/i;

/** Opens a clicked link from the e-mail in a new tab, outside the sandbox. */
function openLinkFromEmail(event: MouseEvent): void {
    const target = event.target as Element | null;
    const anchor = target?.closest?.('a[href]') as HTMLAnchorElement | null;
    if (!anchor) return;
    event.preventDefault();
    const href = anchor.href;
    if (OPENABLE_LINK.test(href)) window.open(href, '_blank', 'noopener,noreferrer');
}

interface EmailHtmlBodyProps {
    html?: string | null;
    /** Content id → URL of the app's own file, for `cid:` images in the body. */
    inlineImages?: Record<string, string>;
}

export default function EmailHtmlBody({ html, inlineImages }: EmailHtmlBodyProps) {
    const { t } = useTranslation();
    const iframeRef = useRef<HTMLIFrameElement>(null);
    const observerRef = useRef<ResizeObserver | null>(null);
    const quoteRef = useRef<QuoteController | null>(null);
    const [height, setHeight] = useState<number>(120);

    const measure = useCallback(() => {
        const iframe = iframeRef.current;
        if (!iframe) return;
        try {
            const doc = iframe.contentDocument;
            if (!doc) return;
            const h = measureContentHeight(doc);
            if (h) setHeight(h + 4);
        } catch (err) { logger.debug('cross-origin guard — shouldn\'t trip with allow-same-origin', err); }
    }, []);

    const handleLoad = useCallback(() => {
        // Remote images change layout height after the initial load event, so
        // keep re-measuring while the email's body resizes.
        try {
            const doc = iframeRef.current?.contentDocument;
            doc?.addEventListener('click', openLinkFromEmail);
            doc?.addEventListener('click', (event) => {
                if (!isQuoteToggle(event.target)) return;
                quoteRef.current?.toggle();
                measure();
            });
            quoteRef.current = doc
                ? collapseQuotedHistory(doc, {
                    show: t('support.email_quote_show', 'Show earlier messages'),
                    hide: t('support.email_quote_hide', 'Hide earlier messages'),
                })
                : null;
            // Collapse first, then measure: the frame must never see the full height.
            measure();
            if (doc?.body && typeof ResizeObserver !== 'undefined') {
                observerRef.current?.disconnect();
                const ro = new ResizeObserver(() => measure());
                ro.observe(doc.body);
                observerRef.current = ro;
            }
        } catch (err) { logger.debug('ignore', err); }
    }, [measure, t]);

    useEffect(() => () => observerRef.current?.disconnect(), []);

    const srcDoc = useMemo(() => buildSrcDoc(html, inlineImages), [html, inlineImages]);

    return (
        <iframe
            ref={iframeRef}
            title={t('support.email_html_body_email_message', 'Email message')}
            srcDoc={srcDoc}
            sandbox="allow-same-origin allow-popups"
            onLoad={handleLoad}
            className="w-full block"
            style={{ height, border: 'none', background: '#fff' }}
        />
    );
}
