// @typecheck
const SLIDE_LAYOUTS = Object.freeze(['title', 'section', 'bullets', 'two_column', 'cards', 'table', 'image', 'quote', 'chart', 'stats', 'timeline', 'closing']);

const MAX_CARDS = 6;

/** `{icon: wifi-off}` (or `[icon: …]`) anywhere in a heading names the card's icon. */
const RE_ICON_TAG = /\s*[[{]\s*icon\s*:\s*([a-z0-9 _-]+?)\s*[\]}]/i;

const DECK_LIMITS = Object.freeze({
    maxSlides: 60,
    maxBulletsPerSlide: 10,
    maxBulletChars: 240,
    maxTitleChars: 120,
    maxSubtitleChars: 200,
    maxBodyChars: 1200,
    maxNotesChars: 3000,
    maxQuoteChars: 400,
    maxTableRows: 15,
    maxTableCols: 8,
    maxCellChars: 120,
    maxImageBytes: 4 * 1024 * 1024,
    maxMarkdownChars: 200_000,
});

class DeckError extends Error {
    constructor(message, errorClass) {
        super(message);
        this.name = 'DeckError';
        this.errorClass = errorClass;
    }
}

/** Drop the inline markdown a slide would otherwise print literally. Links keep their text. */
function stripInlineMarkdown(text) {
    return String(text ?? '')
        .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
        .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
        .replace(/\*\*(.+?)\*\*/g, '$1')
        .replace(/__(.+?)__/g, '$1')
        .replace(/(?<![\w*])\*(?!\*)([^*\n]+?)\*(?![\w*])/g, '$1')
        .replace(/(?<!\w)_([^_\n]+?)_(?!\w)/g, '$1')
        .replace(/`([^`]+)`/g, '$1')
        .replace(/<\/?[a-z][^>]*>/gi, '')
        .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')
        .trim();
}

function clampText(value, max, warnings, what) {
    const s = stripInlineMarkdown(value);
    if (s.length <= max) return s;
    if (warnings) warnings.push(`${what} was shortened to ${max} characters`);
    return `${s.slice(0, max - 1).trimEnd()}…`;
}

/**
 * Classify an image reference. Only two kinds survive: inline bytes and a
 * Bee Flow storage object (as a key, or as the proxy URL the chat hands out).
 */
function classifyImageRef(src, alt = '') {
    const raw = String(src ?? '').trim(); // nosemgrep: ajinabraham.njsscan.dos.regex_dos.regex_dos -- anchored patterns over single character classes, no nested repeats: linear
    if (!raw) return null;
    if (/^data:image\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=\s]+$/i.test(raw)) {
        return { dataUrl: raw.replace(/\s+/g, ''), alt: String(alt || '') };
    }
    const proxy = /^(?:https?:\/\/[^/]+)?\/api\/storage\/file\/(.+)$/i.exec(raw);
    if (proxy) {
        let key;
        try { key = proxy[1].split('/').map(decodeURIComponent).join('/'); } catch { return { rejected: raw, alt: String(alt || '') }; }
        return key.split('/').includes('..') ? { rejected: raw, alt: String(alt || '') } : { storageKey: key.replace(/^\/+/, ''), alt: String(alt || '') };
    }
    if (/^users\/[^/]+\/[^/]+\/.+/.test(raw) && !raw.includes('..')) {
        return { storageKey: raw, alt: String(alt || '') };
    }
    return { rejected: raw, alt: String(alt || '') };
}

function inferLayout(slide) {
    if (slide.chart) return 'chart';
    if (slide.stats) return 'stats';
    if (slide.steps) return 'timeline';
    if (slide.table) return 'table';
    if (slide.image) return 'image';
    if (slide.quote) return 'quote';
    if (slide.columns) return 'two_column';
    if (slide.cards) return 'cards';
    if (!slide.bullets.length && !slide.body && slide.title) return 'section';
    return 'bullets';
}

module.exports = { SLIDE_LAYOUTS, MAX_CARDS, RE_ICON_TAG, DECK_LIMITS, DeckError, stripInlineMarkdown, clampText, classifyImageRef, inferLayout };
