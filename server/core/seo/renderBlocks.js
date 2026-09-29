/**
 * CMS blocks → semantic HTML, for the server-rendered response.
 *
 * This is NOT a second renderer. It does not reproduce the design and it never
 * will — React replaces this markup the moment it mounts. Its job is narrower
 * and it should stay narrow: give a crawler (and a reader on a slow
 * connection) the page's real headings, prose and links, in order.
 *
 * DELIBERATELY GENERIC. It walks the content tree and emits based on a small
 * vocabulary of key names rather than switching on `block.type`. Two reasons:
 * a per-type switch would need editing every time a block is added — the
 * `roadmap` block would already have been missed — and blocks nest
 * inconsistently (`items`, `columns[].elements`, `categories[].items`), so a
 * recursive walk is simpler than nineteen special cases.
 *
 * Consequence worth knowing: a new content field is picked up automatically if
 * it is named like prose (`title`, `body`, `lead`), and ignored if it is not.
 * Ignored is the safe default — a structural value leaking into the page as a
 * stray paragraph is worse than it being absent.
 */

const { esc } = require('./html');

// Keys whose string value is prose, and what to render it as.
const HEADING_KEYS = new Set(['title', 'heading', 'question']);
const SUBHEAD_KEYS = new Set(['subheading', 'sublabel']);
const LEAD_KEYS = new Set(['lead', 'blurb', 'intro', 'description']);
const BODY_KEYS = new Set(['body', 'answer', 'text', 'note', 'quote', 'example', 'disclaimer', 'footnote']);
const EYEBROW_KEYS = new Set(['eyebrow']);
const LABEL_KEYS = new Set(['label', 'name']);

// Arrays worth recursing into. Anything else is structural.
const CHILD_KEYS = new Set([
    'items', 'columns', 'elements', 'categories', 'links', 'cards',
    'steps', 'features', 'plans', 'entries', 'rows', 'logos', 'tiers',
]);

// Never emitted, whatever they contain.
const SKIP_KEYS = new Set([
    'id', 'kind', 'type', 'slug', 'src', 'srcDark', 'href', 'url', 'link',
    'anchor', 'path', 'pageId', 'page', 'target', 'rel', 'icon', 'platform',
    'code', 'codeRight', 'popupEmbed', 'embed', 'iframe', 'style', 'variant',
    'layout', 'background', 'backgroundVariant', 'theme', 'media', 'frame',
    'seo', 'enabled', 'status', 'span', 'height', 'feature', 'logoSrc',
]);

const isProse = (v) => typeof v === 'string' && v.trim() !== '';

/** hero.titleParts is `[{ text, gradient }]` — the headline in fragments. */
function titleFromParts(parts) {
    if (!Array.isArray(parts)) return '';
    return parts.map(p => (p && typeof p.text === 'string') ? p.text : '').join(' ').trim();
}

// The prose vocabulary, for the CTA test below: an object whose only prose is
// its `label` is a button, not a card that happens to carry a link.
const PROSE_KEY_SETS = [HEADING_KEYS, SUBHEAD_KEYS, LEAD_KEYS, BODY_KEYS, EYEBROW_KEYS];

/**
 * A resolved CTA object — `{ label, link: { href } }` after cmsStore's
 * resolveLinksInTree, or a bare `{ label, href }`. Returns the href when the
 * object is a pure CTA pointing at an own-origin path, else null. External
 * URLs, protocol-relative URLs and `#` anchors stay client-side: this
 * renderer's links exist for the crawler of THIS site.
 */
function internalCtaHref(node) {
    if (!isProse(node.label) || node.enabled === false) return null;
    const link = (node.link && typeof node.link === 'object') ? node.link : null;
    const href = (link && typeof link.href === 'string') ? link.href
        : (typeof node.href === 'string' ? node.href : '');
    if (!href.startsWith('/') || href.startsWith('//')) return null;
    const hasOtherProse = Object.entries(node).some(([k, v]) =>
        k !== 'label' && isProse(v) && PROSE_KEY_SETS.some(set => set.has(k)));
    return hasOtherProse ? null : href;
}

