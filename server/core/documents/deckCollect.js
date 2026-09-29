// @typecheck
/**
 * Deck collector — turn WHATEVER a routine or app bound to `slides` into the
 * input normalizeDeck understands.
 *
 * The `presentation` step promises one parameter that takes anything sensible:
 *
 *   - the markdown an ai_step wrote           → a markdown deck
 *   - a JSON deck (as an object or a string)  → that deck
 *   - a list of slide objects                 → those slides
 *   - a list of references to `slide` steps   → their `{ slide }` outputs
 *   - a loop / forEach output                 → `{ results:[{ output }] }`, unwrapped
 *   - a datatable's rows                      → one slide per row (title/content columns)
 *   - nested lists of any of the above        → flattened
 *
 * That flexibility lives HERE, in one pure function with a test per shape,
 * rather than in the executor — so the App Studio step and the routine step
 * accept exactly the same inputs and a shape that works in one works in both.
 */

const { normalizeDeck } = require('./deckModel');

// A hard stop on the flattening, not on the deck (normalizeDeck has its own
// slide cap). This one exists so a binding to a 50 000-row table cannot make
// the collector allocate 50 000 slide objects before the deck cap fires.
const MAX_COLLECTED_SLIDES = 200;

class DeckCollectError extends Error {
    constructor(message, errorClass) {
        super(message);
        this.name = 'DeckCollectError';
        this.errorClass = errorClass;
    }
}

function emptyDeckError() {
    return new DeckCollectError('There are no slides to put in the presentation.', 'presentation_empty');
}

/** True for a string that reads as a markdown outline (a heading somewhere in it). */
function looksLikeMarkdownDeck(s) {
    return /(^|\n)\s*#{1,2}\s+\S/.test(s);
}

/** Parse a JSON-looking string; null when it is not one. */
function parseJsonMaybe(s) {
    const t = s.trim();
    if (!(t.startsWith('[') || t.startsWith('{'))) return null;
    try { return JSON.parse(t); } catch { return null; }
}

function isSlideLike(o) {
    return o && typeof o === 'object' && !Array.isArray(o)
        && ['title', 'heading', 'content', 'text', 'markdown', 'bullets', 'points', 'body', 'table', 'quote', 'image', 'columns', 'notes', 'chart', 'stats', 'steps']
            .some((k) => Object.prototype.hasOwnProperty.call(o, k));
}

/**
 * Flatten one item into slide objects (or markdown-derived slides), appending
 * to `out`. Returns nothing; throws past the collection cap.
 */
function flattenInto(item, out, warnings, depth = 0) {
    if (out.length > MAX_COLLECTED_SLIDES) {
        throw new DeckCollectError(`More than ${MAX_COLLECTED_SLIDES} slides were collected; a presentation cannot be that long.`, 'presentation_too_many_slides');
    }
    if (item === null || item === undefined || depth > 8) return;

    if (Array.isArray(item)) {
        for (const x of item) flattenInto(x, out, warnings, depth + 1);
        return;
    }
    if (typeof item === 'string') {
        const s = item.trim();
        if (!s) return;
        const parsed = parseJsonMaybe(s);
        if (parsed !== null) { flattenInto(parsed, out, warnings, depth + 1); return; }
        if (looksLikeMarkdownDeck(s)) {
            const deck = normalizeDeck(s);
            for (const w of deck.warnings) warnings.push(w);
            for (const slide of deck.slides) out.push(slide);
            return;
        }
        out.push({ title: '', content: s });
        return;
    }
    if (typeof item !== 'object') return; // a number, a boolean: not a slide

    // A loop / forEach output, or one of its result rows.
    if (Array.isArray(item.results) && !isSlideLike(item)) {
        for (const r of item.results) flattenInto(r && typeof r === 'object' && 'output' in r ? r.output : r, out, warnings, depth + 1);
        return;
    }
    if (item.output !== undefined && !isSlideLike(item) && Object.keys(item).every((k) => ['index', 'item', 'output', 'status', 'error'].includes(k))) {
        flattenInto(item.output, out, warnings, depth + 1);
        return;
    }
    // A `slide` step's output.
    if (item.slide && typeof item.slide === 'object' && !isSlideLike(item)) {
        flattenInto(item.slide, out, warnings, depth + 1);
        return;
    }
    // A whole deck.
    if (Array.isArray(item.slides)) {
        for (const s of item.slides) flattenInto(s, out, warnings, depth + 1);
        return;
    }
    // A deck given as markdown in an object.
    if (typeof item.markdown === 'string' && !isSlideLike({ ...item, markdown: undefined })) {
        flattenInto(item.markdown, out, warnings, depth + 1);
        return;
    }
    // An ai_step output: { text } (or { content }) holding the outline.
    if (typeof item.text === 'string' && looksLikeMarkdownDeck(item.text) && !item.title && !item.bullets) {
        flattenInto(item.text, out, warnings, depth + 1);
        return;
    }
    if (isSlideLike(item)) { out.push(item); return; }
    // A datatable row without recognisable columns: use its first two string
    // fields as title + content so a plain table still yields something.
    const strings = Object.entries(item).filter(([, v]) => typeof v === 'string' && v.trim());
    if (strings.length) {
        out.push({ title: strings[0][1], content: strings.slice(1).map(([k, v]) => `- ${k}: ${v}`).join('\n') });
        return;
    }
    warnings.push('an item bound to slides had no title or content and was skipped');
}

