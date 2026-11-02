/**
 * Images in model and tool output do not load from other hosts by themselves.
 *
 * A Markdown image is a request the browser makes on its own, the moment the
 * message renders, to whatever host the text named. The text is written by a
 * model that has just read a web page, a mail or a document, so the host and
 * the query string are the model's to choose. Showing the image only after
 * the reader asks for it keeps the reader in charge of that request; the alt
 * text and the host stay visible so nothing is hidden.
 *
 * What loads straight away: a path on this origin (`/api/...` included), a
 * `data:image/...` URI (no request at all) and a `blob:` URL (made in this
 * tab). What waits for a click: everything else, a protocol-relative `//host`
 * included.
 */
import React, { useState } from 'react';
import type { Components } from 'react-markdown';
import { useTranslation } from '../../hooks/useTranslation';

const SCHEME = /^[a-z][a-z0-9+.-]*:/i;

/** Whether an image at `src` may be fetched without the reader asking. */
export function isTrustedImageSource(src: unknown): boolean {
    if (typeof src !== 'string') return false;
    const value = src.trim();
    if (value === '') return false;
    if (/^data:image\//i.test(value)) return true;
    if (/^blob:/i.test(value)) return true;
    if (value.startsWith('//')) return false;
    if (SCHEME.test(value)) {
        try {
            return new URL(value).origin === window.location.origin;
        } catch {
            return false;
        }
    }
    return true;
}

function hostOf(src: string): string {
    try {
        return new URL(src, window.location.href).host;
    } catch {
        return '';
    }
}

/** The placeholder for an image on another host, with the control that loads it. */
function DeferredImage({ src, alt }: { src: string; alt?: string }) {
    const { t } = useTranslation();
    const [shown, setShown] = useState(false);
    if (shown) return <img src={src} alt={alt ?? ''} />;
    const described = typeof alt === 'string' && alt.trim() ? alt.trim() : '';
    const host = hostOf(src);
    return (
        <span
            data-testid="remote-image-deferred"
            className="inline-flex items-center gap-1.5 max-w-full px-1.5 py-0.5 rounded border border-[var(--border-subtle)] text-[11.5px] text-[var(--text-tertiary)] break-all"
        >
            <span>
                {t('chat.renderers.image_not_loaded', 'Image not loaded')}
                {described ? `: ${described}` : ''}
                {host ? ` (${host})` : ''}
            </span>
            <button
                type="button"
                className="shrink-0 underline underline-offset-2 hover:text-[var(--text-primary)]"
                onClick={() => setShown(true)}
            >
                {t('chat.renderers.load_image', 'Load image')}
            </button>
        </span>
    );
}

/** The `img` renderer the shared Markdown renderer uses unless a view opts out. */
export const guardedImage: Components['img'] = ({ node: _node, src, alt, ...rest }) => {
    const source = typeof src === 'string' ? src : '';
    // An empty source (react-markdown drops the schemes it does not allow,
    // `data:` among them) fetches nothing; it renders as it always did.
    if (source === '' || isTrustedImageSource(source)) return <img src={source} alt={alt ?? ''} {...rest} />;
    return <DeferredImage src={source} alt={alt} />;
};

/**
 * An `<img>` for an image URL taken from model or tool output outside the
 * Markdown path (fenced page, research and test-report blocks): the same rule
 * as `guardedImage`, with the element's own attributes kept when it loads.
 */
export function SafeImage({ src, alt, ...rest }: React.ImgHTMLAttributes<HTMLImageElement>) {
    const source = typeof src === 'string' ? src : '';
    if (source === '' || isTrustedImageSource(source)) return <img src={source} alt={alt ?? ''} {...rest} />;
    return <DeferredImage src={source} alt={alt} />;
}