/**
 * A comparison table announces itself by shape (`leftLabel`/`rightLabel`
 * column heads plus `rows`), not by block type — same rule as the rest of
 * this file. Cells are emitted as a real <table> because "which side does
 * what" is exactly the content a crawler should get in order.
 */
function isCompareTable(node) {
    return Array.isArray(node.rows)
        && (isProse(node.leftLabel) || isProse(node.rightLabel));
}

function emitCompareTable(node, out) {
    const rows = node.rows.filter(r => r && typeof r === 'object'
        && (isProse(r.aspect) || isProse(r.left) || isProse(r.right)));
    if (!rows.length) return;
    const cells = [
        `<tr><th></th><th>${esc(node.leftLabel || '')}</th><th>${esc(node.rightLabel || '')}</th></tr>`,
        ...rows.map(r =>
            `<tr><th>${esc(r.aspect || '')}</th><td>${esc(r.left || '')}</td><td>${esc(r.right || '')}</td></tr>`),
    ];
    out.push(`<table>\n${cells.join('\n')}\n</table>`);
}

function walk(node, out, depth, state) {
    if (!node || typeof node !== 'object') return;

    if (Array.isArray(node)) {
        for (const child of node) walk(child, out, depth, state);
        return;
    }

    // Pure CTAs become real anchors — before this, the server-rendered page
    // contained no <a> at all, so internal link structure only existed after
    // hydration. Mixed objects (a card with a title and a link) fall through
    // to the normal walk and keep their current rendering.
    const ctaHref = internalCtaHref(node);
    if (ctaHref !== null) {
        out.push(`<a href="${esc(ctaHref)}">${esc(node.label)}</a>`);
        return; // a button carries no other content worth walking
    }

    // Headline fragments first so the h1 is the real headline, not a later key.
    const parts = titleFromParts(node.titleParts);
    if (parts) emitHeading(parts, out, depth, state);

    const compareTable = isCompareTable(node);

    for (const [key, value] of Object.entries(node)) {
        if (SKIP_KEYS.has(key)) continue;
        if (compareTable && key === 'rows') continue; // emitted as a <table> below

        if (isProse(value)) {
            if (EYEBROW_KEYS.has(key)) out.push(`<p class="label">${esc(value)}</p>`);
            else if (HEADING_KEYS.has(key)) emitHeading(value, out, depth, state);
            else if (SUBHEAD_KEYS.has(key)) out.push(`<p>${esc(value)}</p>`);
            else if (LEAD_KEYS.has(key)) out.push(`<p>${esc(value)}</p>`);
            else if (BODY_KEYS.has(key)) out.push(`<p>${esc(value)}</p>`);
            else if (LABEL_KEYS.has(key)) out.push(`<p>${esc(value)}</p>`);
            continue;
        }

        if (Array.isArray(value) && CHILD_KEYS.has(key)) {
            walk(value, out, depth + 1, state);
            continue;
        }
        // A nested object that is not in CHILD_KEYS is usually a config blob
        // (cta, badge, mockup). Recurse one level so a CTA label survives.
        if (value && typeof value === 'object' && !Array.isArray(value) && depth < 4) {
            walk(value, out, depth + 1, state);
        }
    }

    if (compareTable) emitCompareTable(node, out);
}

function emitHeading(text, out, depth, state) {
    // Exactly one h1 per document. The first heading encountered wins, which
    // is the hero's — two h1s is a real (if mild) SEO defect and an
    // accessibility one, so the rule is enforced here rather than trusted.
    if (!state.h1Used) {
        state.h1Used = true;
        out.push(`<h1>${esc(text)}</h1>`);
        return;
    }
    const level = Math.min(2 + Math.max(0, depth - 1), 4);
    out.push(`<h${level}>${esc(text)}</h${level}>`);
}

