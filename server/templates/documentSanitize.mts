/**
 * The DOM-based sanitiser for document markup that ends up in the server's
 * Chromium: the Documents composer (services/documentCompose.js) and the
 * notebook / generated-document export (templates/exportTemplate.js) both use
 * it, so a construct refused in one is refused in the other.
 *
 * No script, no embedding, no forms, and no remote resource loads: every
 * remote src / href (a plain <a href> excepted), srcset, and CSS url() /
 * @import goes. data: URLs survive, so an embedded logo or image still works.
 */

import { createRequire } from 'node:module';

/**
 * The part of the DOMPurify instance this module uses. Declared here instead of
 * imported from 'dompurify', so type-checking a consumer of this file does not
 * need the server's node_modules (agent-hub's typecheck reaches it).
 */
interface DOMPurify {
    sanitize(dirty: string, config: Record<string, unknown>): unknown;
    addHook(entryPoint: 'afterSanitizeAttributes', hook: (node: Element) => void): void;
    removeHook(entryPoint: 'afterSanitizeAttributes'): unknown;
}

const nodeRequire = createRequire(import.meta.url);

let purifyInstance: DOMPurify | null = null;
function getPurify(): DOMPurify {
    if (purifyInstance) return purifyInstance;
    const createDOMPurify = nodeRequire('dompurify') as (window: unknown) => DOMPurify;
    const { JSDOM } = nodeRequire('jsdom') as { JSDOM: new (html: string) => { window: unknown } };
    purifyInstance = createDOMPurify(new JSDOM('').window);
    return purifyInstance;
}

/**
 * Tags that have no business in a printed document: anything that executes,
 * embeds, navigates or collects. `style` is
 * forbidden in the BODY too — the stylesheet has its own slot, and a <style>
 * smuggled into the markup is how you would reach the rules below.
 */
export const FORBID_TAGS: readonly string[] = Object.freeze([
    'script', 'iframe', 'frame', 'frameset', 'object', 'embed', 'applet',
    'form', 'input', 'button', 'textarea', 'select', 'option',
    'base', 'meta', 'link', 'style', 'noscript', 'template',
    'audio', 'video', 'source', 'track', 'canvas', 'portal',
]);

const FORBID_ATTR: readonly string[] = Object.freeze(['srcset', 'ping', 'formaction', 'background']);

/**
 * Sanitise the body markup.
 *
 * DOMPurify handles the hard parts (namespace confusion, mXSS, event handlers,
 * javascript: URLs) far better than a regex pass could. What it does NOT do is
 * take a position on remote resource loads — those are legal HTML — so the
 * hook below removes them afterwards.
 */
export function sanitizeDocumentBody(html: unknown): string {
    const raw = String(html ?? '');
    if (!raw.trim()) return '';
    const purify = getPurify();

    // Registered per call and removed again: DOMPurify hooks are global to the
    // instance, and this module shares its singleton with nothing, but leaving
    // a hook installed would still surprise the next caller.
    const stripRemote = (node: Element): void => {
        for (const attr of ['src', 'href', 'xlink:href', 'poster', 'data']) {
            if (!node.hasAttribute || !node.hasAttribute(attr)) continue;
            const value = String(node.getAttribute(attr) || '').trim();
            if (/^(https?:)?\/\//i.test(value)) {
                // An <a href> is inert on paper and harmless in the sandboxed
                // preview — it fetches nothing until somebody clicks. Anything
                // that the RENDERER would fetch on its own is what goes.
                if (node.tagName === 'A' && attr === 'href') continue;
                node.removeAttribute(attr);
            }
        }
        // Inline styles can fetch too.
        if (node.hasAttribute && node.hasAttribute('style')) {
            node.setAttribute('style', sanitizeCssText(node.getAttribute('style')));
        }
    };

    purify.addHook('afterSanitizeAttributes', stripRemote);
    try {
        return String(purify.sanitize(raw, {
            FORBID_TAGS: [...FORBID_TAGS],
            FORBID_ATTR: [...FORBID_ATTR],
            // The markup is a document fragment, not a whole page: keep it that
            // way so what we store stays round-trippable with body.innerHTML.
            WHOLE_DOCUMENT: false,
            ADD_TAGS: ['#comment'],
            ALLOW_DATA_ATTR: true,
        }));
    } finally {
        purify.removeHook('afterSanitizeAttributes');
    }
}

/**
 * Sanitise a stylesheet (or a style="" attribute value).
 *
 * DOMPurify does not parse CSS, so this is hand-rolled — but the surface is
 * small and each rule is here for a named reason:
 *
 *   </style      — the one true escape hatch. CSS is emitted inside a <style>
 *                  block, and the HTML parser ends that element at the literal
 *                  `</style`, so a stylesheet containing it could close its own
 *                  tag and open a <script>. Defanged the way the webpage
 *                  composer defangs `</script` in JS.
 *   @import      — a remote fetch that the sanitised markup can no longer make.
 *   url(http…)   — ditto, and the usual way a "font" turns into a beacon.
 *   expression() — legacy IE script-in-CSS.
 *   behavior:    /  -moz-binding: — the same idea, other vendors.
 */
export function sanitizeCssText(css: unknown): string {
    let s = String(css ?? '');
    if (!s) return '';
    s = s.replace(/<\/style/gi, '<\\/style');
    s = s.replace(/@import\b[^;]*;?/gi, '');
    s = s.replace(/@charset\b[^;]*;?/gi, '');
    // Keep data: URLs (embedded logos and fonts); drop everything else that
    // names a location. `url()` with no scheme is a relative path, which in a
    // srcdoc/`setContent` page resolves to nothing useful anyway.
    s = s.replace(/url\(\s*(['"]?)([^'")]*)\1\s*\)/gi, (match: string, _q: string, target: string) => (
        /^data:/i.test(String(target).trim()) ? match : 'none'
    ));
    s = s.replace(/expression\s*\(/gi, 'void(');
    s = s.replace(/behaviou?r\s*:/gi, '_disabled:');
    s = s.replace(/-moz-binding\s*:/gi, '_disabled:');
    return s;
}
