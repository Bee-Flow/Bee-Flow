// cms/<key> → /api/cms/asset/<key> resolver. Lives in its own module so
// section components (and FramedMedia) can import it without creating a
// cycle through ProductWebsite.jsx, which imports every section.
export function resolveAssetUrl(urlOrKey: string | null | undefined): string {
    if (!urlOrKey) return '';
    if (urlOrKey.startsWith('http://') || urlOrKey.startsWith('https://') || urlOrKey.startsWith('/')) return urlOrKey;
    if (urlOrKey.startsWith('cms/')) {
        return `/api/cms/asset/${urlOrKey.split('/').map(encodeURIComponent).join('/')}`;
    }
    return urlOrKey;
}

// Widths the server renders as AVIF/WebP variants (server/core/cms/assetVariants.js).
const VARIANT_WIDTHS = [320, 640, 960, 1280, 1920] as const;
const NO_VARIANT_EXT = /\.(svg|gif|apng|mp4|webm|vtt)(\?|$)/i;

/** `sizes` for a content image: full width on a phone, capped at the page width. */
export const ASSET_IMG_SIZES = '(min-width: 1200px) 1200px, 100vw';

/**
 * `srcset` of resized WebP variants for an uploaded CMS image, or undefined
 * for anything else (external URLs, SVG, animated or video files), which keep
 * the plain `src`. Smaller variants stop a phone downloading the original.
 */
export function assetSrcSet(url: string): string | undefined {
    if (!url.startsWith('/api/cms/asset/') || url.includes('?') || NO_VARIANT_EXT.test(url)) return undefined;
    return VARIANT_WIDTHS.map((w) => `${url}?w=${w} ${w}w`).join(', ');
}

/**
 * `sizes` for an image in a grid of equal columns: one column on a phone,
 * (content width - gutters) / columns from a tablet up. Keeps a card image
 * from requesting the file meant for a full-width one. The server-rendered
 * page uses the same formula (server/core/cms/imageDelivery.js).
 */
export function columnSizes(columns: number): string {
    if (!Number.isInteger(columns) || columns < 2) return ASSET_IMG_SIZES;
    return `(min-width: 1024px) calc((min(100vw, 1200px) - 96px) / ${columns}), 100vw`;
}
