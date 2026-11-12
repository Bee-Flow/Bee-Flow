/**
 * Cleans an untrusted e-mail body before it goes into the sandboxed iframe:
 * no scripts, forms, frames, plug-ins, <base> or <meta http-equiv> (refresh),
 * no event-handler attributes, and no javascript:/vbscript:/data: URLs
 * (an inline data:image stays allowed on images). Uses the browser's own
 * parser into an inert document, so nothing loads while cleaning.
 */
const DROP_ELEMENTS = 'script,noscript,iframe,frame,frameset,object,embed,applet,base,meta[http-equiv],portal';
const UNWRAP_ELEMENTS = 'form';
const URL_ATTRIBUTES = ['href', 'src', 'action', 'formaction', 'xlink:href', 'background', 'poster', 'srcset', 'data', 'ping'];
const BLOCKED_SCHEME = /^(javascript|vbscript|data):/i;
const IMAGE_DATA = /^data:image\/(png|jpe?g|gif|webp|bmp);/i;

/** Whether the mail is a whole document: an `<html` tag followed by whitespace or `>`. */
function isWholeDocument(raw: string): boolean {
    const lower = raw.toLowerCase();
    for (let at = lower.indexOf('<html'); at !== -1; at = lower.indexOf('<html', at + 5)) {
        const next = lower.charAt(at + 5);
        if (next === '>' || next.trim() === '') return next !== '';
    }
    return false;
}

function cleanUrl(value: string): string {
    // Browsers ignore whitespace and control characters inside a scheme.
    return value.replace(/[\u0000- \u007f-\u009f]/g, '');
}

function cleanElement(el: Element): void {
    for (const attr of Array.from(el.attributes)) {
        const name = attr.name.toLowerCase();
        if (name.startsWith('on')) {
            el.removeAttribute(attr.name);
            continue;
        }
        if (!URL_ATTRIBUTES.includes(name)) continue;
        const value = cleanUrl(attr.value);
        if (!BLOCKED_SCHEME.test(value)) continue;
        const imageData = name === 'src' && el.tagName.toLowerCase() === 'img' && IMAGE_DATA.test(value);
        if (!imageData) el.removeAttribute(attr.name);
    }
}

/** `dropLinks`: also remove every <link> (a stylesheet, prefetch or preconnect to another host). */
export function sanitizeEmailHtml(raw: string, { dropLinks = false }: { dropLinks?: boolean } = {}): string {
    if (!raw) return '';
    const doc = new DOMParser().parseFromString(raw, 'text/html');
    doc.querySelectorAll(DROP_ELEMENTS).forEach(el => el.remove());
    if (dropLinks) doc.querySelectorAll('link').forEach(el => el.remove());
    doc.querySelectorAll(UNWRAP_ELEMENTS).forEach(el => el.replaceWith(...Array.from(el.childNodes)));
    doc.querySelectorAll('*').forEach(cleanElement);
    if (isWholeDocument(raw)) return `<!DOCTYPE html>${doc.documentElement.outerHTML}`;
    return doc.head.innerHTML + doc.body.innerHTML;
}
