// @typecheck
/**
 * Name occurrence sweep — once a person is found anywhere in a text, replace
 * them everywhere in it (BFSF-269, BFSF-300).
 *
 * The detector judges every mention on its own. In a long text it finds
 * "Pieter Koster" in the signature and misses the bare "Pieter" three
 * paragraphs up; in a contact table it finds the split first-name/surname
 * cells and misses the "Koster, Pieter" display name in the same row. Alias
 * coalescing then folds whatever WAS found onto one token per person, so the
 * token map only ever holds the long form, and the missed mentions (which
 * nothing later in the pipeline knows about) reach the provider as plaintext.
 *
 * The sweep closes that gap from what the detector already established: this
 * text, or this conversation, contains this person. Every uncovered,
 * word-bounded occurrence of a found value, and of each distinctive part of it
 * (first name, surname), becomes one more span of the same category. Those
 * spans go through the same alias index as the detected ones, so a part that
 * fits one person lands on that person's token, and a part that fits two
 * ("Tom" next to "Tom Smit" and "Tom Jansen") keeps a token of its own. The
 * ambiguity guard decides WHICH token a part gets, never WHETHER it is
 * replaced: skipping ambiguous parts would leak exactly those names.
 *
 * Conservative about what counts as a name part:
 *   - at least 3 characters and capitalised as written in the found value,
 *     matched case-sensitively, so the surname "Bakker" never touches the
 *     noun "bakker";
 *   - never a particle ("van", "de", "ter") and never a title or degree
 *     ("Prof", "MSc"): those identify nobody, and a token for one would
 *     rewrite every later "van" in the conversation on the way out;
 *   - a one-word needle at the start of a sentence is skipped when the same
 *     word also appears in lower case in the text: "Wil" of "Wil Bakker" in
 *     "Wil je bellen?" is the verb, not the person.
 * A value that crosses a line or a tab is not swept as a whole, because that
 * would build a span over several table cells (BFSF-299); its parts still are.
 */

const { PII_CATEGORIES } = require('./categories');

/**
 * @typedef {{ category: string, label: string, offset: number, length: number, text: string, swept: boolean }} SweptSpan
 */

/** Token category keys whose values are swept. */
const SWEPT_CATEGORY_KEYS = new Set(['person']);

/** Category a seed token's key stands for (`[person_3]` → Person). */
const _CATEGORY_OF_KEY = { person: 'Person' };

// Honorifics and degrees the detector often includes in a person span. Only
// words of 3+ characters matter: shorter ones are never a name part anyway.
const _TITLES = new Set([
    'mrs', 'miss', 'mister', 'madam', 'sir', 'dhr', 'heer', 'mevr', 'mevrouw', 'meneer',
    'mej', 'mejuffrouw', 'drs', 'ing', 'prof', 'msc', 'bsc', 'mba', 'phd', 'llm', 'llb',
]);

