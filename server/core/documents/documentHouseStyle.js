// @typecheck
/**
 * Document house style — the organisation's letterhead, as data.
 *
 * TWO CHANNELS, and keeping them apart is the whole design:
 *
 *   STYLING  → CSS custom properties the composer injects on `:root` before the
 *              document's own stylesheet. The model never has to remember the
 *              brand colour; it writes `var(--doc-accent)` and the org decides
 *              what that is. Changing the house style restyles every document
 *              that did not opt out, including ones written months ago.
 *
 *   FACTS    → company name, address, IBAN, KvK. These are CONTENT, not
 *              styling, so they are handed to the model when it creates a
 *              document and it writes them into the markup. That is deliberate:
 *              once they are in the body the user can correct them by hand for
 *              this one invoice, which is exactly what you want when a customer
 *              needs a different reference on the payment line. Injecting them
 *              as an uneditable header would take that away.
 *
 * OPT-OUT IS PER DOCUMENT, not per org. `settings.houseStyle === false` on a
 * document skips the CSS injection entirely — the document is then whatever its
 * own stylesheet says, which is what you want for a one-off in somebody else's
 * branding. It is a boolean the user flips in the editor, never something the
 * model decides.
 *
 * WHY THE LOGO IS A data: URL. documentCompose strips every remote url() and
 * every remote <img src> — the PDF renders in a real Chromium on the server,
 * where a fetch is an SSRF primitive and a privacy leak. So the logo has to
 * travel as bytes. It is capped hard (see MAX_LOGO_BYTES): a letterhead is a
 * small mark, and the cap is what stops this config row becoming a file store.
 *
 * Stored per org under `org_document_style_<orgId>` (configStore), so it dies
 * with the organisation — see stores/user/organizations.js orgConfigKeys.
 */

const configStore = require('../../stores/configStore');
const log = require('../../telemetry/log');

const CONFIG_KEY_PREFIX = 'org_document_style_';
const CACHE_TTL_MS = 30_000;

// A letterhead mark, not an image library. 256 KB is a generous PNG at print
// resolution and a very generous SVG; past that the base64 starts to dominate
// every composed document AND every PDF render.
const MAX_LOGO_BYTES = 256 * 1024;

// Raster formats a browser and Chromium both render, plus SVG. Deliberately no
// `image/*` catch-all: the value ends up inside a CSS url() in a page we render
// server-side, so the list is closed.
const LOGO_MIME = Object.freeze(['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml']);

/**
 * Font stacks offered to the org, by key.
 *
 * A closed list rather than a free-text field, for two reasons: the value is
 * interpolated into a stylesheet, and there is no network at render time, so a
 * name the machine does not have installed silently falls back to something
 * nobody chose. Every stack here ends in a generic family that always resolves.
 */
const FONT_STACKS = Object.freeze({
    sans: 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
    serif: 'ui-serif, Georgia, Cambria, "Times New Roman", Times, serif',
    mono: 'ui-monospace, "SFMono-Regular", Menlo, Consolas, "Liberation Mono", monospace',
});
const DEFAULT_FONT = 'sans';

const DEFAULT_STYLE = Object.freeze({
    enabled: false,          // nothing is injected until somebody fills this in
    accent: '#123a5e',
    ink: '#1a1d21',
    muted: '#6b7280',
    font: DEFAULT_FONT,
    logoDataUrl: '',
    logoWidthMm: 24,
    companyName: '',
    companyTagline: '',
    companyAddress: '',
    companyEmail: '',
    companyPhone: '',
    companyWebsite: '',
    companyVat: '',          // BTW-nummer
    companyChamber: '',      // KvK
    companyIban: '',
    footerText: '',
    // How presentations look — see deckThemeOptions.js. Kept here so the
    // letterhead and the deck style are one setting with one owner.
    deck: require('./deckThemeOptions').DEFAULT_DECK_STYLE,
});

/** `#abc` or `#aabbcc`, or '' — never a raw string into a stylesheet. */
function sanitizeHex(value, fallback) {
    const t = String(value ?? '').trim();
    return /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(t) ? t : fallback;
}

function sanitizeText(value, max = 200) {
    // Strip control characters and cap. These are rendered as TEXT by the
    // client and handed to the model as facts; markup in them is either a
    // mistake or an attempt.
    return String(value ?? '')
        .replace(/[\u0000-]/g, ' ')
        .trim()
        .slice(0, max);
}

/**
 * Accept a logo only as a data: URL of a known image type, under the cap.
 *
 * Returns '' for anything else — including an http(s) URL, which would be
 * stripped by the composer anyway and is better refused at the door than
 * silently dropped three layers later.
 */
