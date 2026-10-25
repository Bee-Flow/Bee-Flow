// @typecheck noImplicitAny
/**
 * Pure input handling for the webpage builder tools: what webpage_set_metadata
 * accepts (and says it rejected), what webpage_file_read reports, and the size
 * cap on a file slot. No store, no I/O, so each rule is tested on its own.
 */

/** Largest file (characters) a builder tool writes into one slot. */
const MAX_SLOT_CHARS = 2_000_000;
const MAX_TAGLINE_CHARS = 80;

/**
 * @param {unknown} c
 * @returns {string} the trimmed hex colour, or '' when it is not #rgb / #rrggbb
 */
function sanitizeHex(c) {
    if (typeof c !== 'string') return '';
    const t = c.trim();
    return /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(t) ? t : '';
}

/**
 * The first grapheme of the text when it is an emoji, else ''. The model
 * sometimes sends "📊📊" or "📊 Dashboard"; plain text such as "n" is not an
 * icon and is rejected rather than kept as a one-letter tile.
 * @param {unknown} icon
 * @returns {string}
 */
function sanitizeIcon(icon) {
    if (typeof icon !== 'string') return '';
    const t = icon.trim();
    if (!t) return '';
    const first = [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(t)][0]?.segment || '';
    return /\p{Extended_Pictographic}|\p{Regional_Indicator}/u.test(first) ? first : '';
}

/**
 * Validate the metadata arguments. A field that was given but cannot be used is
 * named in `warnings` instead of being dropped without a word.
 * @param {{ icon?: unknown, accent_color?: unknown, tagline?: unknown }} args
 * @returns {{ updates: { icon?: string, accentColor?: string, tagline?: string }, warnings: string[] }}
 */
function sanitizeMetadata(args) {
    /** @type {{ icon?: string, accentColor?: string, tagline?: string }} */
    const updates = {};
    /** @type {string[]} */
    const warnings = [];
    const given = (/** @type {unknown} */ v) => v !== undefined && v !== null && v !== '';

    if (given(args.icon)) {
        const icon = sanitizeIcon(args.icon);
        if (icon) updates.icon = icon;
        else warnings.push('icon was not applied: it must be an emoji.');
    }
    if (given(args.accent_color)) {
        const accentColor = sanitizeHex(args.accent_color);
        if (accentColor) updates.accentColor = accentColor;
        else warnings.push('accent_color was not applied: use a hex colour like "#00a86b" or "#0a8".');
    }
    if (given(args.tagline)) {
        const tagline = typeof args.tagline === 'string' ? args.tagline.trim() : '';
        if (!tagline) {
            warnings.push('tagline was not applied: it must be non-empty text.');
        } else {
            updates.tagline = tagline.slice(0, MAX_TAGLINE_CHARS);
            if (tagline.length > MAX_TAGLINE_CHARS) {
                warnings.push(`tagline was shortened to ${MAX_TAGLINE_CHARS} characters.`);
            }
        }
    }
    return { updates, warnings };
}

/**
 * Number of lines in a file's text ('' has none).
 * @param {string} content
 */
function countLines(content) {
    return content ? content.split('\n').length : 0;
}

/**
 * The refusal for a slot above the cap, or null.
 * @param {unknown} content
 * @returns {{ error: string } | null}
 */
function slotTooLarge(content) {
    if (typeof content !== 'string' || content.length <= MAX_SLOT_CHARS) return null;
    return { error: `The file is too large (${content.length.toLocaleString('en-US')} characters, limit ${MAX_SLOT_CHARS.toLocaleString('en-US')}). Split it up: move CSS and JavaScript into their own files. Nothing was written.` };
}

module.exports = { MAX_SLOT_CHARS, sanitizeHex, sanitizeIcon, sanitizeMetadata, countLines, slotTooLarge };