/**
 * @param {object[]} blocks   page.blocks, already locale-resolved
 * @param {object} opts
 * @param {string} opts.fallbackTitle used as the h1 when no block supplies one
 * @returns {string} HTML for the inside of #root
 */
function renderBlocks(blocks, { fallbackTitle = '' } = {}) {
    const out = [];
    const state = { h1Used: false };

    for (const block of blocks || []) {
        if (!block || block.enabled === false) continue;
        const before = out.length;
        walk(block.content || {}, out, 1, state);
        if (out.length > before) {
            out.splice(before, 0, `<section data-block="${esc(block.type || '')}">`);
            out.push('</section>');
        }
    }

    if (!state.h1Used && fallbackTitle) out.unshift(`<h1>${esc(fallbackTitle)}</h1>`);
    if (!out.length) return '';
    // `.marketing-root` pulls in the design tokens and typography, `.container`
    // the same max-width and gutters every real section uses. Without them this
    // rendered as a full-bleed stack of headings, which read as "the CSS failed
    // to load" for the moment before React mounted. See PREHYDRATE_CSS.
    return `<div class="marketing-root cms-prehydrate">\n<div class="container">\n${out.join('\n')}\n</div>\n</div>`;
}

/**
 * Layout for the pre-hydration view, inlined into <head> so it costs no
 * request and applies on the very first paint.
 *
 * PAINTS IMMEDIATELY — the 450ms reveal delay this used to carry is gone,
 * and its removal is the FCP fix, not a simplification. The delay existed to
 * hide a plain-page flash while a ~2.1 MB entry chunk parsed; after the
 * bundle diet a marketing pageview is ~190 KB gzipped and React mounts over
 * this markup in a few hundred milliseconds. The delay's cost meanwhile had
 * become the page's mobile FCP: `both` held the text at opacity 0 through
 * the exact window when the main thread was FREE (before the JS arrived),
 * and by the time the delay expired the thread was busy parsing — Lighthouse
 * clocked first paint at 8.1s on throttled mobile for a page whose text had
 * been in the response since ~100ms. Server-rendered text must never wait
 * for anything.
 *
 * This is deliberately NOT `display:none`. The distinction matters: showing
 * the text to users the moment it exists is the entire point, and hiding it
 * while serving it to crawlers would be cloaking.
 */
/* The h1 uses the SAME design tokens as the hydrated hero (.headline-display,
   tokens.css) rather than its own clamp. It carried clamp(2rem, 5vw, 3rem),
   which resolves to 32px on a 412px phone, while the hydrated headline resolves
   to 44px — so React's mount painted a LARGER text node, which the browser
   scored as a new Largest Contentful Paint. LCP was therefore pinned to
   hydration time no matter how fast the server text arrived, and that is most
   of the gap between a 4.6s FCP and a 6.7s LCP. Referencing the tokens instead
   of copying the clamp keeps the two in step by construction; they are declared
   on .marketing-root, which the SSR root div below already carries, and they
   ship in the render-blocking stylesheet that first paint waits for anyway. */
const PREHYDRATE_CSS = `
.cms-prehydrate { padding: 96px 0 64px; }
.cms-prehydrate .container { max-width: 900px; }
.cms-prehydrate section { display: block; padding: 0 0 28px; }
.cms-prehydrate h1 { font-size: var(--text-display); line-height: var(--leading-display); letter-spacing: var(--tracking-display); margin: 0 0 16px; }
.cms-prehydrate h2 { font-size: 1.5rem; line-height: 1.25; margin: 32px 0 12px; }
.cms-prehydrate h3, .cms-prehydrate h4 { font-size: 1.1rem; margin: 20px 0 8px; }
.cms-prehydrate p { margin: 0 0 12px; max-width: 68ch; }
.cms-prehydrate .label { font-size: .78rem; letter-spacing: .12em; text-transform: uppercase; opacity: .7; margin: 0 0 8px; }
`.trim();

module.exports = { renderBlocks, PREHYDRATE_CSS };