function sanitizeLogo(value) {
    const raw = String(value ?? '').trim();
    if (!raw) return '';
    const m = /^data:([a-z+/-]+);base64,([A-Za-z0-9+/=\s]+)$/i.exec(raw);
    if (!m) return '';
    const mime = m[1].toLowerCase();
    if (!LOGO_MIME.includes(mime)) return '';
    const b64 = m[2].replace(/\s+/g, '');
    // Decoded size, not the base64 length — the cap is about the image.
    const bytes = Math.floor(b64.length * 3 / 4);
    if (bytes > MAX_LOGO_BYTES) {
        throw Object.assign(
            new Error(`The logo is ${Math.round(bytes / 1024)} KB; the limit is ${MAX_LOGO_BYTES / 1024} KB.`),
            { errorClass: 'logo_too_large', status: 413 },
        );
    }
    return `data:${mime};base64,${b64}`;
}

/** Coerce anything into a valid, fully-populated style object. */
function normaliseStyle(input = {}) {
    const s = /** @type {Record<string, any>} */ (input && typeof input === 'object' ? input : {}); // untrusted input, any shape
    return {
        enabled: s.enabled !== false && s.enabled !== undefined ? !!s.enabled : DEFAULT_STYLE.enabled,
        accent: sanitizeHex(s.accent, DEFAULT_STYLE.accent),
        ink: sanitizeHex(s.ink, DEFAULT_STYLE.ink),
        muted: sanitizeHex(s.muted, DEFAULT_STYLE.muted),
        font: Object.prototype.hasOwnProperty.call(FONT_STACKS, s.font) ? s.font : DEFAULT_FONT,
        logoDataUrl: sanitizeLogo(s.logoDataUrl),
        logoWidthMm: Math.min(Math.max(Number(s.logoWidthMm) || DEFAULT_STYLE.logoWidthMm, 6), 80),
        companyName: sanitizeText(s.companyName),
        companyTagline: sanitizeText(s.companyTagline),
        companyAddress: sanitizeText(s.companyAddress, 400),
        companyEmail: sanitizeText(s.companyEmail, 200),
        companyPhone: sanitizeText(s.companyPhone, 60),
        companyWebsite: sanitizeText(s.companyWebsite, 200),
        companyVat: sanitizeText(s.companyVat, 60),
        companyChamber: sanitizeText(s.companyChamber, 60),
        companyIban: sanitizeText(s.companyIban, 60),
        footerText: sanitizeText(s.footerText, 400),
        deck: require('./deckThemeOptions').normaliseDeckStyle(s.deck),
    };
}

// ── Read / write ─────────────────────────────────────────────────────

const _cache = new Map(); // orgId → { at, style }

async function getHouseStyle(orgId) {
    if (!orgId) return { ...DEFAULT_STYLE };
    const hit = _cache.get(orgId);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.style;
    let stored = null;
    try {
        stored = await configStore.getConfig(`${CONFIG_KEY_PREFIX}${orgId}`);
    } catch (e) {
        // A config read failure must not take the document down with it: an
        // unstyled invoice is a working invoice.
        log.warn('[DocumentHouseStyle] read failed, using defaults:', e.message);
        return { ...DEFAULT_STYLE };
    }
    let style;
    try {
        style = normaliseStyle(typeof stored === 'string' ? JSON.parse(stored) : stored);
    } catch {
        style = { ...DEFAULT_STYLE };
    }
    _cache.set(orgId, { at: Date.now(), style });
    return style;
}

async function setHouseStyle(orgId, input) {
    if (!orgId) {
        throw Object.assign(new Error('A house style belongs to an organisation.'), { status: 400 });
    }
    const style = normaliseStyle(input);
    await configStore.setConfig(`${CONFIG_KEY_PREFIX}${orgId}`, JSON.stringify(style));
    _cache.set(orgId, { at: Date.now(), style });
    return style;
}

function invalidate(orgId) {
    if (orgId === undefined) _cache.clear();
    else _cache.delete(orgId);
}

// ── Rendering ────────────────────────────────────────────────────────

/**
 * The CSS the composer injects, or '' when there is nothing to inject.
 *
 * Emitted BEFORE the document's own stylesheet so every value here is a
 * DEFAULT the document can override — a one-off in a customer's colours just
 * redeclares `--doc-accent`, and an invoice that wants no logo simply never
 * uses `.doc-logo`.
 *
 * Only custom properties and one utility class. The temptation is to style
 * `h1`, `table`, `.totals` here so every document looks identical without the
 * model doing anything; that is wrong, because it would fight the document's
 * own CSS in a cascade the author cannot see, and "why is my heading blue"
 * would have no visible cause anywhere in the document.
 */
