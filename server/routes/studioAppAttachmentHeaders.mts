/**
 * How a public App Studio page serves a stored attachment: raster images and
 * PDF inline, everything else (SVG included) as a download, and every type
 * but PDF under a sandbox policy so a file never runs as a page of this origin.
 */
const INLINE_IMAGE = /^image\/(png|jpe?g|gif|webp|avif|bmp)$/i;

export function attachmentResponseHeaders(mime: string): Record<string, string> {
    const type = String(mime || '').split(';')[0].trim().toLowerCase();
    const pdf = type === 'application/pdf';
    const headers: Record<string, string> = {
        'Content-Disposition': INLINE_IMAGE.test(type) || pdf ? 'inline' : 'attachment',
    };
    if (!pdf) headers['Content-Security-Policy'] = "default-src 'none'; sandbox";
    return headers;
}