/**
 * @param {*} input           whatever `slides` resolved to
 * @param {{title?:string, subtitle?:string}} [meta]  the step's own title/subtitle (win over a deck's)
 * @returns {{ deckInput: object|string, warnings: string[] }}  feed `deckInput` to normalizeDeck
 */
function collectDeck(input, { title = '', subtitle = '' } = {}) {
    const warnings = [];
    const t = String(title ?? '').trim();
    const st = String(subtitle ?? '').trim();

    // An ai_step's `{ text }`, a `{ markdown }` wrapper or a results row: peel
    // it so the string underneath gets the markdown treatment (cover title
    // included) instead of being flattened into headingless slides.
    for (let guard = 0; guard < 4 && input && typeof input === 'object' && !Array.isArray(input) && !Array.isArray(input.slides) && !Array.isArray(input.results); guard += 1) {
        const inner = ['markdown', 'text', 'content', 'output'].map((k) => input[k]).find((v) => v !== undefined && v !== null);
        if (inner === undefined || Object.keys(input).some((k) => ['title', 'bullets', 'points', 'table', 'quote', 'image', 'columns', 'slide'].includes(k))) break;
        input = inner;
    }

    // Plain markdown: keep it as markdown so the cover/intro rules apply.
    if (typeof input === 'string') {
        const s = input.trim();
        if (!s) throw emptyDeckError();
        const parsed = parseJsonMaybe(s);
        if (parsed === null) {
            if (looksLikeMarkdownDeck(s)) {
                return { deckInput: { title: t || undefined, subtitle: st || undefined, markdown: s }, warnings };
            }
            // Prose without headings: one slide holding it, under the step's title.
            return { deckInput: { title: t, subtitle: st || undefined, slides: [{ title: t, content: s }] }, warnings };
        }
        input = parsed;
    }

    // A deck object: honour its own title/subtitle unless the step set them.
    if (input && typeof input === 'object' && !Array.isArray(input) && Array.isArray(input.slides) && !Array.isArray(input.results)) {
        const out = [];
        flattenInto(input.slides, out, warnings);
        if (!out.length) throw emptyDeckError();
        return {
            deckInput: {
                title: t || String(input.title ?? ''),
                subtitle: st || (input.subtitle ? String(input.subtitle) : undefined),
                author: input.author ? String(input.author) : undefined,
                slides: out,
            },
            warnings,
        };
    }

    const out = [];
    flattenInto(input, out, warnings);
    if (!out.length) throw emptyDeckError();
    return { deckInput: { title: t, subtitle: st || undefined, slides: out }, warnings };
}

module.exports = { collectDeck, emptyDeckError, DeckCollectError, MAX_COLLECTED_SLIDES, _test: { flattenInto, looksLikeMarkdownDeck } };