function houseStyleCss(style) {
    if (!style || !style.enabled) return '';
    const parts = [
        `--doc-accent: ${style.accent};`,
        `--doc-ink: ${style.ink};`,
        `--doc-muted: ${style.muted};`,
        `--doc-font: ${FONT_STACKS[style.font] || FONT_STACKS[DEFAULT_FONT]};`,
        `--doc-logo-width: ${style.logoWidthMm}mm;`,
    ];
    if (style.logoDataUrl) parts.push(`--doc-logo: url("${style.logoDataUrl}");`);

    // The logo rule degrades to nothing when no logo is set, rather than
    // painting an empty box: `background-image: var(--doc-logo)` with the
    // variable undefined is an invalid declaration, which CSS drops.
    // Variables only, plus the logo rule. `body` is NOT restated here: the base
    // stylesheet already reads --doc-font and --doc-ink, so overriding the
    // variables is enough, and one fewer rule is one fewer thing to fight the
    // document's own sheet in a cascade its author cannot see.
    return `:root {\n  ${parts.join('\n  ')}\n}\n`
        + `.doc-logo {\n  display: block;\n  width: var(--doc-logo-width);\n  aspect-ratio: 1 / 1;\n`
        + `  background-image: var(--doc-logo);\n  background-size: contain;\n`
        + `  background-repeat: no-repeat;\n  background-position: left center;\n}\n`;
}

/**
 * The facts the model is given when it creates a document. Only the filled-in
 * ones: an empty string in a prompt is noise the model may well write into the
 * invoice as an empty line.
 */
function houseStyleFacts(style) {
    if (!style || !style.enabled) return null;
    const facts = {};
    for (const key of ['companyName', 'companyTagline', 'companyAddress', 'companyEmail',
        'companyPhone', 'companyWebsite', 'companyVat', 'companyChamber', 'companyIban', 'footerText']) {
        if (style[key]) facts[key] = style[key];
    }
    facts.hasLogo = !!style.logoDataUrl;
    facts.accent = style.accent;
    return Object.keys(facts).length > 2 || facts.hasLogo ? facts : null;
}

// ── Decks ────────────────────────────────────────────────────────────
//
// A presentation has its own look vocabulary (core/documents/deckThemeOptions
// .js): a preset family, its own colours and typefaces, a cover and a table
// style, where the logo sits. Stored under `deck` in this same config row so
// it lives and dies with the letterhead, and RESOLVED here into the complete
// theme both renderers read. Text colours are derived for contrast — a house
// style whose ink is near-white (a letterhead designed against a dark panel)
// must never produce a white-on-white table.

const deckOptions = require('./deckThemeOptions');

const DECK_FONT_FACES = Object.freeze({ sans: 'Calibri', serif: 'Cambria', mono: 'Consolas' });

/** The neutral deck theme — an org without a house style, or `houseStyle:false`. */
const DEFAULT_DECK_THEME = Object.freeze(deckOptions.resolveDeckTheme(null));

/**
 * The resolved deck theme a house style yields; the neutral default when the
 * style is off. `overrides` are per-call look choices (already normalised or
 * raw — normalised here either way).
 */
function houseStyleDeckTheme(style, overrides = null) {
    const ov = deckOptions.normaliseDeckOverrides(overrides);
    if (!style || !style.enabled) return deckOptions.resolveDeckTheme(null, null, ov);
    const s = normaliseStyle(style);
    return deckOptions.resolveDeckTheme(s, s.deck, ov);
}

/**
 * The theme for an org's decks. `houseStyle:false` is the per-call opt-out —
 * the same switch a document has in `settings.houseStyle`, and like there it
 * is the USER's choice, never the model's. `overrides` still apply on top of
 * the neutral theme, so "unbranded but in blue" is expressible.
 */
async function deckThemeFor(orgId, { houseStyle = true, overrides = null } = {}) {
    if (houseStyle === false) return houseStyleDeckTheme(null, overrides);
    return houseStyleDeckTheme(await getHouseStyle(orgId), overrides);
}

module.exports = {
    CONFIG_KEY_PREFIX,
    DEFAULT_STYLE,
    DEFAULT_DECK_THEME,
    DECK_FONT_FACES,
    FONT_STACKS,
    MAX_LOGO_BYTES,
    LOGO_MIME,
    getHouseStyle,
    setHouseStyle,
    invalidate,
    houseStyleCss,
    houseStyleFacts,
    houseStyleDeckTheme,
    deckThemeFor,
    deckOptionCatalog: deckOptions.deckOptionCatalog,
    normaliseStyle,
    _test: { sanitizeHex, sanitizeText, sanitizeLogo },
};
