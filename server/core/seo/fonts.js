/**
 * Font tags for the server-rendered <head>.
 *
 * The client applies the design's fonts in a post-mount effect
 * (ProductWebsite.jsx applyDesignToRoot), which meant the h1 first painted in
 * the system stack and re-melted into Fraunces once React got around to it —
 * a layout shift on the largest text on the page, on every load. The server
 * knows the design before the first byte leaves, so it can do two things the
 * client never could:
 *
 *   1. preload the WOFF2s, so the bytes race the CSS instead of queueing
 *      behind the whole JS bundle;
 *   2. set --font-heading/--font-body/--font-mono in an inline <style>, so
 *      the very first paint — the pre-hydration server markup included —
 *      already uses the final stacks and React's later setProperty writes the
 *      same value onto the same element, a visual no-op.
 *
 * The stack strings deliberately mirror cssFontStack/cssMonoStack in
 * agent-hub/src/marketing/ProductWebsite.jsx, including the quoting rule
 * (quote only names containing whitespace) and the metric-matched fallback
 * faces from self-hosted-fonts.css. They are not imported — different
 * package, browser ESM — and byte-equality is not load-bearing: if they ever
 * drift, React overwrites the var with its own string and the only cost is
 * that the pre-React paint used the server's stack. Both resolve to the same
 * rendered font either way.
 *
 * Only families in SELF_HOSTED get a preload: they are the ones the live
 * design uses and the only ones whose file paths the server knows. A design
 * that names some other family falls back to the client-side runtime loader
 * exactly as before.
 */

const { esc } = require('./html');

const SELF_HOSTED = {
    fraunces: { file: '/fonts/fraunces/Fraunces-Variable.woff2', fallbackFace: 'Fraunces Fallback' },
    inter: { file: '/fonts/inter/Inter-Variable.woff2', fallbackFace: 'Inter Fallback' },
    // The 400 weight is what body-adjacent mono (eyebrows, stats) renders in;
    // the heavier cuts load lazily via the @font-face rules.
    'ibm plex mono': { file: '/fonts/ibm-plex-mono/IBMPlexMono-400.woff2', fallbackFace: 'IBM Plex Mono Fallback' },
};

function entryFor(name) {
    return SELF_HOSTED[String(name || '').trim().toLowerCase()] || null;
}

// A CSS family name needs letters, digits, spaces, hyphens and underscores,
// and nothing else. Anything else is DROPPED rather than escaped, because the
// <style> element below is raw text: entities are not decoded inside it, so
// escaping would only turn a payload into visible junk — while a literal
// `</style>` in a family name would end the element and everything after it
// would be parsed as markup. The names come from the CMS design blob, which
// an admin edits and a site import writes, so "the author typed it" is not a
// reason to trust the bytes (see the doctrine in ./html.js).
const FAMILY_RE = /^[A-Za-z0-9][A-Za-z0-9 _-]{0,48}$/;

function family(name) {
    const trimmed = String(name || '').trim();
    return FAMILY_RE.test(trimmed) ? trimmed : '';
}

function quoted(name) {
    const safe = String(name || '').replace(/"/g, '');
    return /\s/.test(safe) ? `"${safe}"` : safe;
}

function stack(name, generic) {
    const entry = entryFor(name);
    const fb = entry ? `, "${entry.fallbackFace}"` : '';
    return `${quoted(name)}${fb}, ${generic}`;
}

const SANS_TAIL = '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
const MONO_TAIL = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';

/**
 * @param {object} fonts   design.fonts — `{ heading, body, mono }`
 * @returns {string} preload links + an inline style block, or '' when the
 *   design names no fonts at all.
 */
function buildFontsHead(fonts = {}) {
    const src = fonts || {};
    const heading = family(src.heading);
    const body = family(src.body);
    const mono = family(src.mono);
    if (!heading && !body && !mono) return '';

    const out = [];

    // Preload the HEADING family only. It is the one that carries the LCP
    // element (the hero h1) and the one whose late arrival would re-melt the
    // largest text on the page.
    //
    // The body family is deliberately not preloaded any more. Both families
    // ship a metric-matched fallback in marketing/self-hosted-fonts.css
    // ('Inter Fallback' → Arial with size-adjust: 107.12% and ascent/descent
    // overrides), which fonts.js splices into the stack below, so body text
    // paints at the correct metrics immediately and the swap is size-neutral —
    // it cannot shift layout and cannot become an LCP candidate. What the
    // preload did do was claim ~48 KB of High-priority bandwidth on a
    // 1.6 Mbit/s link, competing with the render-blocking stylesheet during
    // exactly the window that decides FCP.
    //
    // `crossorigin` is required even same-origin: font fetches are CORS-mode,
    // and a preload whose mode differs from the real request is simply
    // ignored (and double-downloaded).
    const seen = new Set();
    for (const name of [heading]) {
        const entry = entryFor(name);
        if (!entry || seen.has(entry.file)) continue;
        seen.add(entry.file);
        out.push(`<link rel="preload" as="font" type="font/woff2" href="${esc(entry.file)}" crossorigin>`);
    }

    const vars = [];
    if (heading) vars.push(`--font-heading: ${stack(heading, SANS_TAIL)};`);
    if (body) vars.push(`--font-body: ${stack(body, SANS_TAIL)};`);
    if (mono) vars.push(`--font-mono: ${stack(mono, MONO_TAIL)};`);
    if (vars.length) {
        out.push(`<style>.marketing-root { ${vars.join(' ')} }</style>`);
    }

    return out.join('\n    ');
}

module.exports = { buildFontsHead, SELF_HOSTED };