const _WORD_CHAR = /[\p{L}\p{M}\p{N}]/u;
const _PART_SPLIT = /[^\p{L}\p{M}\p{N}]+/u;
const _WORDS = /[\p{L}\p{M}\p{N}]+/gu;
const _SEED_TOKEN_RE = /^\[([a-z0-9_]+)_\d+\]$/;
// What may sit between a sentence break and the word that opens the sentence:
// whitespace, quotes, brackets and list bullets.
const _LEAD_IN = /[\s"'“”‘’‚„«»([{•*·–—-]/u;
const _SENTENCE_END = /[.!?…\n\r]/u;

function _isWordCodePoint(cp) {
    return cp !== undefined && _WORD_CHAR.test(String.fromCodePoint(cp));
}

/** Is the character that ends just before index `i` a letter/mark/digit? */
function _wordCharBefore(s, i) {
    if (i <= 0) return false;
    const unit = s.charCodeAt(i - 1);
    const isLowSurrogate = unit >= 0xdc00 && unit <= 0xdfff;
    return _isWordCodePoint(s.codePointAt(isLowSurrogate && i >= 2 ? i - 2 : i - 1));
}

/** Is the character that starts at index `i` a letter/mark/digit? */
function _wordCharAt(s, i) {
    return i < s.length && _isWordCodePoint(s.codePointAt(i));
}

function _isNameWord(word, particles) {
    const lower = word.toLowerCase();
    return word.length >= 3 && !particles.has(lower) && !_TITLES.has(lower);
}

/** Does a sentence (or a line) start at `at`? */
function _atSentenceStart(text, at) {
    let i = at - 1;
    // Both patterns are one character class tested against one character: constant time.
    while (i >= 0 && !_SENTENCE_END.test(text[i]) && _LEAD_IN.test(text[i])) i--; // nosemgrep: ajinabraham.njsscan.dos.regex_dos.regex_dos
    return i < 0 || _SENTENCE_END.test(text[i]); // nosemgrep: ajinabraham.njsscan.dos.regex_dos.regex_dos
}

/**
 * Find the occurrences of already-found names that no span covers yet.
 *
 * @param {object} args
 * @param {string} args.text  The text the spans index into.
 * @param {Array<{category?: string, label?: string, offset?: number, length?: number, text?: string}>} args.spans
 *   Detected spans, already disjoint (`resolveSpanOverlaps`).
 * @param {Array<[string, unknown]>} [args.seedEntries]  `[token, value]` pairs of the
 *   conversation map / vault seed: a name found in an earlier turn is swept too.
 * @param {(span: object) => string} args.categoryKeyOf  Span → token category key.
 * @param {Set<string>} args.particles  Lower-case words that carry no identity.
 * @param {Array<{offset?: number, length?: number}>} [args.reserved]  Ranges the
 *   caller handles itself after tokenizing (a blocked tool-result value is
 *   replaced by literal match): never swept, and not a source of names.
 * @returns {SweptSpan[]} New spans, disjoint from `spans`, from `reserved` and
 *   from each other, in no particular order.
 */
function sweepNameOccurrences({ text, spans, seedEntries = [], categoryKeyOf, particles, reserved = [] }) {
    if (typeof text !== 'string' || !text) return [];

    /** @type {Map<string, {category: string, label: string, oneWord: boolean}>} */
    const needles = new Map();
    const addValue = (value, category, label) => {
        // Every regex that reads `v` below is linear: the split's pattern is one
        // class repeated with nothing after it, the tests are one class each.
        const v = String(value || '').trim(); // nosemgrep: ajinabraham.njsscan.dos.regex_dos.regex_dos
        if (!v) return;
        const parts = v.split(_PART_SPLIT).filter(Boolean);
        // A value with no distinctive word ("van der") names nobody.
        if (!parts.some(p => _isNameWord(p, particles))) return;
        const add = (needle, oneWord) => {
            // A one-word needle must be written capitalised: a lower-case
            // "wil" the detector called a name is not evidence for every "wil".
            // (Anchored, one character class: constant time.)
            if (oneWord && !/^\p{Lu}/u.test(needle)) return; // nosemgrep: ajinabraham.njsscan.dos.regex_dos.regex_dos
            if (!needles.has(needle)) needles.set(needle, { category, label, oneWord });
        };
        if (!/[\n\r\t]/.test(v)) add(v, !/\s/.test(v));
        for (const p of parts) if (_isNameWord(p, particles)) add(p, true);
    };

    const covered = new Uint8Array(text.length);
    /** @param {{offset?: number, length?: number}} s */
    const isInRange = (s) => Number.isFinite(s.offset) && s.offset >= 0
        && Number.isFinite(s.length) && s.length > 0
        && s.offset + s.length <= text.length;
    for (const r of reserved || []) if (isInRange(r)) covered.fill(1, r.offset, r.offset + r.length);
    for (const s of spans || []) {
        const key = categoryKeyOf(s);
        const inRange = isInRange(s);
        if (inRange) covered.fill(1, s.offset, s.offset + s.length);
        if (!SWEPT_CATEGORY_KEYS.has(key)) continue;
        const value = inRange ? text.slice(s.offset, s.offset + s.length) : s.text;
        addValue(value, s.category, s.label || s.category);
    }
    for (const [token, value] of seedEntries) {
        const m = _SEED_TOKEN_RE.exec(token);
        if (!m || !SWEPT_CATEGORY_KEYS.has(m[1]) || typeof value !== 'string') continue;
        const category = _CATEGORY_OF_KEY[m[1]];
        addValue(value, category, PII_CATEGORIES[category]?.label || category);
    }
    if (needles.size === 0) return [];

    /** @type {Set<string>|null} */
    let lowerCaseWords = null;
    const usedInLowerCase = (word) => {
        if (!lowerCaseWords) {
            lowerCaseWords = new Set();
            for (const m of text.matchAll(_WORDS)) {
                if (m[0] === m[0].toLowerCase()) lowerCaseWords.add(m[0]);
            }
        }
        return lowerCaseWords.has(word.toLowerCase());
    };

    /** @type {SweptSpan[]} */
    const out = [];
    // Longest first, so a full name claims its occurrence before its parts
    // would cut it into one token per word.
    const ordered = [...needles.entries()].sort((a, b) => b[0].length - a[0].length);
    for (const [needle, meta] of ordered) {
        const boundedStart = _wordCharAt(needle, 0);
        const boundedEnd = _wordCharBefore(needle, needle.length);
        for (let at = text.indexOf(needle); at !== -1; at = text.indexOf(needle, at + 1)) {
            const end = at + needle.length;
            if (boundedStart && _wordCharBefore(text, at)) continue;
            if (boundedEnd && _wordCharAt(text, end)) continue;
            if (covered.subarray(at, end).includes(1)) continue;
            if (meta.oneWord && _atSentenceStart(text, at) && usedInLowerCase(needle)) continue;
            covered.fill(1, at, end);
            out.push({ category: meta.category, label: meta.label, offset: at, length: needle.length, text: needle, swept: true });
        }
    }
    return out;
}

module.exports = { sweepNameOccurrences };
