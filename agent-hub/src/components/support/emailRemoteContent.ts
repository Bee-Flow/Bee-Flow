/**
 * Remote content in an e-mail body (pictures, stylesheets, fonts on another
 * host). Loading any of it tells the sender who opened the mail, when, and
 * from where. Where a surface asks first (EmailHtmlBody `remoteImages="ask"`),
 * the framed document carries a Content-Security-Policy that loads only what
 * the mail holds itself (inline styles, data: and blob: pictures, the app's
 * own files) until the viewer chooses to show the images of that message.
 */

/** Nothing from another host. */
export const BLOCK_REMOTE_CSP = "default-src 'none'; img-src data: blob: 'self'; style-src 'unsafe-inline'; font-src data:; media-src data: blob: 'self'";

/** After the viewer said "show images": pictures, styles and fonts from the web; still no scripts, frames or connections. */
export const ALLOW_REMOTE_CSP = "default-src 'none'; img-src data: blob: 'self' https: http:; style-src 'unsafe-inline' https: http:; font-src data: https: http:; media-src data: blob: 'self' https: http:";

/** The policy as the first element of the framed document's head. */
export function cspMeta(policy: string): string {
    return `<meta http-equiv="Content-Security-Policy" content="${policy}">`;
}

const URL_ATTRS = ['src', 'srcset', 'background', 'poster'];

function isRemote(value: string): boolean {
    const v = value.trim().toLowerCase();
    return v.startsWith('http:') || v.startsWith('https:') || v.startsWith('//');
}

/** CSS text that loads something from another host: an @import or a url() to one. */
function cssLoadsRemote(css: string): boolean {
    const text = css.toLowerCase();
    if (text.includes('@import')) return true;
    let from = 0;
    for (;;) {
        const at = text.indexOf('url(', from);
        if (at === -1) return false;
        const arg = text.slice(at + 4).trimStart().replace(/^["']/, '');
        if (isRemote(arg)) return true;
        from = at + 4;
    }
}

/** True when the (cleaned) body would load anything from another host. */
export function hasRemoteContent(html: string): boolean {
    if (!html) return false;
    const doc = new DOMParser().parseFromString(html, 'text/html');
    if (doc.querySelector('link')) return true;
    for (const el of Array.from(doc.querySelectorAll('*'))) {
        for (const name of URL_ATTRS) {
            const value = el.getAttribute(name);
            if (value && value.split(',').some((part) => isRemote(part))) return true;
        }
        const style = el.getAttribute('style');
        if (style && cssLoadsRemote(style)) return true;
    }
    return Array.from(doc.querySelectorAll('style')).some((s) => cssLoadsRemote(s.textContent || ''));
}
